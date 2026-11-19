import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { usageSnapshotSchema } from '../src/schema.ts';
import { run, withSandbox } from './helpers.ts';

const COLLECTOR = fileURLToPath(new URL('../src/collector.mjs', import.meta.url));
const HOUR_MS = 3_600_000;
const HOUR = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
const at = (hoursAgo: number) => new Date(HOUR - hoursAgo * HOUR_MS + 60_000).toISOString();

type Usage = Partial<Record<string, number | string>>;
const event = (type: string, id: string, timestamp: string, data: object) =>
	JSON.stringify({ type, id, timestamp, data }) + '\n';
const call = (id: string, hoursAgo: number, usage: Usage) =>
	event('session.usage_record', id, at(hoursAgo), { usage: { model: 'gpt-5.2', ...usage } });
const shutdown = (id: string, hoursAgo: number, models: Record<string, Usage>, requests = 1) =>
	event('session.shutdown', id, at(hoursAgo), {
		modelMetrics: Object.fromEntries(
			Object.entries(models).map(([m, usage]) => [m, { requests: { count: requests }, usage }])
		)
	});

const PRICES = {
	'gpt-5.2': {
		input_cost_per_token: 1e-6,
		output_cost_per_token: 1e-5,
		cache_read_input_token_cost: 1e-7,
		input_cost_per_token_above_272k_tokens: 2e-6
	}
};

async function sessionFile(root: string, session: string, text: string, append = false) {
	const dir = join(root, 'session-state', session);
	await mkdir(dir, { recursive: true });
	const path = join(dir, 'events.jsonl');
	await (append ? appendFile(path, text) : writeFile(path, text));
	return dir;
}

async function collect(env: Record<string, string>) {
	const res = await run(COLLECTOR, ['--dry-run'], { ...env, BIG_SPENDER_DEVICE_ID: 'laptop' });
	assert.equal(res.code, 0, res.stderr);
	return { raw: res.stdout, snapshot: usageSnapshotSchema.parse(JSON.parse(res.stdout)) };
}

async function box(fn: (b: { env: Record<string, string>; root: string }) => Promise<void>) {
	await withSandbox(async ({ env, home }) => {
		const cache = join(env.XDG_CACHE_HOME, 'big-spender');
		await mkdir(cache, { recursive: true });
		await writeFile(
			join(cache, 'litellm-prices.json'),
			JSON.stringify({ fetchedAt: Date.now(), models: PRICES })
		);
		await fn({ env, root: join(home, '.copilot') });
	});
}

const tokens = (rows: { inputTokens: number; cacheReadTokens: number; outputTokens: number }[]) =>
	rows.map((r) => [r.inputTokens, r.cacheReadTokens, r.outputTokens]);

test('per-call records count uncached input per hour and are priced', async () => {
	await box(async ({ env, root }) => {
		await sessionFile(
			root,
			'sess-a',
			call('1', 2, {
				inputTokens: 1000,
				cacheReadTokens: 600,
				cacheWriteTokens: 100,
				outputTokens: 50
			}) +
				call('2', 2, { inputTokens: 500, outputTokens: 20, reasoningTokens: 10 }) +
				call('3', 1, { inputTokens: 100, outputTokens: 5 })
		);
		const { snapshot } = await collect(env);
		const rows = snapshot.hourly.filter((r) => r.provider === 'copilot');
		assert.deepEqual(tokens(rows), [
			[800, 600, 70],
			[100, 0, 5]
		]);
		assert.equal(rows[0].cacheWrite5mTokens, 100);
		assert.ok(Math.abs(rows[0].costUsd.input - 800e-6) < 1e-9);
		assert.ok(Math.abs(rows[0].costUsd.cacheRead - 60e-6) < 1e-9);
		assert.ok(Math.abs(rows[0].costUsd.output - 700e-6) < 1e-9);
	});
});

test('a shutdown beside per-call records adds nothing', async () => {
	await box(async ({ env, root }) => {
		await sessionFile(
			root,
			'sess-a',
			call('1', 2, { inputTokens: 1000, outputTokens: 50 }) +
				shutdown('s1', 2, { 'gpt-5.2': { inputTokens: 1000, outputTokens: 50 } })
		);
		const { snapshot } = await collect(env);
		assert.deepEqual(tokens(snapshot.hourly), [[1000, 0, 50]]);
	});
});

test('shutdown-only files count each resume as the growth since the last shutdown of that model', async () => {
	await box(async ({ env, root }) => {
		await sessionFile(
			root,
			'sess-a',
			shutdown('s1', 3, {
				'gpt-5.2': { inputTokens: 1000, cacheReadTokens: 400, outputTokens: 100 }
			}) +
				shutdown('s2', 1, {
					'gpt-5.2-1m': { inputTokens: 1500, cacheReadTokens: 900, outputTokens: 160 }
				})
		);
		const { snapshot } = await collect(env);
		assert.deepEqual(tokens(snapshot.hourly), [
			[600, 400, 100],
			[0, 500, 60]
		]);
		const total = snapshot.hourly.reduce((n, r) => n + r.inputTokens + r.cacheReadTokens, 0);
		assert.equal(total, 1500);
	});
});

test('one shutdown that logs a model with and without its -1m suffix counts both', async () => {
	await box(async ({ env, root }) => {
		await sessionFile(
			root,
			'sess-a',
			shutdown('s1', 2, { 'gpt-5.2': { inputTokens: 100 }, 'gpt-5.2-1m': { inputTokens: 40 } })
		);
		const { snapshot } = await collect(env);
		assert.deepEqual(tokens(snapshot.hourly), [[140, 0, 0]]);
	});
});

