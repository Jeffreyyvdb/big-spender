import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeSnapshots } from '../src/history.ts';
import { usageSnapshotSchema, type UsageSnapshot } from '../src/schema.ts';
import {
	addGenerations,
	buildAntigravityHome,
	conversation,
	createDatabase,
	generationBlob,
	openDatabase,
	sqlite,
	trajectory,
	type Usage
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
	'gemini/gemini-2.5-flash': {
		input_cost_per_token: 3e-7,
		output_cost_per_token: 2.5e-6,
		cache_read_input_token_cost: 3e-8
	},
	'gemini-3.6-flash': { input_cost_per_token: 7.5e-7, output_cost_per_token: 3.75e-6 }
};

async function collect({ env }: Sandbox, args: string[] = [], extra: Record<string, string> = {}) {
	const res = await run(COLLECTOR, ['--dry-run', ...args], {
		...env,
		BIG_SPENDER_DEVICE_ID: 'laptop',
		BIG_SPENDER_EXPERIMENTAL: 'antigravity',
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
		Object.entries(rows).map(([key, { input, output, cacheWrite, cacheRead }]) => [
			key,
			{ input, output, cacheWrite, cacheRead }
		])
	);

const FIXTURE_TOKENS = {
	'0 gemini-3-pro': { input: 800, output: 350, cacheWrite: 35, cacheRead: 507 },
	'0 gemini-3.5-flash-high': { input: 11, output: 22, cacheWrite: 0, cacheRead: 0 },
	'0 gemini-3.6-flash-high': { input: 1000, output: 300, cacheWrite: 0, cacheRead: 0 },
	'1 claude-4-opus': { input: 20, output: 4, cacheWrite: 0, cacheRead: 0 },
	'1 claude-opus-5-5': { input: 700, output: 140, cacheWrite: 0, cacheRead: 0 },
	'1 claude-opus-5-5-medium': { input: 60, output: 10, cacheWrite: 0, cacheRead: 40 },
	'1 gemini-2.5-flash': { input: 700, output: 90, cacheWrite: 0, cacheRead: 300 },
	'1 gemini-2.5-pro': { input: 14, output: 11, cacheWrite: 0, cacheRead: 0 },
	'1 gemini-3-pro': { input: 200, output: 60, cacheWrite: 0, cacheRead: 0 },
	'1 gemini-4-argon-medium': { input: 15027, output: 49, cacheWrite: 0, cacheRead: 500131 },
	'1 model_placeholder_m499': { input: 5, output: 1, cacheWrite: 0, cacheRead: 0 },
	'2 Experimental-Model-Preview-2': { input: 70, output: 7, cacheWrite: 0, cacheRead: 0 },
	'2 claude-3-7-sonnet': { input: 1200, output: 640, cacheWrite: 2048, cacheRead: 4096 },
	'2 gemini-2.5-pro': { input: 250000, output: 1000, cacheWrite: 0, cacheRead: 0 },
	'2 gemini-3-pro': { input: 202, output: 403, cacheWrite: 0, cacheRead: 0 },
	'2 gemini-3.5-flash-high': { input: 900, output: 120, cacheWrite: 0, cacheRead: 2000 },
	'2 gemini-internal-model': { input: 33, output: 11, cacheWrite: 0, cacheRead: 0 }
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
	'Antigravity is read and sent only while BIG_SPENDER_EXPERIMENTAL names it',
	{ skip },
	async () => {
		await withSandbox(async (box) => {
			await seedPricing(join(box.env.XDG_CACHE_HOME, 'big-spender'), PRICES);
			const { day0 } = buildAntigravityHome(box.home);
			const off = { BIG_SPENDER_EXPERIMENTAL: 'cursor, pi' };

			const never = await collect(box, [], off);
			assert.deepEqual(never.snapshot.hourly, []);
			assert.equal(never.snapshot.sessionCounts?.['7d'].antigravity, undefined);
			assert.doesNotMatch(never.stderr, /Antigravity/);

			const on = await collect(box, [], { BIG_SPENDER_EXPERIMENTAL: 'pi, antigravity' });
			assert.deepEqual(tokens(byDayAndModel(on.snapshot, day0)), FIXTURE_TOKENS);

			assert.deepEqual((await collect(box, [], off)).snapshot.hourly, []);
			const again = await collect(box);
			assert.deepEqual(again.snapshot.hourly, on.snapshot.hourly);
		});
	}
);

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

			near(rows['1 gemini-2.5-flash'].cost.output, (70 + 20) * 2.5e-6, 'output with reasoning');
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
					generationBlob({
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

			const before = FIXTURE_TOKENS['0 gemini-3-pro'];
			const grown = {
				...FIXTURE_TOKENS,
				'0 gemini-3-pro': { ...before, input: before.input + 50, output: before.output + 30 }
			};
			const third = await collect(box);
			assert.deepEqual(tokens(byDayAndModel(third.snapshot, day0)), grown);
			const recount = await collect(box, ['--reset']);
			assert.deepEqual(recount.snapshot.hourly, third.snapshot.hourly);
		});
	}
);

