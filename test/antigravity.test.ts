import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { usageSnapshotSchema, type UsageSnapshot } from '../src/schema.ts';
import {
	addGenerations,
	buildAntigravityHome,
	conversation,
	createDatabase,
	gen,
	openDatabase,
	sqlite
} from './antigravity-fixture.ts';
import { run, seedPricing, withSandbox, type Sandbox } from './helpers.ts';

const COLLECTOR = fileURLToPath(new URL('../src/collector.mjs', import.meta.url));
const DAY_MS = 86_400_000;
const skip = sqlite ? false : 'this Node has no node:sqlite (needs 22.13 or newer)';

const PRICES = {
	'gemini-2.5-pro': {
		input_cost_per_token: 1.25e-6,
		output_cost_per_token: 1e-5,
		input_cost_per_token_above_200k_tokens: 2.5e-6,
		output_cost_per_token_above_200k_tokens: 1.5e-5
	},
	// Listed only under a Google prefix.
	'gemini/gemini-2.5-flash': {
		input_cost_per_token: 3e-7,
		output_cost_per_token: 2.5e-6,
		cache_read_input_token_cost: 3e-8
	},
	// The base model of the effort variants.
	'gemini-3.6-flash': { input_cost_per_token: 7.5e-7, output_cost_per_token: 3.75e-6 }
};

async function collect({ env }: Sandbox, args: string[] = [], extra: Record<string, string> = {}) {
	const res = await run(COLLECTOR, ['--dry-run', ...args], {
		...env,
		BIG_SPENDER_DEVICE_ID: 'laptop',
		...extra
	});
	assert.equal(res.code, 0, res.stderr);
	return { ...res, snapshot: usageSnapshotSchema.parse(JSON.parse(res.stdout)) };
}

type DayModel = {
	input: number;
	output: number;
	cacheWrite: number;
	cacheRead: number;
	cost: UsageSnapshot['hourly'][number]['costUsd'];
};

/** Antigravity usage per "<days after day0> <model>". */
function byDayAndModel(snapshot: UsageSnapshot, day0: number) {
	const out: Record<string, DayModel> = {};
	for (const r of snapshot.hourly) {
		assert.equal(r.provider, 'antigravity');
		const key = `${Math.floor((Date.parse(r.hour) - day0) / DAY_MS)} ${r.model}`;
		const t = (out[key] ??= {
			input: 0,
			output: 0,
			cacheWrite: 0,
			cacheRead: 0,
			cost: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
		});
		t.input += r.inputTokens;
		t.output += r.outputTokens;
		t.cacheWrite += r.cacheWrite5mTokens + r.cacheWrite1hTokens;
		t.cacheRead += r.cacheReadTokens;
		for (const k of ['input', 'cacheRead', 'cacheWrite', 'output'] as const) {
			t.cost[k] += r.costUsd[k];
		}
	}
	return out;
}

const tokens = (rows: Record<string, DayModel>) =>
	Object.fromEntries(
		Object.entries(rows).map(([key, t]) => [key, [t.input, t.output, t.cacheWrite, t.cacheRead]])
	);

// [input, output with reasoning, cache write, cache read] of the home in antigravity-fixture.ts.
const FIXTURE_TOKENS = {
	// response-0, response-2 and response-1, whose step copy and id-sharing retry add nothing.
	'0 gemini-3-pro': [800, 350, 35, 507],
	'0 gemini-3.5-flash-high': [11, 22, 0, 0],
	// 23:59:59.900 stays on day 0.
	'0 gemini-3.6-flash-high': [1000, 300, 0, 0],
	'1 claude-4-opus': [20, 4, 0, 0],
	'1 claude-opus-5-5': [700, 140, 0, 0],
	'1 claude-opus-5-5-medium': [60, 10, 0, 40],
	'1 gemini-2.5-flash': [700, 90, 0, 300],
	'1 gemini-2.5-pro': [14, 11, 0, 0],
	// The success once (its step copy and mirrored retry are the same call) plus the failed attempt.
	'1 gemini-3-pro': [200, 60, 0, 0],
	// Three unkeyed copies of one call.
	'1 gemini-4-argon-medium': [15027, 49, 0, 500131],
	'1 model_placeholder_m499': [5, 1, 0, 0],
	'2 Experimental-Model-Preview-2': [70, 7, 0, 0],
	'2 claude-3-7-sonnet': [1200, 640, 2048, 4096],
	'2 gemini-2.5-pro': [250000, 1000, 0, 0],
	// The larger counts of the response both databases hold, plus the row dated by the trajectory.
	'2 gemini-3-pro': [202, 403, 0, 0],
	'2 gemini-3.5-flash-high': [900, 120, 0, 2000],
	// Dated by the file's mtime.
	'2 gemini-internal-model': [33, 11, 0, 0]
};

