import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.ts';
import { usageSnapshotSchema, type UsageRow, type UsageSnapshot } from '../src/schema.ts';
import { createBigSpender } from '../src/server/index.ts';
import { createHttpServer } from '../src/serve.ts';
import { harness, run, seedPricing, snapshot, withSandbox, type Sandbox } from './helpers.ts';

const COLLECTOR = fileURLToPath(new URL('../src/collector.mjs', import.meta.url));
const API_KEY = 'key_live_abc';
const ACCESS_TOKEN = 'access-xyz';
const DAY_MS = 86_400_000;

type CursorEvent = Record<string, unknown>;
type UsageRequest = { startDate: number; endDate: number; returned: number };

function event(
	ts: number,
	model: string,
	tokens: Record<string, number> | null,
	extra: CursorEvent = {}
): CursorEvent {
	return {
		timestamp: String(ts),
		model,
		kind: 'USAGE_EVENT_KIND_INCLUDED_IN_PRO',
		owningUser: '12345',
		...(tokens ? { tokenUsage: tokens } : {}),
		...extra
	};
}

/**
 * How the fake Cursor API misbehaves: the key it accepts, the token it hands out, how many events
 * each page leaves out, and how many extra events the next request counts.
 */
type FakeCursor = {
	apiKey: string;
	accessToken: string;
	shortBy: number;
	countBonus: number;
	errorOnce: Record<string, string> | null;
};