const DAY0 = Math.floor(Date.now() / DAY_MS) * DAY_MS - 3 * DAY_MS;
const at = (day: number, hour: number) => DAY0 + day * DAY_MS + hour * 3_600_000;
const pro = (use: Usage, ts?: number, retries: Usage[] = []) =>
	generationBlob({ model: 'gemini-3-pro', use, ts, retries });
const plain = (input: number, output: number): Usage => ({
	input,
	totalOutput: output,
	visible: output
});

/**
 * Runs the collector after each step and posts each snapshot to a server's history, then checks
 * what the server holds against a fresh scan.
 */
async function converges(
	steps: ((home: string) => void)[],
	expected: Record<string, { input: number; output: number }>
) {
	await withSandbox(async (box) => {
		await seedPricing(join(box.env.XDG_CACHE_HOME, 'big-spender'));
		let hourly: UsageSnapshot['hourly'] = [];
		let server: UsageSnapshot | undefined;
		for (const step of steps) {
			step(box.home);
			const { snapshot } = await collect(box);
			server = mergeSnapshots(server, snapshot).snapshot;
			hourly = snapshot.hourly;
		}
		assert.deepEqual(
			(await collect(box)).snapshot.hourly,
			hourly,
			'an unchanged rerun adds nothing'
		);
		const fresh = await collect(box, ['--reset']);
		assert.deepEqual(
			server?.hourly,
			fresh.snapshot.hourly,
			'the server ends where a fresh scan ends'
		);
		const rows = Object.fromEntries(
			Object.entries(byDayAndModel(fresh.snapshot, DAY0)).map(([key, { input, output }]) => [
				key,
				{ input, output }
			])
		);
		assert.deepEqual(rows, expected);
	});
}

test(
	'scenario 7: a retry without ids counts once per database, also for a same-named copy',
	{ skip },
	() =>
		converges(
			[
				(home) => {
					for (const root of ['.gemini/antigravity', '.gemini/antigravity-backup']) {
						createDatabase(conversation(home, 'a.db', root), {
							gens: [[1, pro({ ...plain(100, 10), responseId: 'R' }, at(1, 10), [plain(90, 4)])]]
						});
					}
				}
			],
			{ '1 gemini-3-pro': { input: 280, output: 18 } }
		)
);

test(
	'scenario 1a: a later copy that links two responses counted apart leaves one response',
	{ skip },
	() =>
		converges(
			[
				(home) => {
					createDatabase(conversation(home, 'a.db'), {
						gens: [[1, pro({ ...plain(100, 10), responseId: 'R' }, at(1, 10))]]
					});
					createDatabase(conversation(home, 'b.db'), {
						gens: [[1, pro({ ...plain(100, 10), providerMessageId: 'P' }, at(1, 10))]]
					});
				},
				(home) =>
					createDatabase(conversation(home, 'c.db'), {
						gens: [
							[1, pro({ ...plain(120, 10), responseId: 'R', providerMessageId: 'P' }, at(1, 10))]
						]
					})
			],
			{ '1 gemini-3-pro': { input: 120, output: 10 } }
		)
);

