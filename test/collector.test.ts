import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
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

const iso = (ms: number) => new Date(ms).toISOString();

type Fixture = { claude: string; codex: string; resets: Record<string, number> };

/** Logs with limit lines. Times are relative to now so they stay inside the 90-day window. */
async function writeLimitLogs(home: string): Promise<Fixture> {
	const hourStart = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
	const t = (hoursAgo: number, extraMs = 0) => hourStart - hoursAgo * HOUR_MS + extraMs;
	const fiveHourReset = t(-2);
	const weeklyReset = t(-30);
	const codexWeekly = t(-70, 50_000);
	const reject = (ms: number, type: string, resetsAt: number) =>
		JSON.stringify({
			type: 'assistant',
			timestamp: iso(ms),
			isApiErrorMessage: true,
			error: 'rate_limit',
			apiErrorStatus: 429,
			message: { model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 } },
			quotaLimits: { status: 'rejected', resetsAt: resetsAt / 1000, rateLimitType: type }
		});
	const claudeLines = [
		// A reset in milliseconds where seconds belong: skipped, and the usage after it still counts.
		reject(t(6), 'five_hour', fiveHourReset * 1000),
		JSON.stringify({
			type: 'assistant',
			timestamp: iso(t(5)),
			requestId: 'r1',
			sessionId: 's1',
			message: {
				id: 'm1',
				model: 'claude-test',
				usage: { input_tokens: 100, output_tokens: 20 }
			}
		}),
		reject(t(1, 60_000), 'five_hour', fiveHourReset),
		reject(t(1, 90_000), 'five_hour', fiveHourReset),
		reject(t(1, 30_000), 'five_hour', fiveHourReset),
		reject(t(3), 'seven_day', weeklyReset)
	];
	const rate = (primary: unknown, secondary: unknown, reached: unknown = null) => ({
		limit_id: 'codex',
		primary,
		secondary,
		rate_limit_reached_type: reached
	});
	const tokenCount = (ms: number, rateLimits: unknown, withInfo = false) =>
		JSON.stringify({
			type: 'event_msg',
			timestamp: iso(ms),
			payload: {
				type: 'token_count',
				...(withInfo
					? {
							info: {
								total_token_usage: { total_tokens: 500 },
								last_token_usage: { input_tokens: 400, output_tokens: 100 }
							}
						}
					: { info: null }),
				rate_limits: rateLimits
			}
		});
	const codexLines = [
		JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-test' } }),
		tokenCount(t(8), rate(null, null)),
		tokenCount(
			t(7),
			rate(
				{ used_percent: 32, window_minutes: 300, resets_at: t(-1) / 1000 },
				{ used_percent: 66, window_minutes: 10080, resets_at: codexWeekly / 1000 }
			),
			true
		),
		tokenCount(
			t(6),
			rate(
				{ used_percent: 100, window_minutes: 300, resets_at: t(-1) / 1000 + 20 },
				// 15 s later: past the minute boundary, still the same window.
				{ used_percent: 66.5, window_minutes: 10080, resets_at: codexWeekly / 1000 + 15 }
			)
		)
	];
	await mkdir(join(home, '.claude', 'projects', 'p'), { recursive: true });
	await mkdir(join(home, '.codex', 'sessions', '2026', '11'), { recursive: true });
	await writeFile(
		join(home, '.claude', 'projects', 'p', 's1.jsonl'),
		claudeLines.join('\n') + '\n'
	);
	await writeFile(
		join(home, '.codex', 'sessions', '2026', '11', 'rollout-a.jsonl'),
		codexLines.join('\n') + '\n'
	);
	return {
		claude: '',
		codex: '',
		resets: {
			fiveHour: fiveHourReset,
			weekly: weeklyReset,
			codexFive: Math.floor(t(-1) / 60_000) * 60_000,
			codexWeekly: Math.floor(codexWeekly / 60_000) * 60_000
		}
	};
}

const dryRun = async (env: Record<string, string>) => {
	const res = await run(COLLECTOR, ['--dry-run'], { ...env, BIG_SPENDER_DEVICE_ID: 'laptop' });
	assert.equal(res.code, 0, res.stderr);
	return JSON.parse(res.stdout);
};

const usageOf = (snap: { hourly: unknown[]; sessionsTotal: number }) => ({
	hourly: snap.hourly,
	sessionsTotal: snap.sessionsTotal
});