/** Cursor's API as the collector sees it: a key exchange and one page of up to 1000 events. */
async function withCursor(
	events: CursorEvent[],
	fn: (url: string, requests: UsageRequest[], api: FakeCursor) => Promise<void>
) {
	const requests: UsageRequest[] = [];
	const api: FakeCursor = {
		errorOnce: null,
		apiKey: API_KEY,
		accessToken: ACCESS_TOKEN,
		shortBy: 0,
		countBonus: 0
	};
	const server = createServer(async (req, res) => {
		let text = '';
		for await (const chunk of req) text += chunk;
		const reply = (status: number, body: unknown) => {
			res.writeHead(status, { 'content-type': 'application/json' });
			res.end(JSON.stringify(body));
		};
		if (req.url === '/auth/exchange_user_api_key') {
			if (req.headers.authorization !== `Bearer ${api.apiKey}`) return reply(401, { error: 'no' });
			return reply(200, { accessToken: api.accessToken });
		}
		if (req.url === '/aiserver.v1.DashboardService/GetFilteredUsageEvents') {
			if (
				req.headers.authorization !== `Bearer ${ACCESS_TOKEN}` ||
				req.headers['connect-protocol-version'] !== '1'
			) {
				return reply(401, { error: 'no' });
			}
			if (api.errorOnce) {
				const error = api.errorOnce;
				api.errorOnce = null;
				return reply(200, error);
			}
			const body = JSON.parse(text);
			const startDate = Number(body.startDate);
			const endDate = Number(body.endDate);
			const inside = events
				// A malformed timestamp is listed in every window, as a broken record would be.
				.filter((e) => {
					const ts = Number(e.timestamp);
					return Number.isNaN(ts) || (ts >= startDate && ts <= endDate);
				})
				.sort((a, b) => Number(b.timestamp) - Number(a.timestamp));
			const page = inside.slice(0, body.pageSize).slice(api.shortBy);
			const bonus = api.countBonus;
			api.countBonus = 0;
			requests.push({ startDate, endDate, returned: page.length });
			// Connect leaves out empty fields.
			return reply(
				200,
				inside.length
					? { totalUsageEventsCount: inside.length + bonus, usageEventsDisplay: page }
					: {}
			);
		}
		reply(404, {});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	try {
		await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, api);
	} finally {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	}
}

async function withIngest(box: Sandbox, fn: (url: string, dataDir: string) => Promise<void>) {
	const dataDir = join(box.home, 'server-data');
	const bs = createBigSpender({ dataDir, ingestToken: 'tok', devices: { devices: {} } });
	const server = createHttpServer(bs);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	try {
		await fn(
			`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/usage/ingest`,
			dataDir
		);
	} finally {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	}
}

const stored = async (dataDir: string, id: string): Promise<UsageSnapshot> =>
	JSON.parse(await readFile(join(dataDir, `${id}.json`), 'utf8'));

const cost = (rows: UsageRow[]) =>
	rows.reduce(
		(sum, r) =>
			sum + r.costUsd.input + r.costUsd.cacheRead + r.costUsd.cacheWrite + r.costUsd.output,
		0
	);

function collectorEnv(box: Sandbox, ingestUrl: string, cursorUrl: string, apiKey = API_KEY) {
	return {
		...box.env,
		BIG_SPENDER_DEVICE_ID: 'laptop',
		BIG_SPENDER_INGEST_URL: ingestUrl,
		BIG_SPENDER_INGEST_TOKEN: 'tok',
		BIG_SPENDER_CURSOR_API_KEY: apiKey,
		BIG_SPENDER_CURSOR_API_URL: cursorUrl
	};
}

test('the first run backfills the Cursor history as its own device, later runs send 90 days', async () => {
	const now = Date.now();
	const old = Date.parse('2025-08-10T15:30:00Z');
	const recent = now - 2 * DAY_MS;
	const events = [
		event(Date.parse('2025-03-01T10:00:00Z'), 'claude-3.7-sonnet', null, { requestsCosts: 1 }),
		event(old, 'claude-4-sonnet', { inputTokens: 1000, outputTokens: 200, totalCents: 150 }),
		event(
			recent,
			'Premium (Codex 5.3)',
			{
				inputTokens: 400,
				cacheReadTokens: 6000,
				cacheWriteTokens: 100,
				outputTokens: 50,
				totalCents: 30
			},
			{ conversationId: 'conv-1' }
		),
		event(
			recent + 1000,
			'Premium (Codex 5.3)',
			{ inputTokens: 100, outputTokens: 10, totalCents: 5 },
			{ conversationId: 'conv-1' }
		),
		event(recent, 'grok-bot-automation', {}, { kind: 'USAGE_EVENT_KIND_FREE_CREDIT' })
	];

	await withSandbox(async (box) => {
		await seedPricing(join(box.env.XDG_CACHE_HOME, 'big-spender'));
		await withIngest(box, async (ingestUrl, dataDir) => {
			await withCursor(events, async (cursorUrl, requests) => {
				const env = collectorEnv(box, ingestUrl, cursorUrl);
				const first = await run(COLLECTOR, [], env);
				assert.equal(first.code, 0, first.stderr);
				assert.match(first.stderr, /posted \d+ rows for "laptop"/);
				assert.match(first.stderr, /posted \d+ rows for "cursor"/);
				assert.doesNotMatch(first.stderr, new RegExp(`${API_KEY}|${ACCESS_TOKEN}`));

				assert.ok((await stored(dataDir, 'laptop')).hourly.every((r) => r.provider !== 'cursor'));
				const cursor = await stored(dataDir, 'cursor');
				assert.equal(cursor.pricingSource, 'cursor');
				assert.equal(cursor.coverageStart, '2025-08-10T00:00:00.000Z');
				assert.ok(cursor.hourly.every((r) => r.provider === 'cursor'));
				assert.deepEqual([...new Set(cursor.hourly.map((r) => r.model))].sort(), [
					'claude-4-sonnet',
					'premium-codex-5.3'
				]);
				assert.ok(Math.abs(cost(cursor.hourly) - 1.85) < 1e-6, `cost ${cost(cursor.hourly)}`);
				const premium = cursor.hourly.filter((r) => r.model === 'premium-codex-5.3');
				assert.equal(
					premium.reduce((n, r) => n + r.inputTokens, 0),
					500
				);
				assert.equal(
					premium.reduce((n, r) => n + r.cacheReadTokens, 0),
					6000
				);
				assert.equal(
					premium.reduce((n, r) => n + r.cacheWrite5mTokens, 0),
					100
				);
				assert.equal(
					premium.reduce((n, r) => n + r.outputTokens, 0),
					60
				);
				assert.equal(cursor.sessionCounts?.['7d'].cursor, 1);
				assert.equal(cursor.sessionCounts?.['7d'].all, 1);
				assert.equal(requests[0].startDate, Date.parse('2020-01-01T00:00:00Z'));

				requests.length = 0;
				const second = await run(COLLECTOR, [], env);
				assert.equal(second.code, 0, second.stderr);
				assert.equal(requests.length, 1);
				assert.ok(requests[0].startDate > now - 91 * DAY_MS, 'only the last 90 days are read');
				const kept = await stored(dataDir, 'cursor');
				assert.equal(kept.coverageStart, '2025-08-10T00:00:00.000Z');
				assert.ok(Math.abs(cost(kept.hourly) - 1.85) < 1e-6, 'the backfilled day is kept');
			});
		});
	});
});

test('a window holding more than one page is split, and every event counts once', async () => {
	const start = Date.now() - 20 * DAY_MS;
	const events = Array.from({ length: 2500 }, (_, i) =>
		event(start + i * 600_000, 'gpt-5.3-codex-high', { inputTokens: 1, totalCents: 1 })
	);
	await withSandbox(async (box) => {
		await seedPricing(join(box.env.XDG_CACHE_HOME, 'big-spender'));
		await withIngest(box, async (ingestUrl, dataDir) => {
			await withCursor(events, async (cursorUrl, requests, api) => {
				const res = await run(COLLECTOR, [], collectorEnv(box, ingestUrl, cursorUrl));
				assert.equal(res.code, 0, res.stderr);
				assert.ok(requests.length > 3);
				assert.ok(requests.every((r) => r.returned <= 1000));
				const cursor = await stored(dataDir, 'cursor');
				assert.equal(
					cursor.hourly.reduce((n, r) => n + r.inputTokens, 0),
					2500
				);
				assert.ok(Math.abs(cost(cursor.hourly) - 25) < 1e-6, `cost ${cost(cursor.hourly)}`);

				api.countBonus = 1;
				const short = await run(COLLECTOR, ['--dry-run'], collectorEnv(box, ingestUrl, cursorUrl));
				assert.equal(short.code, 1);
				assert.match(
					short.stderr,
					/Cursor counted 2501 usage events in a window but returned 2500 inside it/,
					'halves that add up to less than the whole fail the read'
				);

				api.countBonus = -1;
				const grew = await run(COLLECTOR, ['--dry-run'], collectorEnv(box, ingestUrl, cursorUrl));
				assert.equal(grew.code, 0, 'events that arrive between the reads are kept');
				const grown: UsageSnapshot = JSON.parse(
					grew.stdout.slice(grew.stdout.lastIndexOf('{\n  "schemaVersion"'))
				);
				assert.equal(grown.deviceId, 'cursor');
				assert.equal(
					grown.hourly.reduce((n, r) => n + r.inputTokens, 0),
					2500
				);
			});
		});
	});
});

test('a rejected Cursor key still posts the device, fails the run, and backfills once fixed', async () => {
	const events = [
		event(Date.parse('2025-09-01T12:00:00Z'), 'composer-2', { inputTokens: 10, totalCents: 2 })
	];
	await withSandbox(async (box) => {
		await seedPricing(join(box.env.XDG_CACHE_HOME, 'big-spender'));
		await withIngest(box, async (ingestUrl, dataDir) => {
			await withCursor(events, async (cursorUrl) => {
				const wrong = await run(
					COLLECTOR,
					[],
					collectorEnv(box, ingestUrl, cursorUrl, 'key_wrong_123')
				);
				assert.equal(wrong.code, 1);
				assert.match(wrong.stderr, /Cursor: .*HTTP 401; check BIG_SPENDER_CURSOR_API_KEY/);
				assert.doesNotMatch(wrong.stderr, /key_wrong_123/);
				assert.ok(existsSync(join(dataDir, 'laptop.json')));
				assert.ok(!existsSync(join(dataDir, 'cursor.json')));

				const env = collectorEnv(box, ingestUrl, cursorUrl);
				const dry = await run(COLLECTOR, ['--dry-run'], env);
				assert.equal(dry.code, 0, dry.stderr);
				assert.match(dry.stdout, /"deviceId": "cursor"/);
				assert.ok(!existsSync(join(dataDir, 'cursor.json')), 'a dry run sends nothing');

				const fixed = await run(COLLECTOR, [], env);
				assert.equal(fixed.code, 0, fixed.stderr);
				assert.equal((await stored(dataDir, 'cursor')).coverageStart, '2025-09-01T00:00:00.000Z');
			});
		});
	});
});

test('push never reads Cursor, and install --cursor takes the key from the environment', async () => {
	await withSandbox(async (box) => {
		await seedPricing(join(box.env.XDG_CACHE_HOME, 'big-spender'));
		const pushed = harness(box, {
			env: { BIG_SPENDER_CURSOR_API_KEY: API_KEY, BIG_SPENDER_CURSOR_API_URL: 'http://127.0.0.1:9' }
		});
		assert.equal(await main(['push', 'laptop', '--dry-run'], pushed.ctx), 0, pushed.err.join('\n'));

		const url = 'https://example.com/api/usage/ingest';
		const installed = harness(box, {
			env: { BIG_SPENDER_INGEST_TOKEN: 'tok', BIG_SPENDER_CURSOR_API_KEY: API_KEY }
		});
		const code = await main(
			['install', '--device', 'desk', '--url', url, '--cursor'],
			installed.ctx
		);
		assert.equal(code, 0, installed.err.join('\n'));
		assert.deepEqual(installed.asked, []);
		assert.doesNotMatch([...installed.out, ...installed.err].join('\n'), new RegExp(API_KEY));
		const envFile = join(box.env.XDG_CONFIG_HOME, 'big-spender', 'env');
		assert.match(
			await readFile(envFile, 'utf8'),
			new RegExp(`^BIG_SPENDER_CURSOR_API_KEY=${API_KEY}$`, 'm')
		);

		const again = harness(box, { env: { BIG_SPENDER_INGEST_TOKEN: 'tok' } });
		assert.equal(await main(['install', '--device', 'desk', '--url', url], again.ctx), 0);
		assert.match(
			await readFile(envFile, 'utf8'),
			new RegExp(`^BIG_SPENDER_CURSOR_API_KEY=${API_KEY}$`, 'm')
		);
	});
});

/** An ingest endpoint that records what it gets and answers Cursor snapshots with `result`. */
async function withFakeIngest(
	fn: (url: string, received: UsageSnapshot[], reply: { result: string }) => Promise<void>
) {
	const received: UsageSnapshot[] = [];
	const reply = { result: 'stored' };
	const server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk);
		const snap = JSON.parse(gunzipSync(Buffer.concat(chunks)).toString('utf8'));
		received.push(snap);
		const result = snap.deviceId === 'cursor' ? reply.result : 'stored';
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(
			JSON.stringify({
				ok: true,
				deviceId: snap.deviceId,
				rows: snap.hourly.length,
				note: 'x'.repeat(400),
				result
			})
		);
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	try {
		const port = (server.address() as AddressInfo).port;
		await fn(`http://127.0.0.1:${port}/ingest?key=gateway-secret`, received, reply);
	} finally {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	}
}