test(
	'scenario 3b: a later copy with its own timestamp moves the response to that day',
	{ skip },
	() =>
		converges(
			[
				(home) =>
					createDatabase(conversation(home, 'a.db'), {
						gens: [[1, pro({ ...plain(100, 10), responseId: 'R' })]],
						trajectories: [trajectory(at(2, 5))]
					}),
				(home) =>
					createDatabase(conversation(home, 'b.db'), {
						gens: [[1, pro({ ...plain(100, 10), responseId: 'R' }, at(1, 5))]]
					})
			],
			{ '1 gemini-3-pro': { input: 100, output: 10 } }
		)
);

test(
	'scenario 4b: a later copy that names the model moves the response off the placeholder',
	{ skip },
	() =>
		converges(
			[
				(home) =>
					createDatabase(conversation(home, 'a.db'), {
						gens: [
							[
								1,
								generationBlob({
									use: { ...plain(100, 10), modelId: 1499, responseId: 'R' },
									ts: at(1, 10)
								})
							]
						]
					}),
				(home) =>
					createDatabase(conversation(home, 'b.db'), {
						gens: [
							[
								1,
								generationBlob({
									model: 'Gemini 3 Pro',
									use: { ...plain(160, 10), responseId: 'R' },
									ts: at(1, 10)
								})
							]
						]
					})
			],
			{ '1 gemini-3-pro': { input: 160, output: 10 } }
		)
);

test(
	'scenario 8: a response dated by its file follows the file when it is written again',
	{ skip },
	() => {
		const touch = (path: string, ms: number) => utimesSync(path, new Date(ms), new Date(ms));
		return converges(
			[
				(home) => {
					const path = conversation(home, 'a.db');
					createDatabase(path, {
						gens: [[1, pro({ input: 100, responseId: 'R' })]],
						withStepsAndTrajectory: false
					});
					touch(path, at(1, 10));
				},
				(home) => {
					const path = conversation(home, 'a.db');
					const db = new sqlite!.DatabaseSync(path);
					addGenerations(db, [[2, pro({ input: 5, responseId: 'S' }, at(2, 10))]]);
					db.close();
					touch(path, at(2, 10));
				}
			],
			{ '2 gemini-3-pro': { input: 105, output: 0 } }
		);
	}
);

test('a database that changed only in its WAL file is read again', { skip }, async () => {
	await withSandbox(async (box) => {
		await seedPricing(join(box.env.XDG_CACHE_HOME, 'big-spender'));
		const ts = Date.now() - DAY_MS;
		const path = conversation(box.home, 'live.db');
		const call = (n: number) =>
			generationBlob({ model: 'gemini-3-pro', use: { input: n, responseId: `call-${n}` }, ts });
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
					generationBlob({
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
				],
				[
					2,
					generationBlob({
						model: join(box.home, 'projects', 'private-stem.db'),
						use: { input: 7, totalOutput: 1, visible: 1, responseId: 'resp-private-2' },
						ts: Date.now() - DAY_MS
					})
				]
			]
		});
		writeFileSync(conversation(box.home, 'broken.db'), 'not sqlite');
		const { stdout, stderr, snapshot } = await collect(box);

		assert.deepEqual(snapshot.hourly.map((r) => [r.model, r.inputTokens, r.outputTokens]).sort(), [
			['Secret-Model-Internal-Build-7', 5, 3],
			['gemini-internal-model', 7, 1]
		]);
		const secrets = [
			box.home,
			'conv-7f3a9c',
			'resp-private',
			'billing',
			'conversations',
			'private-stem'
		];
		for (const secret of secrets) {
			assert.ok(!stdout.includes(secret), `the snapshot contains "${secret}"`);
		}
		assert.match(stderr, /Antigravity database broken\.db: /);
		assert.ok(!stderr.includes(box.home), 'a log line names a path');

		const state = JSON.parse(
			readFileSync(join(box.env.XDG_CACHE_HOME, 'big-spender', 'state.json'), 'utf8')
		);
		const kept = JSON.stringify([state.seen, state.buckets]);
		for (const secret of secrets) {
			assert.ok(!kept.includes(secret), `the state keeps "${secret}" outside its file list`);
		}
	});
});

