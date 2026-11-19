import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { usageSnapshotSchema, type UsageSnapshot } from '../src/schema.ts';
import { PROJECT_DIR, PROMPT_TEXT, writeGrokHome } from './fixtures/grok-home.ts';
import { run, withSandbox } from './helpers.ts';

const COLLECTOR = fileURLToPath(new URL('../src/collector.mjs', import.meta.url));
const DAY_MS = 86_400_000;

// xAI list prices as LiteLLM carries them, long-context rates included so a tiered count shows.
const PRICES = {
	'xai/grok-4.5': {
		input_cost_per_token: 2e-6,
		output_cost_per_token: 6e-6,
		cache_read_input_token_cost: 3e-7,
		input_cost_per_token_above_200k_tokens: 4e-6,
		output_cost_per_token_above_200k_tokens: 1.2e-5,
		cache_read_input_token_cost_above_200k_tokens: 6e-7
	},
	'xai/grok-code-fast-1': {
		input_cost_per_token: 1e-6,
		output_cost_per_token: 2e-6,
		cache_read_input_token_cost: 2e-7
	}
};

type Day = { input: number; cacheRead: number; cacheWrite: number; output: number; cost: number };

function byDayAndModel(snapshot: UsageSnapshot) {
	const out: Record<string, Day> = {};
	for (const r of snapshot.hourly) {
		assert.equal(r.provider, 'grok');
		const key = `${r.hour.slice(0, 10)} ${r.model}`;
		const d = (out[key] ??= { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0 });
		d.input += r.inputTokens;
		d.cacheRead += r.cacheReadTokens;
		d.cacheWrite += r.cacheWrite5mTokens + r.cacheWrite1hTokens;
		d.output += r.outputTokens;
		d.cost += r.costUsd.input + r.costUsd.cacheRead + r.costUsd.cacheWrite + r.costUsd.output;
	}
	// Each hourly cost part is rounded to 1e-6 USD.
	for (const d of Object.values(out)) d.cost = Math.round(d.cost * 1e5) / 1e5;
	return out;
}

test('Grok Build turns count once per event and model, priced at the base rate', async () => {
	await withSandbox(async ({ env, home }) => {
		const cache = join(env.XDG_CACHE_HOME, 'big-spender');
		await mkdir(cache, { recursive: true });
		await writeFile(
			join(cache, 'litellm-prices.json'),
			JSON.stringify({ fetchedAt: Date.now(), models: PRICES })
		);
		const now = Date.now();
		await writeGrokHome(join(home, '.grok'), now);
		const day = (n: number) =>
			new Date(Math.floor(now / DAY_MS) * DAY_MS - n * DAY_MS).toISOString().slice(0, 10);
		const collect = async () => {
			const res = await run(COLLECTOR, ['--dry-run'], { ...env, BIG_SPENDER_DEVICE_ID: 'laptop' });
			assert.equal(res.code, 0, res.stderr);
			return { res, snapshot: usageSnapshotSchema.parse(JSON.parse(res.stdout)) };
		};

		const first = await collect();
		const expected = {
			[`${day(3)} grok-4.5-build`]: {
				input: 12015,
				cacheRead: 12454,
				cacheWrite: 25,
				output: 495,
				cost: 0.0308
			},
			[`${day(3)} grok-code-fast-1`]: {
				input: 2000,
				cacheRead: 0,
				cacheWrite: 0,
				output: 50,
				cost: 0.0021
			},
			[`${day(2)} grok-4.5-build`]: {
				input: 2200,
				cacheRead: 2800,
				cacheWrite: 0,
				output: 110,
				cost: 0.0059
			},
			[`${day(2)} grok-code-fast-1`]: {
				input: 4000,
				cacheRead: 8000,
				cacheWrite: 0,
				output: 400,
				cost: 0.0064
			},
			[`${day(2)} unknown`]: { input: 10, cacheRead: 0, cacheWrite: 0, output: 1, cost: 0 },
			// The long turn's costUsdTicks are 2,320,000,000 ($0.232), the base rate; the other
			// turn that day adds $0.00338.
			[`${day(1)} grok-4.5-build`]: {
				input: 51000,
				cacheRead: 403000,
				cacheWrite: 0,
				output: 2080,
				cost: 0.23538
			}
		};
		assert.deepEqual(byDayAndModel(first.snapshot), expected);
		assert.deepEqual(first.snapshot.sessionCounts?.['7d'], {
			claude: 0,
			codex: 0,
			grok: 2,
			all: 2
		});

		const printed = first.res.stdout + first.res.stderr;
		for (const secret of [
			PROJECT_DIR,
			encodeURIComponent(PROJECT_DIR),
			PROMPT_TEXT,
			'019fa1b1',
			'evt-',
			home
		]) {
			assert.ok(!printed.includes(secret), `snapshot leaks ${secret}`);
		}

		const second = await collect();
		assert.deepEqual(second.snapshot.hourly, first.snapshot.hourly, 'a second run adds nothing');

		const session = join(
			home,
			'.grok',
			'sessions',
			encodeURIComponent('/home/dev/other'),
			'019fa1b1-0000-7000-8000-000000000002'
		);
		const turn = JSON.stringify({
			timestamp: Math.floor(Math.max(Math.floor(now / DAY_MS) * DAY_MS, now - 60_000) / 1000),
			params: {
				update: {
					sessionUpdate: 'turn_completed',
					usage: { modelUsage: { '[grok] grok-4.5-build': { inputTokens: 300, outputTokens: 10 } } }
				},
				_meta: { eventId: 'evt-appended' }
			}
		});
		await appendFile(join(session, 'updates.jsonl'), `${turn}\n${turn}\n`);
		const third = await collect();
		const today = byDayAndModel(third.snapshot)[`${day(0)} grok-4.5-build`];
		assert.deepEqual([today.input, today.output], [300, 10], 'an appended turn counts once');
		assert.equal(third.snapshot.hourly.length, first.snapshot.hourly.length + 1);
	});
});

