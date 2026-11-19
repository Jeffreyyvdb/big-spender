import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { usageSnapshotSchema, type UsageSnapshot } from '../src/schema.ts';
import { run, withSandbox } from './helpers.ts';
import { SECRETS, writePiHome } from './fixtures/pi-home.ts';

const COLLECTOR = fileURLToPath(new URL('../src/collector.mjs', import.meta.url));

const PRICES = {
	'fireworks_ai/accounts/fireworks/models/deepseek-v4-flash': {
		input_cost_per_token: 3e-7,
		output_cost_per_token: 1.2e-6
	},
	'claude-sonnet-4-5': {
		input_cost_per_token: 3e-6,
		output_cost_per_token: 15e-6,
		cache_read_input_token_cost: 3e-7,
		cache_creation_input_token_cost: 3.75e-6
	},
	'gpt-5': {
		input_cost_per_token: 1.25e-6,
		output_cost_per_token: 1e-5,
		cache_read_input_token_cost: 1.25e-7
	}
};

type Day = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };

function byDayAndModel(snapshot: UsageSnapshot): Record<string, Day> {
	const out: Record<string, Day> = {};
	for (const r of snapshot.hourly) {
		assert.equal(r.provider, 'pi');
		const d = (out[`${r.hour.slice(0, 10)} ${r.model}`] ??= {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0
		});
		d.input += r.inputTokens;
		d.output += r.outputTokens;
		d.cacheRead += r.cacheReadTokens;
		d.cacheWrite += r.cacheWrite5mTokens + r.cacheWrite1hTokens;
		d.cost += r.costUsd.input + r.costUsd.cacheRead + r.costUsd.cacheWrite + r.costUsd.output;
	}
	return out;
}

// The collector rounds each hour's cost parts to $0.000001, so a day's sum can be off by a few.
const COST_TOLERANCE_USD = 1e-5;

function assertUsage(actual: Record<string, Day>, expected: Record<string, Day>) {
	assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort());
	for (const [key, { cost: expectedCost, ...expectedTokens }] of Object.entries(expected)) {
		const { cost, ...tokens } = actual[key];
		assert.deepEqual(tokens, expectedTokens, key);
		assert.ok(
			Math.abs(cost - expectedCost) < COST_TOLERANCE_USD,
			`${key}: cost ${cost} vs ${expectedCost}`
		);
	}
}

async function piSandbox(
	fn: (box: {
		env: Record<string, string>;
		home: string;
		sessions: string;
		files: Record<string, string>;
		collect: (...args: string[]) => Promise<{ snapshot: UsageSnapshot; stdout: string }>;
	}) => Promise<void>
) {
	await withSandbox(async ({ env, home }) => {
		const cache = join(env.XDG_CACHE_HOME, 'big-spender');
		await mkdir(cache, { recursive: true });
		await writeFile(
			join(cache, 'litellm-prices.json'),
			JSON.stringify({ fetchedAt: Date.now(), models: PRICES })
		);
		const { sessions, files } = writePiHome(home, NOW);
		const collect = async (...args: string[]) => {
			const res = await run(COLLECTOR, ['--dry-run', ...args], {
				...env,
				BIG_SPENDER_DEVICE_ID: 'laptop'
			});
			assert.equal(res.code, 0, res.stderr);
			return { snapshot: usageSnapshotSchema.parse(JSON.parse(res.stdout)), stdout: res.stdout };
		};
		await fn({ env, home, sessions, files, collect });
	});
}

const jsonl = (lines: object[]) => lines.map((l) => `${JSON.stringify(l)}\n`).join('');

const DAY_MS = 86_400_000;
const NOW = Date.now();
const day = (n: number) =>
	new Date(Math.floor(NOW / DAY_MS) * DAY_MS + (n - 4) * DAY_MS).toISOString().slice(0, 10);