test('a page short of its count, a stale reply or an unsafe token never completes the backfill', async () => {
	const oldDay = '2025-09-01T00:00:00.000Z';
	const events = [
		event(Date.parse('2025-09-01T12:00:00Z'), 'composer-2', { inputTokens: 10, totalCents: 2 }),
		event(Date.now() - DAY_MS, 'composer-2', { inputTokens: 5, totalCents: 1 })
	];
	const cursorCoverage = (received: UsageSnapshot[]) =>
		received.filter((r) => r.deviceId === 'cursor').map((r) => r.coverageStart);
	await withSandbox(async (box) => {
		await seedPricing(join(box.env.XDG_CACHE_HOME, 'big-spender'));
		await withCursor(events, async (cursorUrl, _requests, api) => {
			await withFakeIngest(async (ingestUrl, received, reply) => {
				const env = collectorEnv(box, ingestUrl, cursorUrl);

				api.shortBy = 1;
				const short = await run(COLLECTOR, [], env);
				assert.equal(short.code, 1);
				assert.match(short.stderr, /Cursor counted 2 usage events in a window but returned 1/);
				api.shortBy = 0;

				api.countBonus = 1;
				const counted = await run(COLLECTOR, [], env);
				assert.equal(counted.code, 1);
				assert.match(counted.stderr, /Cursor counted 3 usage events in a window but returned 2/);

				events.push(event(Number.NaN, 'composer-2', { inputTokens: 1, totalCents: 1 }));
				const invalid = await run(COLLECTOR, [], env);
				assert.equal(invalid.code, 1);
				assert.match(invalid.stderr, /Cursor counted 3 usage events in a window but returned 2/);
				events.pop();

				const errors: Record<string, string>[] = [
					{ error: 'x' },
					{ code: 'unavailable' },
					{ message: 'upstream' }
				];
				for (const error of errors) {
					api.errorOnce = error;
					const errored = await run(COLLECTOR, [], env);
					assert.equal(errored.code, 1, JSON.stringify(error));
					assert.match(errored.stderr, /Cursor answered with an error instead of usage events/);
				}

				api.accessToken = 'tok\nsecret-part';
				const unsafe = await run(COLLECTOR, [], env);
				assert.equal(unsafe.code, 1);
				assert.match(unsafe.stderr, /Cursor's access token contains characters/);
				assert.doesNotMatch(unsafe.stderr, /secret-part/);
				api.accessToken = ACCESS_TOKEN;
				assert.deepEqual(cursorCoverage(received), [], 'nothing partial was sent');

				reply.result = 'stale';
				const stale = await run(COLLECTOR, [], env);
				assert.equal(stale.code, 0, stale.stderr);
				assert.match(stale.stderr, /server kept a newer "cursor" snapshot \(stale\)/);
				reply.result = 'stored';

				for (let i = 0; i < 2; i++) {
					const ok = await run(COLLECTOR, [], env);
					assert.equal(ok.code, 0, ok.stderr);
				}
				const [staleRun, backfill, incremental] = cursorCoverage(received);
				assert.equal(staleRun, oldDay);
				assert.equal(backfill, oldDay, 'a stale reply leaves the backfill to do');
				assert.notEqual(incremental, oldDay, 'once stored, later runs send 90 days');
				const state = await readFile(
					join(box.env.XDG_CACHE_HOME, 'big-spender', 'state.json'),
					'utf8'
				);
				assert.doesNotMatch(state, /gateway-secret|key_/, 'the marker keeps no URL or key');

				api.apiKey = 'key_other_account';
				const switched = await run(
					COLLECTOR,
					[],
					collectorEnv(box, ingestUrl, cursorUrl, api.apiKey)
				);
				assert.equal(switched.code, 0, switched.stderr);
				assert.equal(cursorCoverage(received).at(-1), oldDay, 'another key backfills again');
				api.apiKey = API_KEY;
			});

			await withFakeIngest(async (otherUrl, received) => {
				const moved = await run(COLLECTOR, [], collectorEnv(box, otherUrl, cursorUrl));
				assert.equal(moved.code, 0, moved.stderr);
				assert.deepEqual(cursorCoverage(received), [oldDay], 'a new server gets the full history');
			});
		});
	});
});

test('the cursor device id is reserved, the API URL stays on this machine, keys stay one line', async () => {
	await withSandbox(async (box) => {
		await seedPricing(join(box.env.XDG_CACHE_HOME, 'big-spender'));
		await withIngest(box, async (ingestUrl, dataDir) => {
			const named = await run(COLLECTOR, [], {
				...collectorEnv(box, ingestUrl, 'http://127.0.0.1:9'),
				BIG_SPENDER_DEVICE_ID: 'cursor'
			});
			assert.equal(named.code, 1);
			assert.match(named.stderr, /"cursor" is reserved for Cursor usage/);
			assert.ok(!existsSync(join(dataDir, 'cursor.json')), 'a machine named cursor posts nothing');

			const remote = await run(
				COLLECTOR,
				[],
				collectorEnv(box, ingestUrl, 'https://collector.example.com')
			);
			assert.equal(remote.code, 1);
			assert.match(remote.stderr, /may only point at this machine/);
			assert.ok(existsSync(join(dataDir, 'laptop.json')), 'the device snapshot is still posted');
		});
	});
});

test('install and push refuse the cursor device id, and install refuses a key with a line break', async () => {
	await withSandbox(async (box) => {
		const url = 'https://example.com/api/usage/ingest';
		const named = harness(box, { env: { BIG_SPENDER_INGEST_TOKEN: 'tok' } });
		assert.equal(await main(['install', '--device', 'cursor', '--url', url], named.ctx), 2);
		assert.match(named.err.join('\n'), /reserved for Cursor usage/);

		const pushed = harness(box);
		assert.equal(await main(['push', 'cursor', '--dry-run'], pushed.ctx), 2);

		const multiline = harness(box, {
			env: {
				BIG_SPENDER_INGEST_TOKEN: 'tok',
				BIG_SPENDER_CURSOR_API_KEY: 'key_a\nBIG_SPENDER_DEVICE_ID=other'
			}
		});
		assert.equal(
			await main(['install', '--device', 'desk', '--url', url, '--cursor'], multiline.ctx),
			2
		);
		assert.ok(!existsSync(join(box.env.XDG_CONFIG_HOME, 'big-spender', 'env')));
	});
});

test('the server takes only Cursor usage under the cursor device id, and keeps older files', async () => {
	await withSandbox(async (box) => {
		const dataDir = join(box.home, 'data');
		await mkdir(dataDir, { recursive: true });
		// What a machine named "cursor" stored before the id was reserved.
		await writeFile(join(dataDir, 'cursor.json'), JSON.stringify(snapshot('cursor')));
		const bs = createBigSpender({ dataDir, ingestToken: 'tok', devices: { devices: {} } });
		const ingest = (snap: UsageSnapshot) =>
			bs.ingest(
				new Request('http://localhost/api/usage/ingest', {
					method: 'POST',
					headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
					body: JSON.stringify(snap)
				})
			);
		const cursorRows = snapshot('cursor').hourly.map((r) => ({
			...r,
			provider: 'cursor' as const
		}));

		const legacy = (await bs.summary()).ranges.all.devices.map((d) => d.name);
		assert.deepEqual(legacy, ['cursor'], 'a stored file from before the reservation still loads');

		assert.equal((await ingest(snapshot('cursor'))).status, 422, 'an older collector named cursor');
		assert.equal(
			(await ingest({ ...snapshot('cursor'), hourly: cursorRows })).status,
			422,
			'Cursor rows with LiteLLM prices'
		);
		assert.equal(
			(await ingest({ ...snapshot('cursor'), pricingSource: 'cursor' })).status,
			422,
			'Claude rows from the Cursor reader'
		);
		const accepted = await ingest({
			...snapshot('cursor', '2026-11-15T00:00:00Z'),
			pricingSource: 'cursor',
			hourly: cursorRows
		});
		assert.equal(accepted.status, 200);
		assert.ok(usageSnapshotSchema.pick({ deviceId: true }).parse({ deviceId: 'cursor' }));
	});
});
