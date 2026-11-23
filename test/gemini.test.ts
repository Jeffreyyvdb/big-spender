import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { usageSnapshotSchema, type UsageSnapshot } from '../src/schema.ts';
import { run, withSandbox } from './helpers.ts';
import { SECRETS, defaultBaseDay, writeGeminiHome } from './fixtures/gemini-home.ts';

const COLLECTOR = fileURLToPath(new URL('../src/collector.mjs', import.meta.url));

// LiteLLM's entries, as pinned by ccusage 20.0.51.
const PRICES = {
	'gemini/gemini-2.5-pro': {
		input_cost_per_token: 1.25e-6,
		input_cost_per_token_above_200k_tokens: 2.5e-6,
		output_cost_per_token: 1e-5,
		output_cost_per_token_above_200k_tokens: 1.5e-5,
		cache_read_input_token_cost: 1.25e-7,
		cache_read_input_token_cost_above_200k_tokens: 2.5e-7
	},
	'gemini/gemini-2.5-flash': {
		input_cost_per_token: 3e-7,
		output_cost_per_token: 2.5e-6,
		cache_read_input_token_cost: 3e-8
	},
	'gemini/gemini-3-flash-preview': {
		input_cost_per_token: 5e-7,
		output_cost_per_token: 3e-6,
		cache_read_input_token_cost: 5e-8
	}
};

type Day = { input: number; cacheRead: number; output: number; cost: number };

function byDayAndModel(snapshot: UsageSnapshot): Record<string, Day> {
	const out: Record<string, Day> = {};
	for (const r of snapshot.hourly) {
		assert.equal(r.provider, 'gemini');
		assert.equal(r.cacheWrite5mTokens + r.cacheWrite1hTokens, 0);
		const d = (out[`${r.hour.slice(0, 10)} ${r.model}`] ??= {
			input: 0,
			cacheRead: 0,
			output: 0,
			cost: 0
		});
		d.input += r.inputTokens;
		d.cacheRead += r.cacheReadTokens;
		d.output += r.outputTokens;
		d.cost += r.costUsd.input + r.costUsd.cacheRead + r.costUsd.cacheWrite + r.costUsd.output;
	}
	return out;
}

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

const DAY_MS = 86_400_000;
const BASE = defaultBaseDay();
const NEXT = new Date(Date.parse(BASE) + DAY_MS).toISOString().slice(0, 10);

// ccusage's tokens for the fixture, with reasoning added to output as both tools bill it. Cost is
// LiteLLM's; ccusage prices gemini-2.5-flash at half of it (see the README).
const EXPECTED: Record<string, Day> = {
	[`${BASE} gemini-2.5-pro`]: { input: 258000, cacheRead: 10000, output: 3150, cost: 0.67525 },
	[`${BASE} gemini-2.5-flash`]: { input: 5020, cacheRead: 1000, output: 100, cost: 0.001786 },
	[`${BASE} gemini-3-flash-preview`]: {
		input: 6808,
		cacheRead: 11526,
		output: 1019,
		cost: 0.0070373
	},
	[`${NEXT} gemini-2.5-pro`]: { input: 6800, cacheRead: 4200, output: 400, cost: 0.013025 },
	[`${NEXT} gemini-2.5-flash`]: { input: 6100, cacheRead: 3000, output: 560, cost: 0.00332 },
	[`${NEXT} unknown`]: { input: 100, cacheRead: 0, output: 10, cost: 0 }
};

const jsonl = (records: object[]) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';

const sum = (s: UsageSnapshot, f: (r: UsageSnapshot['hourly'][number]) => number) =>
	s.hourly.reduce((n, r) => n + f(r), 0);
const tokens = (s: UsageSnapshot) =>
	sum(s, (r) => r.inputTokens + r.cacheReadTokens + r.outputTokens);

type Box = {
	env: Record<string, string>;
	home: string;
	tmp: string;
	collect: (
		extraEnv?: Record<string, string>
	) => Promise<{ snapshot: UsageSnapshot; stdout: string; stderr: string }>;
};

