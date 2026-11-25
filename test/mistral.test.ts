import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { usageSnapshotSchema, type UsageSnapshot } from '../src/schema.ts';
import { run, seedPricing, withSandbox } from './helpers.ts';

const COLLECTOR = fileURLToPath(new URL('../src/collector.mjs', import.meta.url));
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const NOW_HOUR = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
const LARGE = 'mistral-large-4-0';
const PRICES = {
	[`mistral/${LARGE}`]: {
		input_cost_per_token: 0.7e-6,
		output_cost_per_token: 2.1e-6,
		cache_read_input_token_cost: 0.07e-6
	}
};

type Usage = { inputTokens: number; cachedInputTokens: number; outputTokens: number };
const usage = (inputTokens: number, cachedInputTokens: number, outputTokens: number): Usage => ({
	inputTokens,
	cachedInputTokens,
	outputTokens
});

type Fixture = {
	id: string;
	updatedAt?: number;
	usage?: Usage | null;
	metaModel?: string;
	runtimeModel?: string;
	root?: string;
	journal?: string;
	current?: string;
};

const GENERATION = '0000000000000102';

function sessionObject(id: string, updatedAt: number, tokenUsage: Usage | null) {
	return {
		id,
		rootSessionId: id,
		createdAt: updatedAt - 1000,
		updatedAt,
		tokenUsage: tokenUsage && { ...tokenUsage, totalTokens: 0 },
		contextUsage: { inputTokens: 999_999, cachedInputTokens: 0, outputTokens: 999_999 }
	};
}

const delta = (session: unknown) =>
	JSON.stringify({
		type: 'projection_delta',
		payload: { delta: [{ op: 'set_envelope', state: { session } }] }
	});
const advanced = (session: unknown) =>
	JSON.stringify({ type: 'projection_advanced', payload: { snapshot: { session } } });

async function writeSession(store: string, f: Fixture) {
	const dir = join(store, f.id);
	const gen = join(dir, 'generations', GENERATION);
	await mkdir(join(dir, 'journal'), { recursive: true });
	await mkdir(gen, { recursive: true });
	const updatedAt = f.updatedAt ?? NOW_HOUR - HOUR_MS;
	const tokenUsage = f.usage === undefined ? usage(0, 0, 0) : f.usage;
	await writeFile(
		join(dir, 'CURRENT'),
		f.current ?? JSON.stringify({ generation: GENERATION, session_id: f.id })
	);
	await writeFile(
		join(gen, 'manifest.json'),
		JSON.stringify({
			projection_state: { path: 'projection-state.json' },
			runtime_state: { path: 'runtime-state.json' },
			recovery_journal_segment: { first_sequence: 103, path: 'journal/0000000000000103.jsonl' }
		})
	);
	const session = { ...sessionObject(f.id, updatedAt, tokenUsage), rootSessionId: f.root ?? f.id };
	await writeFile(join(gen, 'projection-state.json'), JSON.stringify({ snapshot: { session } }));
	await writeFile(
		join(gen, 'runtime-state.json'),
		JSON.stringify({
			session_metadata: {
				active_model: f.runtimeModel ?? null,
				root_session_id: f.root ?? f.id
			}
		})
	);
	if (f.metaModel) {
		await writeFile(
			join(dir, 'meta.json'),
			JSON.stringify({ config: { active_model: f.metaModel } })
		);
	}
	await writeFile(join(dir, 'journal', '0000000000000103.jsonl'), f.journal ?? '');
}

async function setup(home: string, prices: Record<string, Record<string, number>> = PRICES) {
	await seedPricing(join(home, '.cache', 'big-spender'), prices);
	const store = join(home, '.vibe', 'logs', 'session', 'unified');
	await mkdir(store, { recursive: true });
	return store;
}

async function collect(env: Record<string, string>) {
	const res = await run(COLLECTOR, ['--dry-run'], { ...env, BIG_SPENDER_DEVICE_ID: 'laptop' });
	assert.equal(res.code, 0, res.stderr);
	return {
		snapshot: usageSnapshotSchema.parse(JSON.parse(res.stdout)),
		stderr: res.stderr
	};
}