test('pi sessions count every call once: forks, transcripts and repeats are not counted twice', async () => {
	await piSandbox(async ({ collect }) => {
		const { snapshot } = await collect();
		assertUsage(byDayAndModel(snapshot), {
			[`${day(0)} claude-sonnet-4-5`]: {
				input: 1512,
				output: 2980,
				cacheRead: 25050,
				cacheWrite: 18050,
				cost: 0.1244385
			},
			[`${day(1)} claude-sonnet-4-5`]: {
				input: 2217,
				output: 1610,
				cacheRead: 41550,
				cacheWrite: 5400,
				cost: 0.065766
			},
			[`${day(2)} claude-sonnet-4-5`]: {
				input: 22,
				output: 520,
				cacheRead: 5000,
				cacheWrite: 5400,
				cost: 0.029616
			},
			[`${day(2)} gpt-5`]: {
				input: 6200,
				output: 3740,
				cacheRead: 5120,
				cacheWrite: 0,
				cost: 0.04579
			},
			[`${day(2)} anthropic/claude-sonnet-4.5`]: {
				input: 40,
				output: 380,
				cacheRead: 0,
				cacheWrite: 7600,
				cost: 0.03432
			},
			[`${day(2)} qwen3:32b`]: { input: 9000, output: 700, cacheRead: 0, cacheWrite: 0, cost: 0 },
			[`${day(3)} claude-sonnet-4-5`]: {
				input: 30,
				output: 410,
				cacheRead: 0,
				cacheWrite: 6100,
				cost: 0.029115
			},
			[`${day(3)} gpt-5`]: { input: 0, output: 333, cacheRead: 0, cacheWrite: 0, cost: 0.00333 }
		});
		assert.equal(
			snapshot.hourly.reduce((n, r) => n + r.cacheWrite1hTokens, 0),
			1000
		);
		assert.equal(snapshot.sessionCounts?.['7d']?.pi, 6);
	});
});

test('a second run over unchanged pi logs adds nothing, and a new call adds only itself', async () => {
	await piSandbox(async ({ files, collect }) => {
		const first = await collect();
		const again = await collect();
		assert.deepEqual(again.snapshot.hourly, first.snapshot.hourly);

		const fork = Object.entries(files).find(([name]) => name.includes('5c2d9e70'))![1];
		const ts = new Date(Date.now() - 60_000).toISOString();
		await appendFile(
			fork,
			`${JSON.stringify({
				type: 'message',
				id: 'e19',
				parentId: 'e18',
				timestamp: ts,
				message: {
					role: 'assistant',
					model: 'claude-sonnet-4-5',
					usage: { input: 7, output: 11, cacheRead: 0, cacheWrite: 0, totalTokens: 18 }
				}
			})}\n`
		);
		const after = await collect();
		const sum = (s: UsageSnapshot) =>
			s.hourly.reduce((n, r) => n + r.inputTokens + r.outputTokens, 0);
		assert.equal(sum(after.snapshot) - sum(first.snapshot), 18);
	});
});

test('a pi file rewritten in place by a version migration is not counted again', async () => {
	await piSandbox(async ({ sessions, collect }) => {
		const path = join(sessions, '--home-dev-old--', '2026-01-01T00-00-00-000Z_old.jsonl');
		const start = Date.now() - 2 * 3_600_000;
		const v1 = [
			{
				type: 'session',
				id: 'old',
				timestamp: new Date(start).toISOString(),
				cwd: '/home/dev/old'
			},
			...[1, 2, 3, 4, 5, 6].map((n) => ({
				type: 'message',
				timestamp: new Date(start + n * 60_000).toISOString(),
				message: { role: 'assistant', model: 'gpt-5', usage: { input: n, output: 10 * n } }
			}))
		];
		const migrateToV3 = (lines: Record<string, unknown>[]) =>
			lines.map((l, i) =>
				i === 0
					? { ...l, version: 3 }
					: {
							...l,
							id: `e${i}`.padStart(8, '0'),
							parentId: i > 1 ? `e${i - 1}`.padStart(8, '0') : null
						}
			);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, jsonl(v1));
		const first = await collect();
		await writeFile(path, jsonl(migrateToV3(v1)));
		const after = await collect();
		assert.deepEqual(after.snapshot.hourly, first.snapshot.hourly);
	});
});

test('a fork rewritten in place after its first new call is not counted again', async () => {
	await piSandbox(async ({ files, collect }) => {
		const first = await collect();
		const fork = Object.entries(files).find(([name]) => name.includes('5c2d9e70'))![1];
		const lines = (await readFile(fork, 'utf8')).trim().split('\n');
		const label = 'x'.repeat(300);
		await writeFile(fork, jsonl(lines.map((l) => ({ ...JSON.parse(l), label }))));
		const after = await collect();
		assert.deepEqual(after.snapshot.hourly, first.snapshot.hourly);
	});
});

