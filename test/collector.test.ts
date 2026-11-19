import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBigSpender } from '../src/server/index.ts';
import { usageSnapshotSchema } from '../src/schema.ts';
import { createHttpServer } from '../src/serve.ts';
import { run, seedPricing, withSandbox } from './helpers.ts';

const COLLECTOR = fileURLToPath(new URL('../src/collector.mjs', import.meta.url));

test('the device id is read from the new name, then the legacy one', async () => {
	await withSandbox(async ({ env }) => {
		await seedPricing(join(env.XDG_CACHE_HOME, 'big-spender'));
		const deviceOf = async (extra: Record<string, string>) => {
			const res = await run(COLLECTOR, ['--dry-run'], { ...env, ...extra });
			assert.equal(res.code, 0, res.stderr);
			return JSON.parse(res.stdout).deviceId;
		};

		assert.equal(await deviceOf({ USAGE_DEVICE_ID: 'legacy' }), 'legacy');
		assert.equal(await deviceOf({ BIG_SPENDER_DEVICE_ID: 'fresh' }), 'fresh');
		assert.equal(
			await deviceOf({ BIG_SPENDER_DEVICE_ID: 'fresh', USAGE_DEVICE_ID: 'legacy' }),
			'fresh'
		);
		assert.equal(
			await deviceOf({ BIG_SPENDER_DEVICE_ID: '', USAGE_DEVICE_ID: 'legacy' }),
			'legacy'
		);
		assert.ok(existsSync(join(env.XDG_CACHE_HOME, 'big-spender', 'state.json')));
		assert.ok(!existsSync(join(env.XDG_CACHE_HOME, 'usage-collector')));
	});
});

test('a legacy env file still posts to a server', async () => {
	await withSandbox(async ({ env }) => {
		await seedPricing(join(env.XDG_CACHE_HOME, 'big-spender'));
		const dataDir = join(env.HOME, 'data');
		const bs = createBigSpender({ dataDir, ingestToken: 'tok', devices: { devices: {} } });
		const server = createHttpServer(bs);
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		try {
			const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/usage/ingest`;
			const configDir = join(env.XDG_CONFIG_HOME, 'big-spender');
			await mkdir(configDir, { recursive: true });
			const envFile = (prefix: string) =>
				[
					`${prefix}_DEVICE_ID=laptop`,
					`${prefix}_INGEST_URL=${url}`,
					`${prefix}_INGEST_TOKEN='tok'`,
					''
				].join('\n');

			for (const prefix of ['USAGE', 'BIG_SPENDER']) {
				await writeFile(join(configDir, 'env'), envFile(prefix), { mode: 0o600 });
				const res = await run(COLLECTOR, [], env);
				assert.equal(res.code, 0, res.stderr);
				assert.match(res.stderr, /posted 0 rows/);
				const stored = JSON.parse(await readFile(join(dataDir, 'laptop.json'), 'utf8'));
				assert.equal(stored.deviceId, 'laptop');
			}

			await writeFile(join(configDir, 'env'), envFile('BIG_SPENDER').replace(`'tok'`, 'wrong'));
			const refused = await run(COLLECTOR, [], env);
			assert.equal(refused.code, 1);
			assert.match(refused.stderr, /HTTP 401/);
			assert.doesNotMatch(refused.stderr, /wrong/);
		} finally {
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		}
	});
});

test('a real device id is required to post', async () => {
	await withSandbox(async ({ env }) => {
		await seedPricing(join(env.XDG_CACHE_HOME, 'big-spender'));
		const res = await run(COLLECTOR, [], env);
		assert.equal(res.code, 1);
		assert.match(res.stderr, /BIG_SPENDER_DEVICE_ID must be a lowercase slug/);
	});
});

test('a token that cannot go in an HTTP header fails at once and is never printed', async () => {
	await withSandbox(async ({ env }) => {
		await seedPricing(join(env.XDG_CACHE_HOME, 'big-spender'));
		const dataDir = join(env.HOME, 'data');
		const bs = createBigSpender({ dataDir, ingestToken: 'tok', devices: { devices: {} } });
		const server = createHttpServer(bs);
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		try {
			const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/usage/ingest`;
			const configDir = join(env.XDG_CONFIG_HOME, 'big-spender');
			await mkdir(configDir, { recursive: true });
			const base = { ...env, BIG_SPENDER_DEVICE_ID: 'laptop', BIG_SPENDER_INGEST_URL: url };

			await writeFile(join(configDir, 'env'), 'BIG_SPENDER_INGEST_TOKEN=sekrit-1\x01sekrit-2\n', {
				mode: 0o600
			});
			const fromFile = await run(COLLECTOR, [], base);
			const fromEnv = await run(COLLECTOR, [], {
				...base,
				BIG_SPENDER_INGEST_TOKEN: 'sekrit-1\rsekrit-2'
			});
			for (const res of [fromEnv, fromFile]) {
				assert.equal(res.code, 1);
				const printed = res.stdout + res.stderr;
				assert.doesNotMatch(printed, /sekrit/);
				assert.doesNotMatch(printed, /retrying/);
				assert.match(printed, /not allowed in an HTTP header/);
			}
			assert.equal(existsSync(join(dataDir, 'laptop.json')), false);

			// fetch used to trim surrounding whitespace, so a token exported with a newline worked.
			const padded = await run(COLLECTOR, [], { ...base, BIG_SPENDER_INGEST_TOKEN: ' tok\n' });
			assert.equal(padded.code, 0, padded.stderr);
			assert.equal(existsSync(join(dataDir, 'laptop.json')), true);
		} finally {
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		}
	});
});