async function geminiSandbox(fn: (box: Box) => Promise<void>) {
	await withSandbox(async ({ env, home }) => {
		const cache = join(env.XDG_CACHE_HOME, 'big-spender');
		await mkdir(cache, { recursive: true });
		await writeFile(
			join(cache, 'litellm-prices.json'),
			JSON.stringify({ fetchedAt: Date.now(), models: PRICES })
		);
		const tmp = await writeGeminiHome(home, BASE);
		const collect = async (extraEnv: Record<string, string> = {}) => {
			const res = await run(COLLECTOR, ['--dry-run'], {
				...env,
				BIG_SPENDER_DEVICE_ID: 'laptop',
				...extraEnv
			});
			assert.equal(res.code, 0, res.stderr);
			const snapshot = usageSnapshotSchema.parse(JSON.parse(res.stdout));
			return { snapshot, stdout: res.stdout, stderr: res.stderr };
		};
		await fn({ env, home, tmp, collect });
	});
}

test('Gemini chats, JSONL sessions and headless stats count as ccusage counts them', async () => {
	await geminiSandbox(async ({ collect }) => {
		const { snapshot } = await collect();
		assertUsage(byDayAndModel(snapshot), EXPECTED);
		// sess-json-a, sess-jsonl-b, sess-stream-d and the four files without a session id.
		assert.equal(snapshot.sessionCounts?.['7d']?.gemini, 7);
	});
});

test('a second run adds nothing and reads no file', async () => {
	await geminiSandbox(async ({ collect }) => {
		const first = await collect();
		const again = await collect();
		assert.deepEqual(again.snapshot.hourly, first.snapshot.hourly);
		assert.match(again.stderr, /read 0 changed file/);
	});
});

test('an updated message replaces its count, and a new one adds only itself', async () => {
	await geminiSandbox(async ({ tmp, collect }) => {
		const first = await collect();
		const ts = new Date(Date.now() - 60_000).toISOString();

		// JSONL: b-g2 appended again with more output, then a new message.
		const jsonlPath = join(tmp, 'project-hash-b/chats/session-b.jsonl');
		const updated = {
			id: 'b-g2',
			timestamp: ts,
			type: 'gemini',
			model: 'gemini-3-flash-preview',
			tokens: { input: 3000, output: 90, cached: 0, thoughts: 0, tool: 0, total: 3090 }
		};
		await appendFile(jsonlPath, `${JSON.stringify(updated)}\n`);
		const afterUpdate = await collect();
		assert.equal(tokens(afterUpdate.snapshot) - tokens(first.snapshot), 50);
		// The hour b-g2 left is sent as zero, so the server replaces the row it stored.
		const left = afterUpdate.snapshot.hourly.find(
			(r) => r.hour === `${BASE}T15:00:00.000Z` && r.model === 'gemini-3-flash-preview'
		);
		assert.equal(left && tokens({ ...afterUpdate.snapshot, hourly: [left] }), 0);

		// The whole-file chat is rewritten with one more message.
		const jsonPath = join(tmp, 'project-hash-a/chats/session-a.json');
		const chat = JSON.parse(await readFile(jsonPath, 'utf8'));
		chat.messages.push({
			id: 'a-g8',
			timestamp: ts,
			type: 'gemini',
			model: 'gemini-2.5-flash',
			tokens: { input: 70, output: 7, cached: 0, thoughts: 3, tool: 0, total: 80 }
		});
		await writeFile(jsonPath, JSON.stringify(chat));
		const afterNew = await collect();
		assert.equal(tokens(afterNew.snapshot) - tokens(afterUpdate.snapshot), 80);
	});
});

test('a file counts what it holds now: corrections, removals and copies as in ccusage', async () => {
	await geminiSandbox(async ({ tmp, collect }) => {
		const first = await collect();
		const path = join(tmp, 'project-hash-a/chats/session-a.json');
		const chat = JSON.parse(await readFile(path, 'utf8'));
		const message = (id: string) => chat.messages.find((m: { id: string }) => m.id === id);

		// Same timestamp, fewer tokens, another model: the correction replaces the count.
		message('a-g4').tokens = { total: 400 };
		message('a-g5').model = 'gemini-2.5-flash';
		await writeFile(path, JSON.stringify(chat));
		const corrected = await collect();
		assert.equal(tokens(corrected.snapshot) - tokens(first.snapshot), -500);
		const moved = byDayAndModel(corrected.snapshot);
		assert.equal(moved[`${BASE} gemini-2.5-flash`].input, 5020 + 2000);

		// A message removed from the file stops counting.
		chat.messages = chat.messages.filter((m: { id: string }) => m.id !== 'a-g4');
		await writeFile(path, JSON.stringify(chat));
		const removed = await collect();
		assert.equal(tokens(corrected.snapshot) - tokens(removed.snapshot), 400);

		// A second file with the same messages counts them again, as ccusage does.
		const copy = jsonl([
			{ sessionId: chat.sessionId, startTime: chat.startTime },
			...chat.messages.filter((m: { id: string }) => m.id === 'a-g1')
		]);
		await writeFile(join(tmp, 'project-hash-a/chats/session-a-copy.jsonl'), copy);
		const copied = await collect();
		assert.equal(tokens(copied.snapshot) - tokens(removed.snapshot), 12450);
	});
});