test('limit windows are collected from Claude rejections and Codex rate limits', async () => {
	await withSandbox(async ({ home, env }) => {
		await seedPricing(join(env.XDG_CACHE_HOME, 'big-spender'));
		const f = await writeLimitLogs(home);
		const snap = await dryRun(env);

		const summary = (snap.limits as Array<Record<string, unknown>>).map((w) => ({
			provider: w.provider,
			window: w.window,
			resetsAt: w.resetsAt,
			peakPercent: w.peakPercent,
			hit: w.hitAt !== undefined
		}));
		assert.deepEqual(summary, [
			{
				provider: 'codex',
				window: 'five_hour',
				resetsAt: iso(f.resets.codexFive),
				peakPercent: 100,
				hit: true
			},
			{
				provider: 'claude',
				window: 'five_hour',
				resetsAt: iso(f.resets.fiveHour),
				peakPercent: 100,
				hit: true
			},
			{
				provider: 'claude',
				window: 'seven_day',
				resetsAt: iso(f.resets.weekly),
				peakPercent: 100,
				hit: true
			},
			{
				provider: 'codex',
				window: 'seven_day',
				resetsAt: iso(f.resets.codexWeekly),
				peakPercent: 66.5,
				hit: false
			}
		]);
		// Retries of one window collapse to the earliest rejection.
		const fiveHour = snap.limits.find(
			(w: { provider: string; window: string }) =>
				w.provider === 'claude' && w.window === 'five_hour'
		);
		assert.equal(Date.parse(fiveHour.hitAt) % 3_600_000, 30_000);
		assert.equal(snap.sessionsTotal, 2);

		const again = await dryRun(env);
		assert.deepEqual(again.limits, snap.limits);
		assert.deepEqual(usageOf(again), usageOf(snap));
	});
});

test('a snapshot without limit lines has no limits key', async () => {
	await withSandbox(async ({ env }) => {
		await seedPricing(join(env.XDG_CACHE_HOME, 'big-spender'));
		const snap = await dryRun(env);
		assert.equal('limits' in snap, false);
	});
});

test('state from before limits existed picks up old limit lines once, without changing usage', async () => {
	await withSandbox(async ({ home, env }) => {
		const cache = join(env.XDG_CACHE_HOME, 'big-spender');
		await seedPricing(cache);
		await writeLimitLogs(home);
		const current = await dryRun(env);

		const statePath = join(cache, 'state.json');
		const state = JSON.parse(await readFile(statePath, 'utf8'));
		delete state.limits;
		state.fixes = state.fixes.filter((f: string) => f !== 'usage-limits');
		await writeFile(statePath, JSON.stringify(state));

		const upgraded = await dryRun(env);
		assert.deepEqual(upgraded.limits, current.limits);
		assert.deepEqual(usageOf(upgraded), usageOf(current));
		assert.ok(JSON.parse(await readFile(statePath, 'utf8')).fixes.includes('usage-limits'));
		assert.deepEqual((await dryRun(env)).limits, current.limits);
	});
});

test('a server too old for limits gets the snapshot again without them', async () => {
	await withSandbox(async ({ home, env }) => {
		await seedPricing(join(env.XDG_CACHE_HOME, 'big-spender'));
		await writeLimitLogs(home);
		const bodies: Array<Record<string, unknown>> = [];
		const server = createServer(async (req, res) => {
			const chunks: Buffer[] = [];
			for await (const c of req) chunks.push(c as Buffer);
			const body = JSON.parse(gunzipSync(Buffer.concat(chunks)).toString());
			bodies.push(body);
			res.setHeader('content-type', 'application/json');
			if ('limits' in body) {
				res.statusCode = 422;
				res.end(
					JSON.stringify({
						error: 'invalid snapshot',
						issues: ['(root): Unrecognized key: "limits"']
					})
				);
			} else res.end('{"ok":true}');
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		try {
			const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
			const res = await run(COLLECTOR, [], {
				...env,
				BIG_SPENDER_DEVICE_ID: 'laptop',
				BIG_SPENDER_INGEST_URL: url,
				BIG_SPENDER_INGEST_TOKEN: 'tok'
			});
			assert.equal(res.code, 0, res.stderr);
			assert.match(res.stderr, /too old to store limit data/);
			assert.equal(bodies.length, 2);
			assert.equal('limits' in bodies[1], false);
			assert.deepEqual(usageOf(bodies[1] as never), usageOf(bodies[0] as never));
		} finally {
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		}
	});
});