function byModel(snapshot: UsageSnapshot) {
	const out: Record<string, { input: number; cacheRead: number; output: number; cost: number }> =
		{};
	for (const r of snapshot.hourly) {
		assert.equal(r.provider, 'mistral');
		const m = (out[r.model] ??= { input: 0, cacheRead: 0, output: 0, cost: 0 });
		m.input += r.inputTokens;
		m.cacheRead += r.cacheReadTokens;
		m.output += r.outputTokens;
		m.cost =
			Math.round(
				(m.cost + r.costUsd.input + r.costUsd.cacheRead + r.costUsd.cacheWrite + r.costUsd.output) *
					1e6
			) / 1e6;
		assert.equal(r.cacheWrite5mTokens + r.cacheWrite1hTokens, 0);
	}
	return out;
}

test('cached input is split out of input and priced from the mistral/ entry', async () => {
	await withSandbox(async ({ env, home }) => {
		const store = await setup(home);
		await writeSession(store, { id: 's1', metaModel: LARGE, usage: usage(1000, 600, 200) });

		const { snapshot } = await collect(env);
		assert.deepEqual(byModel(snapshot), {
			[LARGE]: { input: 400, cacheRead: 600, output: 200, cost: 0.000742 }
		});
		assert.equal(Date.parse(snapshot.hourly[0].hour), NOW_HOUR - HOUR_MS);
		assert.equal(snapshot.sessionCounts?.['7d'].mistral, 1);
	});
});

test('a model without a price counts its tokens at cost 0', async () => {
	await withSandbox(async ({ env, home }) => {
		const store = await setup(home);
		await writeSession(store, {
			id: 's1',
			metaModel: 'zai-glm-5-3-flash-vibe-free',
			usage: usage(50, 10, 5)
		});
		assert.deepEqual(byModel((await collect(env)).snapshot), {
			'zai-glm-5-3-flash-vibe-free': { input: 40, cacheRead: 10, output: 5, cost: 0 }
		});
	});
});

test('the journal session state wins over projection-state, and a half-written last line is ignored', async () => {
	await withSandbox(async ({ env, home }) => {
		const store = await setup(home);
		const at = NOW_HOUR - HOUR_MS;
		const mid = sessionObject('s1', at + 1000, usage(2000, 1000, 300));
		const last = sessionObject('s1', at + 2000, usage(3000, 1500, 400));
		const torn = sessionObject('s1', at + 3000, usage(9_000_000, 0, 9_000_000));
		await writeSession(store, {
			id: 's1',
			metaModel: LARGE,
			updatedAt: at,
			usage: usage(1000, 500, 100),
			journal: [
				delta(mid),
				'{"type":"core_input"}',
				advanced(last),
				delta(torn).slice(0, -20)
			].join('\n')
		});

		assert.deepEqual(byModel((await collect(env)).snapshot)[LARGE], {
			input: 1500,
			cacheRead: 1500,
			output: 400,
			cost: Math.round((1500 * 0.7e-6 + 1500 * 0.07e-6 + 400 * 2.1e-6) * 1e6) / 1e6
		});
	});
});

test('a later run adds only what the session total grew by, in the hour of its last update', async () => {
	await withSandbox(async ({ env, home }) => {
		const store = await setup(home);
		const first = NOW_HOUR - 3 * HOUR_MS;
		const second = NOW_HOUR - HOUR_MS;
		await writeSession(store, {
			id: 's1',
			metaModel: LARGE,
			updatedAt: first,
			usage: usage(1000, 600, 200)
		});
		await collect(env);
		await writeSession(store, {
			id: 's1',
			metaModel: LARGE,
			updatedAt: second,
			usage: usage(1500, 900, 260)
		});

		const hours = async () =>
			Object.fromEntries(
				(await collect(env)).snapshot.hourly.map((r) => [
					Date.parse(r.hour),
					[r.inputTokens, r.cacheReadTokens, r.outputTokens]
				])
			);
		const expected = {
			[first]: [400, 600, 200],
			[second]: [200, 300, 60]
		};
		assert.deepEqual(await hours(), expected, 'after growth');
		assert.deepEqual(await hours(), expected, 'unchanged rerun');
	});
});

test('a total that went down books nothing, and later growth counts from the lower total', async () => {
	await withSandbox(async ({ env, home }) => {
		const store = await setup(home);
		await writeSession(store, { id: 's1', metaModel: LARGE, usage: usage(1000, 0, 200) });
		await collect(env);
		await writeSession(store, { id: 's1', metaModel: LARGE, usage: usage(400, 0, 50) });
		assert.equal(byModel((await collect(env)).snapshot)[LARGE].input, 1000, 'after the drop');
		await writeSession(store, { id: 's1', metaModel: LARGE, usage: usage(500, 0, 80) });
		const total = byModel((await collect(env)).snapshot)[LARGE];
		assert.deepEqual([total.input, total.output], [1100, 230], 'after regrowth');
	});
});