test('Antigravity usage is counted once per response, per day and model', { skip }, async () => {
	await withSandbox(async (box) => {
		await seedPricing(join(box.env.XDG_CACHE_HOME, 'big-spender'), PRICES);
		const { day0 } = buildAntigravityHome(box.home);
		const { snapshot, stderr } = await collect(box);

		assert.deepEqual(tokens(byDayAndModel(snapshot, day0)), FIXTURE_TOKENS);
		assert.deepEqual(snapshot.sessionCounts?.['7d'], {
			claude: 0,
			codex: 0,
			antigravity: 4,
			all: 4
		});
		assert.match(stderr, /skipping unreadable Antigravity database not-a-database\.db: /);
		assert.match(stderr, /skipping unreadable Antigravity database partial\.db: /);
		assert.doesNotMatch(stderr, /empty\.db|conversation_summaries/);
	});
});

test(
	'Antigravity cost uses the seeded prices, with reasoning billed as output',
	{ skip },
	async () => {
		await withSandbox(async (box) => {
			await seedPricing(join(box.env.XDG_CACHE_HOME, 'big-spender'), PRICES);
			const { day0 } = buildAntigravityHome(box.home);
			const { snapshot, stderr } = await collect(box);
			const rows = byDayAndModel(snapshot, day0);
			const near = (actual: number, expected: number, what: string) =>
				assert.ok(Math.abs(actual - expected) < 1e-9, `${what}: ${actual} is not ${expected}`);

			// 70 visible and 20 reasoning tokens.
			near(rows['1 gemini-2.5-flash'].cost.output, 90 * 2.5e-6, 'output with reasoning');
			near(rows['1 gemini-2.5-flash'].cost.input, 700 * 3e-7, 'input');
			near(rows['1 gemini-2.5-flash'].cost.cacheRead, 300 * 3e-8, 'cache read');
			near(rows['0 gemini-3.6-flash-high'].cost.input, 1000 * 7.5e-7, 'effort variant input');
			near(rows['0 gemini-3.6-flash-high'].cost.output, 300 * 3.75e-6, 'effort variant output');
			near(rows['2 gemini-2.5-pro'].cost.input, 250_000 * 2.5e-6, 'input above 200k');
			near(rows['2 gemini-2.5-pro'].cost.output, 1000 * 1.5e-5, 'output above 200k');
			assert.deepEqual(rows['2 gemini-3-pro'].cost, {
				input: 0,
				cacheRead: 0,
				cacheWrite: 0,
				output: 0
			});
			assert.match(stderr, /no LiteLLM price for antigravity model "gemini-3-pro"/);
		});
	}
);

test(
	'a second run adds nothing, and a response that grew adds only the difference',
	{ skip },
	async () => {
		await withSandbox(async (box) => {
			await seedPricing(join(box.env.XDG_CACHE_HOME, 'big-spender'), PRICES);
			const { day0, at } = buildAntigravityHome(box.home);
			const first = await collect(box);
			const second = await collect(box);
			assert.deepEqual(second.snapshot.hourly, first.snapshot.hourly);
			assert.match(second.stderr, /skipping unreadable Antigravity database partial\.db: /);

			const db = new sqlite!.DatabaseSync(conversation(box.home, 'main.db'));
			addGenerations(db, [
				[
					20,
					gen({
						model: 'gemini-3-pro',
						use: {
							input: 350,
							totalOutput: 130,
							visible: 100,
							reasoning: 30,
							responseId: 'response-2'
						},
						ts: at(2, 22)
					})
				]
			]);
			db.close();

			// response-2 was counted on day 0 with 300 input and 100 output.
			const grown = { ...FIXTURE_TOKENS, '0 gemini-3-pro': [850, 380, 35, 507] };
			const third = await collect(box);
			assert.deepEqual(tokens(byDayAndModel(third.snapshot, day0)), grown);
			const recount = await collect(box, ['--reset']);
			assert.deepEqual(recount.snapshot.hourly, third.snapshot.hourly);
		});
	}
);