test('rewriting a file without some records takes back only those', async () => {
	await geminiSandbox(async ({ tmp, collect }) => {
		const path = join(tmp, 'project-hash-c/stream.jsonl');
		const result = (hoursAgo: number, input: number) => ({
			type: 'result',
			timestamp: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
			stats: { input_tokens: input, output_tokens: 1 }
		});
		const init = { type: 'init', session_id: 'sess-stream-e', model: 'gemini-2.5-pro' };
		await writeFile(path, jsonl([init, result(30, 101), result(5, 101), result(5, 200)]));
		const all = await collect();
		await writeFile(path, jsonl([init, result(30, 101), result(5, 200)]));
		const fewer = await collect();
		assert.equal(tokens(all.snapshot) - tokens(fewer.snapshot), 102);
	});
});

test('a JSONL correction dated before the window takes the message back', async () => {
	await geminiSandbox(async ({ tmp, collect }) => {
		const first = await collect();
		const path = join(tmp, 'project-hash-b/chats/session-b.jsonl');
		const old = new Date(Date.now() - 100 * DAY_MS).toISOString();
		await appendFile(
			path,
			jsonl([
				{
					id: 'b-g2',
					timestamp: old,
					type: 'gemini',
					model: 'gemini-3-flash-preview',
					tokens: { input: 3000, output: 40, total: 3040 }
				}
			])
		);
		const after = await collect();
		assert.equal(tokens(first.snapshot) - tokens(after.snapshot), 3040);
	});
});

test('odd records: last copy out of the window, padded ids, bad times, huge counts', async () => {
	await geminiSandbox(async ({ tmp, collect }) => {
		const first = await collect();
		const old = new Date(Date.now() - 100 * DAY_MS).toISOString();
		const recent = new Date(Date.now() - 3_600_000);
		const msg = (id: string, timestamp: string, input: number, extra = {}) => ({
			id,
			timestamp,
			type: 'gemini',
			tokens: { input, output: 1, total: input + 1 },
			...extra
		});
		await writeFile(
			join(tmp, 'project-hash-d.jsonl'),
			jsonl([
				{ sessionId: 'sess-odd', model: '  gemini-2.5-pro  ' },
				// The last copy of r1 is older than the window, so neither copy counts.
				msg('r1', recent.toISOString(), 100),
				msg('r1', old, 100),
				// The same id with spaces is one message: only its last copy counts.
				msg('r2', recent.toISOString(), 10),
				msg(' r2 ', recent.toISOString(), 20),
				// An hour of 24 is not a time; created_at is used instead.
				msg('r3', `${recent.toISOString().slice(0, 10)}T24:00:00Z`, 30, {
					created_at: recent.toISOString()
				})
			])
		);
		// A count no request can have is corrupt (1e309 parses as Infinity): the record is skipped.
		await appendFile(
			join(tmp, 'project-hash-d.jsonl'),
			`{"id":"r4","type":"gemini","timestamp":"${recent.toISOString()}","tokens":{"input":1e309,"output":1}}\n`
		);
		// An escaped key is still the key; a model that is a path leaves only its file name; a
		// timestamp in year 9999 is not one, so the file's mtime dates the message.
		await writeFile(
			join(tmp, 'project-hash-e.json'),
			JSON.stringify({
				sessionId: 'sess-odd-2',
				messages: [
					{ ...msg('e1', 'x', 0), timestamp: undefined, model: '/home/alice/acme/weights' }
				]
			}).replace(
				'"tokens":{"input":0,"output":1,"total":1}',
				'"to\\u006bens":{"input":7,"output":1}'
			)
		);
		await writeFile(
			join(tmp, 'project-hash-f.json'),
			JSON.stringify({ ...msg('f1', '9999-12-31T23:59:59-01:00', 3), model: 'gemini-2.5-pro' })
		);
		for (const name of ['project-hash-e.json', 'project-hash-f.json']) {
			await utimes(join(tmp, name), recent, recent);
		}
		const { snapshot } = await collect();
		const added = snapshot.hourly.filter(
			(r) => !first.snapshot.hourly.some((f) => f.hour === r.hour && f.model === r.model)
		);
		const hour = recent.toISOString().slice(0, 13);
		assert.deepEqual(
			added.map((r) => [r.hour.slice(0, 13), r.model, r.inputTokens, r.outputTokens]),
			[
				[hour, 'gemini-2.5-pro', 53, 3],
				[hour, 'weights', 7, 1]
			]
		);
		assert.ok(!JSON.stringify(snapshot).includes('alice'));
	});
});