test('a subagent counts its own tokens and is one session with its root', async () => {
	await withSandbox(async ({ env, home }) => {
		const store = await setup(home);
		await writeSession(store, { id: 'root-1', metaModel: LARGE, usage: usage(1000, 0, 100) });
		await writeSession(store, {
			id: 'sub-1',
			metaModel: LARGE,
			root: 'root-1',
			usage: usage(500, 0, 50)
		});

		const { snapshot } = await collect(env);
		assert.deepEqual(byModel(snapshot)[LARGE], {
			input: 1500,
			cacheRead: 0,
			output: 150,
			cost: Math.round((1500 * 0.7e-6 + 150 * 2.1e-6) * 1e6) / 1e6
		});
		assert.equal(snapshot.hourly.length, 1);
		assert.equal(snapshot.hourly[0].sessions, 1);
		assert.equal(snapshot.sessionCounts?.['7d'].mistral, 1);
	});
});

test('a session last updated before the 90-day window is not counted', async () => {
	await withSandbox(async ({ env, home }) => {
		const store = await setup(home);
		await writeSession(store, {
			id: 'old',
			metaModel: LARGE,
			updatedAt: NOW_HOUR - 100 * DAY_MS,
			usage: usage(1000, 0, 100)
		});
		await writeSession(store, { id: 'new', metaModel: LARGE, usage: usage(10, 0, 1) });
		assert.equal(byModel((await collect(env)).snapshot)[LARGE].input, 10);
	});
});

test('VIBE_HOME pointing at the default store does not count it twice', async () => {
	await withSandbox(async ({ env, home }) => {
		const store = await setup(home);
		await writeSession(store, { id: 's1', metaModel: LARGE, usage: usage(1000, 600, 200) });
		const once = byModel((await collect(env)).snapshot);
		const twice = byModel((await collect({ ...env, VIBE_HOME: join(home, '.vibe') })).snapshot);
		assert.equal(once[LARGE].input, 400);
		assert.deepEqual(twice, once);
	});
});

test('VIBE_HOME alone is read', async () => {
	await withSandbox(async ({ env, home }) => {
		await setup(home);
		const elsewhere = join(home, 'elsewhere');
		const store = join(elsewhere, 'logs', 'session', 'unified');
		await mkdir(store, { recursive: true });
		await writeSession(store, { id: 's1', metaModel: LARGE, usage: usage(100, 0, 10) });
		const { snapshot } = await collect({ ...env, VIBE_HOME: elsewhere });
		assert.equal(byModel(snapshot)[LARGE].input, 100);
	});
});

test('a session with null token usage or a malformed CURRENT is skipped without failing the run', async () => {
	await withSandbox(async ({ env, home }) => {
		const store = await setup(home);
		await writeSession(store, { id: 'fresh', metaModel: LARGE, usage: null });
		await writeSession(store, { id: 'bad-current', metaModel: LARGE, current: '{not json' });
		await writeSession(store, {
			id: 'bad-path',
			metaModel: LARGE,
			usage: usage(7, 0, 7),
			current: JSON.stringify({ generation: '../../etc' })
		});
		await mkdir(join(store, 'empty-dir'), { recursive: true });
		await writeSession(store, { id: 'good', metaModel: LARGE, usage: usage(100, 0, 10) });

		const { snapshot } = await collect(env);
		assert.equal(byModel(snapshot)[LARGE].input, 100);
		assert.equal(snapshot.sessionCounts?.['7d'].mistral, 1);
	});
});

test("the model falls back to runtime-state's active_model, then to unknown", async () => {
	await withSandbox(async ({ env, home }) => {
		const store = await setup(home);
		await writeSession(store, { id: 'a', runtimeModel: LARGE, usage: usage(100, 0, 10) });
		await writeSession(store, { id: 'b', usage: usage(30, 0, 3) });
		const models = byModel((await collect(env)).snapshot);
		assert.equal(models[LARGE].input, 100);
		assert.equal(models['unknown'].input, 30);
	});
});

test('a model id that is a file path leaves only its file name', async () => {
	await withSandbox(async ({ env, home }) => {
		const store = await setup(home);
		await writeSession(store, {
			id: 'a',
			metaModel: '/Users/someone/models/devstral.gguf',
			usage: usage(10, 0, 1)
		});
		assert.deepEqual(Object.keys(byModel((await collect(env)).snapshot)), ['devstral.gguf']);
	});
});