test('a shutdown interval reaches a long-context tier only when it holds one request', async () => {
	await box(async ({ env, root }) => {
		await sessionFile(root, 'sess-one', shutdown('s1', 2, { 'gpt-5.2': { inputTokens: 300_000 } }));
		await sessionFile(
			root,
			'sess-two',
			shutdown('s1', 1, { 'gpt-5.2': { inputTokens: 300_000 } }, 2)
		);
		const { snapshot } = await collect(env);
		assert.deepEqual(
			snapshot.hourly.map((r) => Math.round(r.costUsd.input * 100) / 100),
			[0.6, 0.3]
		);
	});
});

test('a repeated event id counts once', async () => {
	await box(async ({ env, root }) => {
		const line = call('1', 2, { inputTokens: 100, outputTokens: 5 });
		await sessionFile(root, 'sess-a', line + line);
		const { snapshot } = await collect(env);
		assert.deepEqual(tokens(snapshot.hourly), [[100, 0, 5]]);
	});
});

test('a second run reads nothing and an appended record adds only itself', async () => {
	await box(async ({ env, root }) => {
		await sessionFile(root, 'sess-a', call('1', 2, { inputTokens: 100, outputTokens: 5 }));
		const first = await collect(env);
		const again = await collect(env);
		assert.deepEqual(again.snapshot.hourly, first.snapshot.hourly);

		await sessionFile(root, 'sess-a', call('2', 2, { inputTokens: 40, outputTokens: 2 }), true);
		const grown = await collect(env);
		assert.deepEqual(tokens(grown.snapshot.hourly), [[140, 0, 7]]);
	});
});

test('jsonl files below the session folder are ignored', async () => {
	await box(async ({ env, root }) => {
		const dir = await sessionFile(
			root,
			'sess-a',
			call('1', 2, { inputTokens: 100, outputTokens: 5 })
		);
		const stray = call('9', 2, { inputTokens: 999, outputTokens: 99 });
		await mkdir(join(dir, 'files', 'nested'), { recursive: true });
		await writeFile(join(dir, 'files', 'events.jsonl'), stray);
		await writeFile(join(dir, 'files', 'nested', 'events.jsonl'), stray);
		await writeFile(join(dir, 'research.jsonl'), stray);
		await writeFile(join(root, 'session-state', 'loose.jsonl'), stray);
		const { snapshot } = await collect(env);
		assert.deepEqual(tokens(snapshot.hourly), [[100, 0, 5]]);
	});
});

test('COPILOT_HOME is read as well as ~/.copilot', async () => {
	await box(async ({ env, root }) => {
		await sessionFile(root, 'sess-home', call('1', 2, { inputTokens: 100, outputTokens: 5 }));
		const elsewhere = join(env.HOME, 'elsewhere');
		await sessionFile(elsewhere, 'sess-moved', call('1', 2, { inputTokens: 7, outputTokens: 1 }));
		const { snapshot } = await collect({ ...env, COPILOT_HOME: elsewhere });
		assert.deepEqual(tokens(snapshot.hourly), [[107, 0, 6]]);
	});
});

test('the snapshot carries no session name, path or prompt text', async () => {
	await box(async ({ env, root }) => {
		const secret = 'tell-me-the-launch-codes';
		await sessionFile(
			root,
			'sess-private-name',
			event('user.message', 'u1', at(2), { content: secret }) +
				call('1', 2, { inputTokens: 100, outputTokens: 5 }) +
				event('session.shutdown', 's1', at(1), {
					modelMetrics: { 'gpt-5.2': { usage: { inputTokens: 1 } } },
					note: secret,
					cwd: '/home/someone/project'
				})
		);
		const { raw } = await collect(env);
		for (const text of [
			'sess-private-name',
			secret,
			'/home/someone',
			'session-state',
			'events.jsonl'
		]) {
			assert.ok(!raw.includes(text), `${text} leaked`);
		}
	});
});

test('a -1m model suffix is stripped and the session count includes copilot', async () => {
	await box(async ({ env, root }) => {
		await sessionFile(
			root,
			'sess-a',
			call('1', 2, { model: 'gpt-5.2-1m-internal', inputTokens: 100, outputTokens: 5 })
		);
		await sessionFile(root, 'sess-b', call('1', 2, { inputTokens: 10, outputTokens: 1 }));
		const { snapshot } = await collect(env);
		assert.deepEqual(
			snapshot.hourly.map((r) => r.model),
			['gpt-5.2']
		);
		assert.deepEqual(snapshot.sessionCounts?.['7d'], { claude: 0, codex: 0, copilot: 2, all: 2 });
	});
});

test('a bring-your-own-key resource id or gateway path is cut to its last segment', async () => {
	await box(async ({ env, root }) => {
		await sessionFile(
			root,
			'sess-a',
			call('1', 2, {
				model: 'arn:aws:bedrock:us-east-1:123456789012:inference-profile/private-model',
				inputTokens: 10
			}) +
				call('2', 2, { model: 'gateway/private-tenant/other-model', inputTokens: 10 }) +
				call('3', 2, {
					model: 'arn:aws:bedrock:us-east-1:123456789012:bare-model',
					inputTokens: 10
				}) +
				call('4', 2, {
					model: 'https://gateway.example/v1/models/url-model?account_id=123456789012#x',
					inputTokens: 10
				})
		);
		const { raw, snapshot } = await collect(env);
		assert.deepEqual(snapshot.hourly.map((r) => r.model).sort(), [
			'bare-model',
			'other-model',
			'private-model',
			'url-model'
		]);
		for (const text of ['123456789012', 'private-tenant', 'arn:', 'account_id', 'gateway']) {
			assert.ok(!raw.includes(text), `${text} leaked`);
		}
	});
});