test('a database that changed only in its WAL file is read again', { skip }, async () => {
	await withSandbox(async (box) => {
		await seedPricing(join(box.env.XDG_CACHE_HOME, 'big-spender'));
		const ts = Date.now() - DAY_MS;
		const path = conversation(box.home, 'live.db');
		const call = (n: number) =>
			gen({ model: 'gemini-3-pro', use: { input: n, responseId: `call-${n}` }, ts });
		const db = openDatabase(path, { gens: [[1, call(1)]] });
		try {
			db.exec('PRAGMA journal_mode = WAL');
			db.exec('PRAGMA wal_autocheckpoint = 0');
			addGenerations(db, [[2, call(10)]]);
			const before = await collect(box);
			assert.equal(before.snapshot.hourly[0].inputTokens, 11);

			const main = statSync(path);
			addGenerations(db, [[3, call(100)]]);
			assert.deepEqual(
				[statSync(path).size, statSync(path).mtimeMs],
				[main.size, main.mtimeMs],
				'the write went to the WAL file only'
			);
			const after = await collect(box);
			assert.equal(after.snapshot.hourly[0].inputTokens, 111);
		} finally {
			db.close();
		}
	});
});

test('nothing but numbers and a schema-safe model name leaves the machine', { skip }, async () => {
	await withSandbox(async (box) => {
		await seedPricing(join(box.env.XDG_CACHE_HOME, 'big-spender'));
		createDatabase(conversation(box.home, 'conv-7f3a9c.db'), {
			gens: [
				[
					1,
					gen({
						model: 'Secret Model (Internal | Build 7)',
						use: {
							input: 5,
							totalOutput: 3,
							visible: 3,
							responseId: 'resp-private-1',
							messageId: 'Refactor the billing module'
						},
						ts: Date.now() - DAY_MS
					})
				]
			]
		});
		writeFileSync(conversation(box.home, 'broken.db'), 'not sqlite');
		const { stdout, stderr, snapshot } = await collect(box);

		assert.deepEqual(
			snapshot.hourly.map((r) => [r.model, r.inputTokens, r.outputTokens]),
			[['Secret-Model-Internal-Build-7', 5, 3]]
		);
		for (const secret of [box.home, 'conv-7f3a9c', 'resp-private', 'billing', 'conversations']) {
			assert.ok(!stdout.includes(secret), `the snapshot contains "${secret}"`);
		}
		assert.match(stderr, /Antigravity database broken\.db: /);
		assert.ok(!stderr.includes(box.home), 'a log line names a path');
	});
});

test('ANTIGRAVITY_DATA_DIR is read after the default roots', { skip }, async () => {
	await withSandbox(async (box) => {
		await seedPricing(join(box.env.XDG_CACHE_HOME, 'big-spender'));
		const ts = Date.now() - DAY_MS;
		const one = (path: string, input: number) =>
			createDatabase(path, {
				gens: [[1, gen({ model: 'gemini-3-pro', use: { input, responseId: `r-${input}` }, ts })]]
			});
		one(conversation(box.home, 'default.db'), 1);
		const dataRoot = join(box.home, 'elsewhere');
		one(join(dataRoot, 'conversations', 'in-root.db'), 10);
		const conversationDir = join(box.home, 'direct');
		one(join(conversationDir, 'direct.db'), 100);
		mkdirSync(join(box.home, 'missing'), { recursive: true });

		const { snapshot } = await collect(box, [], {
			ANTIGRAVITY_DATA_DIR: `${dataRoot}, ${conversationDir},${join(box.home, 'missing')}`
		});
		assert.deepEqual(
			snapshot.hourly.map((r) => r.inputTokens),
			[111]
		);
	});
});

test(
	'without node:sqlite the collector warns once and still sends the other sources',
	{ skip },
	async () => {
		await withSandbox(async (box) => {
			await seedPricing(join(box.env.XDG_CACHE_HOME, 'big-spender'));
			buildAntigravityHome(box.home);
			const { snapshot, stderr } = await collect(box, [], {
				NODE_OPTIONS: '--no-experimental-sqlite'
			});
			assert.deepEqual(snapshot.hourly, []);
			assert.equal(stderr.match(/this runtime has no node:sqlite/g)?.length, 1);
		});
	}
);