test('ANTIGRAVITY_DATA_DIR is read after the default roots', { skip }, async () => {
	await withSandbox(async (box) => {
		await seedPricing(join(box.env.XDG_CACHE_HOME, 'big-spender'));
		const ts = Date.now() - DAY_MS;
		const one = (path: string, input: number) =>
			createDatabase(path, {
				gens: [
					[
						1,
						generationBlob({ model: 'gemini-3-pro', use: { input, responseId: `r-${input}` }, ts })
					]
				]
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
	'a root in ANTIGRAVITY_DATA_DIR that links to a default root is read once',
	{ skip },
	async () => {
		await withSandbox(async (box) => {
			await seedPricing(join(box.env.XDG_CACHE_HOME, 'big-spender'));
			createDatabase(conversation(box.home, 'a.db'), {
				gens: [
					[1, pro({ ...plain(100, 10), responseId: 'R' }, Date.now() - DAY_MS, [plain(50, 5)])]
				]
			});
			const link = join(box.home, 'linked');
			symlinkSync(join(box.home, '.gemini', 'antigravity'), link);

			const { snapshot } = await collect(box, [], { ANTIGRAVITY_DATA_DIR: link });
			assert.deepEqual(
				snapshot.hourly.map((r) => [r.inputTokens, r.outputTokens]),
				[[150, 15]]
			);
		});
	}
);

test(
	'a timestamp that cannot be a date falls back to the conversation time',
	{ skip },
	async () => {
		await withSandbox(async (box) => {
			await seedPricing(join(box.env.XDG_CACHE_HOME, 'big-spender'));
			const msAsSeconds = Date.now() * 1000;
			createDatabase(conversation(box.home, 'a.db'), {
				gens: [[1, pro({ ...plain(100, 10), responseId: 'R' }, msAsSeconds)]],
				trajectories: [trajectory(at(1, 5))]
			});

			const { snapshot } = await collect(box);
			assert.deepEqual(
				snapshot.hourly.map((r) => [r.hour, r.inputTokens]),
				[[new Date(at(1, 5)).toISOString(), 100]]
			);
		});
	}
);

test('usage stored as TEXT instead of a BLOB is read byte for byte', { skip }, async () => {
	await withSandbox(async (box) => {
		await seedPricing(join(box.env.XDG_CACHE_HOME, 'big-spender'));
		const db = openDatabase(conversation(box.home, 'a.db'), {
			gens: [[1, pro({ ...plain(500, 32), responseId: 'R' }, at(1, 5))]]
		});
		db.exec('UPDATE gen_metadata SET data = CAST(data AS TEXT)');
		assert.equal(db.prepare('SELECT typeof(data) AS t FROM gen_metadata').get()?.t, 'text');
		db.close();

		const { snapshot } = await collect(box);
		assert.deepEqual(
			snapshot.hourly.map((r) => [r.inputTokens, r.outputTokens]),
			[[500, 32]]
		);
	});
});

test(
	'above a long-context tier, a missing cache price derives from the base input price',
	{ skip },
	async () => {
		await withSandbox(async (box) => {
			await seedPricing(join(box.env.XDG_CACHE_HOME, 'big-spender'), {
				'gemini-3-pro': {
					input_cost_per_token: 1e-6,
					input_cost_per_token_above_200k_tokens: 2e-6,
					output_cost_per_token: 1e-5
				}
			});
			createDatabase(conversation(box.home, 'a.db'), {
				gens: [
					[
						1,
						pro(
							{ ...plain(30_000, 600), cacheRead: 210_000, cacheWrite: 1_000, responseId: 'R' },
							at(1, 5)
						)
					]
				]
			});

			const [row] = (await collect(box)).snapshot.hourly;
			assert.deepEqual(row.costUsd, {
				input: 0.06,
				cacheRead: 0.021,
				cacheWrite: 0.00125,
				output: 0.006
			});
		});
	}
);

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