test('Grok Build edge cases: path models, fractional counts, eventless rows, late summaries', async () => {
	await withSandbox(async ({ env, home }) => {
		const cache = join(env.XDG_CACHE_HOME, 'big-spender');
		await mkdir(cache, { recursive: true });
		await writeFile(
			join(cache, 'litellm-prices.json'),
			JSON.stringify({ fetchedAt: Date.now(), models: PRICES })
		);
		const ts = Math.floor((Date.now() - 3_600_000) / 1000);
		const line = (usage: object, eventId?: string) =>
			JSON.stringify({
				timestamp: ts,
				params: {
					update: { sessionUpdate: 'turn_completed', usage },
					_meta: eventId ? { eventId } : {}
				}
			}) + '\n';
		const sessions = join(home, '.grok', 'sessions');
		const put = async (rel: string, content: string) => {
			await mkdir(join(sessions, rel, '..'), { recursive: true });
			await appendFile(join(sessions, rel), content);
		};
		const rows = async () => {
			const res = await run(COLLECTOR, ['--dry-run'], { ...env, BIG_SPENDER_DEVICE_ID: 'laptop' });
			assert.equal(res.code, 0, res.stderr);
			const snapshot = usageSnapshotSchema.parse(JSON.parse(res.stdout));
			assert.ok(!res.stdout.includes('secret-project'), 'a model path leaks');
			const out: Record<string, [number, number]> = {};
			for (const r of snapshot.hourly) {
				const d = (out[r.model] ??= [0, 0]);
				d[0] += r.inputTokens;
				d[1] += r.outputTokens;
			}
			return out;
		};

		const eventless = line({
			modelUsage: { 'grok-4.5-build': { inputTokens: 100, outputTokens: 20 } }
		});
		await put('a/sess/updates.jsonl', eventless + eventless);
		await put(
			'p/s1/updates.jsonl',
			line(
				{
					modelUsage: { '/home/dev/secret-project/model.gguf': { inputTokens: 5, outputTokens: 1 } }
				},
				'e-path'
			) +
				line(
					{ modelUsage: { 'grok-4.5-build': { inputTokens: 12.5, outputTokens: 10 } } },
					'e-frac'
				) +
				line({ inputTokens: 7, outputTokens: 3 }, 'e-top')
		);
		assert.deepEqual(await rows(), {
			'grok-4.5-build': [100, 30],
			'model.gguf': [5, 1],
			unknown: [7, 3]
		});

		// The same eventless row in another file is another turn; the top-level event replayed
		// after summary.json appears is the same turn.
		await put('b/sess/updates.jsonl', eventless);
		await put('p/s1/summary.json', JSON.stringify({ current_model_id: 'grok-4.5-build' }));
		await put('p/s2/summary.json', JSON.stringify({ current_model_id: 'grok-4.5-build' }));
		await put('p/s2/updates.jsonl', line({ inputTokens: 7, outputTokens: 3 }, 'e-top'));
		assert.deepEqual(await rows(), {
			'grok-4.5-build': [200, 50],
			'model.gguf': [5, 1],
			unknown: [7, 3]
		});
	});
});
