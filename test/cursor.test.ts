import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.ts';
import type { UsageRow, UsageSnapshot } from '../src/schema.ts';
import { createBigSpender } from '../src/server/index.ts';
import { createHttpServer } from '../src/serve.ts';
import { harness, run, seedPricing, withSandbox, type Sandbox } from './helpers.ts';

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

/** Cursor's API as the collector sees it: a key exchange and one page of up to 1000 events. */
async function withCursor(
	events: CursorEvent[],
	fn: (url: string, requests: UsageRequest[]) => Promise<void>
) {
	const requests: UsageRequest[] = [];
	const server = createServer(async (req, res) => {
		let text = '';
		for await (const chunk of req) text += chunk;
		const reply = (status: number, body: unknown) => {
			res.writeHead(status, { 'content-type': 'application/json' });
			res.end(JSON.stringify(body));
		};
		if (req.url === '/auth/exchange_user_api_key') {
			if (req.headers.authorization !== `Bearer ${API_KEY}`) return reply(401, { error: 'no' });
			return reply(200, { accessToken: ACCESS_TOKEN });
		}
		if (req.url === '/aiserver.v1.DashboardService/GetFilteredUsageEvents') {
			if (
				req.headers.authorization !== `Bearer ${ACCESS_TOKEN}` ||
				req.headers['connect-protocol-version'] !== '1'
			) {
				return reply(401, { error: 'no' });
			}
			const body = JSON.parse(text);
			const startDate = Number(body.startDate);
			const endDate = Number(body.endDate);
			const inside = events
				.filter((e) => Number(e.timestamp) >= startDate && Number(e.timestamp) <= endDate)
				.sort((a, b) => Number(b.timestamp) - Number(a.timestamp));
			const page = inside.slice(0, body.pageSize);
			requests.push({ startDate, endDate, returned: page.length });
			// Connect leaves out empty fields.
			return reply(
				200,
				inside.length ? { totalUsageEventsCount: inside.length, usageEventsDisplay: page } : {}
			);
		}
		reply(404, {});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	try {
		await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests);
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
			await withCursor(events, async (cursorUrl, requests) => {
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