test('a fork counts the same whether its parent later moves to another branch or not', async () => {
	await piSandbox(async ({ files, collect }) => {
		const first = await collect();
		const root = Object.entries(files).find(([name]) => name.includes('0b6f3c1e'))![1];
		const ts = new Date(Date.now() - 60_000).toISOString();
		await appendFile(
			root,
			[
				{ type: 'message', id: 'e20', parentId: 'e3', timestamp: ts, message: { role: 'user' } },
				{
					type: 'message',
					id: 'e21',
					parentId: 'e20',
					timestamp: ts,
					message: {
						role: 'assistant',
						model: 'claude-sonnet-4-5',
						usage: { input: 7, output: 11, cacheRead: 0, cacheWrite: 0, totalTokens: 18 }
					}
				}
			]
				.map((l) => `${JSON.stringify(l)}\n`)
				.join('')
		);
		const incremental = await collect();
		const rescan = await collect('--reset');
		assert.deepEqual(rescan.snapshot.hourly, incremental.snapshot.hourly);
		const sum = (s: UsageSnapshot) =>
			s.hourly.reduce((n, r) => n + r.inputTokens + r.outputTokens, 0);
		assert.equal(sum(rescan.snapshot) - sum(first.snapshot), 18);
	});
});

test('a pi snapshot carries no paths, prompts, project names or session ids', async () => {
	await piSandbox(async ({ home, sessions, collect }) => {
		const local = join(sessions, '--home-dev-local--', '2026-01-01T00-00-00-000Z_local.jsonl');
		const call = (model: string) => ({
			type: 'message',
			timestamp: new Date(Date.now() - 60_000).toISOString(),
			message: { role: 'assistant', model, usage: { input: 5, output: 5 } }
		});
		await mkdir(dirname(local), { recursive: true });
		await writeFile(
			local,
			jsonl([
				call('/home/dev/models/llama-3-8b.gguf'),
				call('private-project/private-model.gguf'),
				call('file:///home/dev/acme/weights'),
				{
					...call('fractional'),
					message: { role: 'assistant', model: 'fractional', usage: { input: 12.5, output: 5 } }
				}
			])
		);
		const { snapshot, stdout } = await collect();
		const models = snapshot.hourly.map((r) => r.model);
		assert.ok(models.includes('llama-3-8b.gguf'));
		assert.ok(models.includes('private-model.gguf'));
		assert.ok(models.includes('weights'));
		assert.equal(snapshot.hourly.find((r) => r.model === 'fractional')?.inputTokens, 0);
		for (const secret of [
			...SECRETS,
			home,
			'private-project',
			'0b6f3c1e',
			'5c2d9e70',
			'subagent'
		]) {
			assert.ok(!stdout.includes(secret), `snapshot contains ${secret}`);
		}
	});
});

test('a provider-namespaced pi model id keeps its name and its provider price', async () => {
	await piSandbox(async ({ sessions, collect }) => {
		const path = join(sessions, '--home-dev-fw--', '2026-01-01T00-00-00-000Z_fw.jsonl');
		const model = 'accounts/fireworks/models/deepseek-v4-flash';
		await mkdir(dirname(path), { recursive: true });
		await writeFile(
			path,
			jsonl([
				{
					type: 'message',
					timestamp: new Date(Date.now() - 60_000).toISOString(),
					message: { role: 'assistant', model, usage: { input: 100_000, output: 0 } }
				}
			])
		);
		const { snapshot } = await collect();
		const row = snapshot.hourly.find((r) => r.model === model);
		assert.equal(row?.costUsd.input, 0.03);
	});
});

test('a fork read across two runs skips its copies even if the parent is gone by the second', async () => {
	await piSandbox(async ({ sessions, collect }) => {
		const dir = join(sessions, '--home-dev-split--');
		const parent = join(dir, '2026-01-01T00-00-00-000Z_parent.jsonl');
		const fork = join(dir, '2026-01-01T01-00-00-000Z_fork.jsonl');
		const t0 = Date.now() - 3 * 3_600_000;
		const at = (min: number) => new Date(t0 + min * 60_000).toISOString();
		const call = (id: string, ts: string, input: number) => ({
			type: 'message',
			id,
			timestamp: ts,
			message: { role: 'assistant', model: 'split-model', usage: { input, output: 0 } }
		});
		const forkAt = at(30);
		const twin = at(40);
		await mkdir(dir, { recursive: true });
		await writeFile(
			parent,
			jsonl([
				{ type: 'session', id: 'parent', timestamp: at(0) },
				call('a', at(1), 10),
				call('b', at(2), 20),
				call('p', twin, 7)
			])
		);
		const header = { type: 'session', id: 'fork', timestamp: forkAt, parentSession: parent };
		await writeFile(fork, jsonl([header, call('a', at(1), 10)]));
		await collect();
		await rm(parent);
		// The fork's own call matches a later parent call to the millisecond; it still counts.
		await appendFile(fork, jsonl([call('b', at(2), 20), call('c', twin, 7)]));
		const { snapshot } = await collect();
		const input = snapshot.hourly
			.filter((r) => r.model === 'split-model')
			.reduce((n, r) => n + r.inputTokens, 0);
		assert.equal(input, 10 + 20 + 7 + 7);
	});
});