test('a half-written chat file is read again once it is complete', async () => {
	await geminiSandbox(async ({ tmp, collect }) => {
		const first = await collect();
		const path = join(tmp, 'project-hash-a/chats/session-late.json');
		const chat = JSON.stringify({
			sessionId: 'sess-late',
			startTime: new Date(Date.now() - 120_000).toISOString(),
			messages: [
				{
					id: 'l-g1',
					timestamp: new Date(Date.now() - 60_000).toISOString(),
					type: 'gemini',
					model: 'gemini-2.5-pro',
					tokens: { input: 100, output: 20, total: 120 }
				}
			]
		});
		await writeFile(path, chat.slice(0, -10));
		const partial = await collect();
		assert.equal(tokens(partial.snapshot), tokens(first.snapshot));
		await writeFile(path, chat);
		const complete = await collect();
		assert.equal(tokens(complete.snapshot) - tokens(first.snapshot), 120);
	});
});

test('a chat caught mid-write keeps its counts, and so does a JSONL line cut off', async () => {
	await geminiSandbox(async ({ tmp, collect }) => {
		const first = await collect();
		const chatPath = join(tmp, 'project-hash-a/chats/session-a.json');
		const chat = await readFile(chatPath, 'utf8');
		await writeFile(chatPath, chat.slice(0, chat.indexOf('"tokens"')));
		const linesPath = join(tmp, 'project-hash-b/chats/session-b.jsonl');
		const lines = await readFile(linesPath, 'utf8');
		await writeFile(linesPath, lines.slice(0, -20));
		const midWrite = await collect();
		assert.deepEqual(midWrite.snapshot.hourly, first.snapshot.hourly);
		await writeFile(chatPath, chat);
		await writeFile(linesPath, lines);
		const done = await collect();
		assert.deepEqual(done.snapshot.hourly, first.snapshot.hourly);
	});
});

test('a symlink to ~/.gemini/tmp in GEMINI_DATA_DIR reads its files once', async () => {
	await geminiSandbox(async ({ home, tmp, collect }) => {
		const alias = join(home, 'gemini-alias');
		await symlink(tmp, alias, 'dir');
		const plain = await collect();
		const viaAlias = await collect({ GEMINI_DATA_DIR: alias });
		assert.deepEqual(viaAlias.snapshot.hourly, plain.snapshot.hourly);
	});
});

test('GEMINI_DATA_DIR adds dirs that are read like ~/.gemini/tmp', async () => {
	await geminiSandbox(async ({ home, collect }) => {
		const moved = join(home, 'moved');
		await mkdir(join(moved, 'chats'), { recursive: true });
		await writeFile(
			join(moved, 'chats', 'session-x.json'),
			JSON.stringify({
				sessionId: 'sess-x',
				messages: [
					{
						id: 'x-g1',
						timestamp: new Date(Date.now() - 60_000).toISOString(),
						type: 'gemini',
						model: 'gemini-2.5-flash',
						tokens: { input: 10, output: 5, total: 15 }
					}
				]
			})
		);
		const base = await collect();
		const withEnv = await collect({ GEMINI_DATA_DIR: ` ${moved} ,` });
		assert.equal(tokens(withEnv.snapshot) - tokens(base.snapshot), 15);
	});
});

test('no prompt, path, project hash or session id leaves the machine', async () => {
	await geminiSandbox(async ({ home, collect }) => {
		const { stdout } = await collect();
		for (const secret of [...SECRETS, home, 'sess-jsonl-b', 'project-hash-b', 'session-a']) {
			assert.ok(!stdout.includes(secret), `snapshot contains ${secret}`);
		}
	});
});