const HOUR_MS = 3_600_000;

async function writeClaudeMessage(home: string, ts: number, outputs: number[]) {
	const dir = join(home, '.claude', 'projects', 'p');
	await mkdir(dir, { recursive: true });
	const path = join(dir, 'session.jsonl');
	const lines = outputs.map((output) => ({
		type: 'assistant',
		timestamp: new Date(ts).toISOString(),
		requestId: 'req-1',
		sessionId: 'session-1',
		message: {
			id: 'msg-1',
			model: 'claude-test',
			usage: { input_tokens: 1000, output_tokens: output }
		}
	}));
	await writeFile(path, lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
	return path;
}

test('state from before the output fix re-reads the Claude logs once and adds the missed output', async () => {
	await withSandbox(async ({ env, home }) => {
		const cache = join(env.XDG_CACHE_HOME, 'big-spender');
		await seedPricing(cache);
		const ts = Math.floor(Date.now() / HOUR_MS) * HOUR_MS - HOUR_MS;
		const path = await writeClaudeMessage(home, ts, [10, 500]);
		const st = await stat(path);
		const dedupe = `c:${createHash('sha256').update('msg-1:req-1').digest('base64url').slice(0, 16)}`;
		await writeFile(
			join(cache, 'state.json'),
			JSON.stringify({
				version: 1,
				files: { [path]: { size: st.size, mtimeMs: st.mtimeMs, offset: st.size } },
				seen: { [dedupe]: ts },
				buckets: {
					[`${ts}|claude|claude-test|0`]: {
						input: 1000,
						cacheRead: 0,
						cacheWrite5m: 0,
						cacheWrite1h: 0,
						output: 10,
						sessions: ['s']
					}
				}
			})
		);

		for (const pass of ['fixing run', 'next run']) {
			const res = await run(COLLECTOR, ['--dry-run'], env);
			assert.equal(res.code, 0, res.stderr);
			const [row] = JSON.parse(res.stdout).hourly;
			assert.deepEqual([row.inputTokens, row.outputTokens], [1000, 500], pass);
		}
	});
});

test('a device that used only Claude sends claude and codex session counts and no others', async () => {
	await withSandbox(async ({ env, home }) => {
		await seedPricing(join(env.XDG_CACHE_HOME, 'big-spender'));
		await writeClaudeMessage(home, Date.now() - HOUR_MS, [500]);
		const res = await run(COLLECTOR, ['--dry-run'], { ...env, BIG_SPENDER_DEVICE_ID: 'laptop' });
		assert.equal(res.code, 0, res.stderr);
		const snapshot = usageSnapshotSchema.parse(JSON.parse(res.stdout));
		assert.deepEqual(snapshot.sessionCounts?.['7d'], { claude: 1, codex: 0, all: 1 });
	});
});

test('a file that a default path and an override both reach goes to the provider it is a default of', async () => {
	await withSandbox(async ({ env, home }) => {
		await seedPricing(join(env.XDG_CACHE_HOME, 'big-spender'));
		// $CLAUDE_CONFIG_DIR/projects is HOME, so it also reaches HOME/.codex/sessions.
		const projects = join(home, 'projects');
		const dir = join(projects, '.codex', 'sessions', '2026', '11', '19');
		await mkdir(dir, { recursive: true });
		const ts = new Date(Date.now() - HOUR_MS).toISOString();
		const lines = [
			{ timestamp: ts, type: 'session_meta', payload: { id: 'codex-session' } },
			{ timestamp: ts, type: 'turn_context', payload: { model: 'gpt-test' } },
			{
				timestamp: ts,
				type: 'event_msg',
				payload: {
					type: 'token_count',
					info: {
						total_token_usage: { total_tokens: 250 },
						last_token_usage: { input_tokens: 200, cached_input_tokens: 0, output_tokens: 50 }
					}
				}
			}
		];
		await writeFile(
			join(dir, 'rollout-2026-11-19T00-00-00-00000000-0000-0000-0000-000000000001.jsonl'),
			lines.map((l) => `${JSON.stringify(l)}\n`).join('')
		);
		const res = await run(COLLECTOR, ['--dry-run'], {
			...env,
			HOME: projects,
			CLAUDE_CONFIG_DIR: home
		});
		assert.equal(res.code, 0, res.stderr);
		const rows = JSON.parse(res.stdout).hourly.map((r: { provider: string; model: string }) => [
			r.provider,
			r.model
		]);
		assert.deepEqual(rows, [['codex', 'gpt-test']]);
	});
});
