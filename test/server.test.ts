import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createBigSpender } from '../src/server/index.ts';
import { fileStore } from '../src/store.ts';
import type { DeviceConfig } from '../src/devices.ts';
import { MAX_ROWS, usageSnapshotSchema, type UsageRow, type UsageSnapshot } from '../src/schema.ts';
import { row, snapshot, withTempDir } from './helpers.ts';

const TOKEN = 'secret-token';
const NOW = Date.parse('2026-11-14T22:30:00Z');
const DEVICES: DeviceConfig = {
	devices: { mac: { name: 'MacBook', color: '#7fa034' } },
	unknownDevices: 'other'
};

function post(body: BodyInit | null, headers: Record<string, string> = {}): Request {
	return new Request('http://localhost/api/usage/ingest', {
		method: 'POST',
		headers: { authorization: `Bearer ${TOKEN}`, ...headers },
		body
	});
}

const postJson = (value: unknown, headers: Record<string, string> = {}) =>
	post(JSON.stringify(value), headers);

const setup = (dir: string, ingestToken: string | undefined = TOKEN) =>
	createBigSpender({ dataDir: dir, ingestToken, devices: DEVICES });

test('ingest is off without a token', async () => {
	await withTempDir(async (dir) => {
		const request = () => postJson(snapshot('mac'));
		const unset = createBigSpender({ dataDir: dir, ingestToken: undefined, devices: DEVICES });
		assert.equal((await unset.ingest(request())).status, 503);
		for (const token of ['', '   ']) {
			assert.equal((await setup(dir, token).ingest(request())).status, 503);
		}
		assert.deepEqual(await readdir(dir), []);
	});
});

test('ingest needs the bearer token', async () => {
	await withTempDir(async (dir) => {
		const bs = setup(dir);
		const body = JSON.stringify(snapshot('mac'));
		const missing = new Request('http://localhost/', { method: 'POST', body });
		assert.equal((await bs.ingest(missing)).status, 401);
		for (const authorization of ['Bearer wrong', 'Basic secret-token', `Bearer ${TOKEN}x`]) {
			assert.equal((await bs.ingest(post(body, { authorization }))).status, 401);
		}
		assert.deepEqual(await readdir(dir), []);
	});
});

test('bodies over 2 MB are refused, declared or streamed', async () => {
	await withTempDir(async (dir) => {
		const bs = setup(dir);
		const declared = await bs.ingest(post('{}', { 'content-length': String(3 * 1024 * 1024) }));
		assert.equal(declared.status, 413);

		const big = new Uint8Array(3 * 1024 * 1024).fill(32);
		const stream = new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(big);
				c.close();
			}
		});
		const streamed = new Request('http://localhost/', {
			method: 'POST',
			headers: { authorization: `Bearer ${TOKEN}` },
			body: stream,
			duplex: 'half'
		} as RequestInit);
		assert.equal((await bs.ingest(streamed)).status, 413);
	});
});

test('a gzip body that expands past 16 MB is refused', async () => {
	await withTempDir(async (dir) => {
		const bomb = gzipSync(Buffer.alloc(17 * 1024 * 1024, 32));
		assert.ok(bomb.length < 2 * 1024 * 1024);
		const res = await setup(dir).ingest(post(bomb, { 'content-encoding': 'gzip' }));
		assert.equal(res.status, 413);
	});
});

test('only gzip and identity encodings are accepted', async () => {
	await withTempDir(async (dir) => {
		const bs = setup(dir);
		assert.equal((await bs.ingest(postJson({}, { 'content-encoding': 'br' }))).status, 415);
		const identity = await bs.ingest(postJson(snapshot('mac'), { 'content-encoding': 'identity' }));
		assert.equal(identity.status, 200);
		const gz = await bs.ingest(
			post(gzipSync(JSON.stringify(snapshot('laptop'))), { 'content-encoding': 'gzip' })
		);
		assert.equal(gz.status, 200);
	});
});

test('malformed bodies are 400', async () => {
	await withTempDir(async (dir) => {
		const bs = setup(dir);
		assert.equal((await bs.ingest(post('{nope'))).status, 400);
		assert.equal(
			(await bs.ingest(post(Buffer.from('not gzip'), { 'content-encoding': 'gzip' }))).status,
			400
		);
		assert.equal((await bs.ingest(post(null))).status, 400);
	});
});

test('an invalid snapshot is 422 with at most the first five issues', async () => {
	await withTempDir(async (dir) => {
		const bad = {
			...snapshot('mac'),
			deviceId: '../etc',
			generatedAt: 'yesterday',
			coverageStart: 'then',
			pricingSource: '???',
			sessionsTotal: -1,
			cwd: '/home/me'
		};
		const res = await setup(dir).ingest(postJson(bad));
		assert.equal(res.status, 422);
		const body = (await res.json()) as { error: string; issues: string[] };
		assert.equal(body.error, 'invalid snapshot');
		assert.equal(body.issues.length, 5);
		assert.deepEqual(await readdir(dir), []);
	});
});

test('an older snapshot than the stored one is stale and changes nothing', async () => {
	await withTempDir(async (dir) => {
		const bs = setup(dir);
		const first = await bs.ingest(postJson(snapshot('mac', '2026-11-14T22:00:00Z', 8)));
		assert.deepEqual(await first.json(), { ok: true, deviceId: 'mac', rows: 1, result: 'stored' });

		const stale = await bs.ingest(postJson(snapshot('mac', '2026-11-14T21:00:00Z', 1)));
		assert.deepEqual(await stale.json(), { ok: true, deviceId: 'mac', rows: 1, result: 'stale' });
		const stored = JSON.parse(await readFile(join(dir, 'mac.json'), 'utf8'));
		assert.equal(stored.generatedAt, '2026-11-14T22:00:00Z');

		const same = await bs.ingest(postJson(snapshot('mac', '2026-11-14T22:00:00Z', 6)));
		assert.equal(((await same.json()) as { result: string }).result, 'stored');
	});
});

const dayRow = (day: string, model: string, cost: number): UsageRow => ({
	...row(`${day}T00:00:00Z`, model, cost),
	granularity: 'day'
});

const withRows = (hourly: UsageRow[], generatedAt: string, extra: Partial<UsageSnapshot> = {}) => ({
	...snapshot('mac', generatedAt),
	hourly,
	...extra
});

test('a day older than the new snapshot window survives and counts in the 90d total', async () => {
	await withTempDir(async (dir) => {
		const bs = setup(dir);
		await bs.ingest(postJson(withRows([dayRow('2026-09-20', 'm', 3)], '2026-11-14T10:00:00Z')));
		await bs.ingest(postJson(withRows([dayRow('2026-11-13', 'm', 5)], '2026-11-14T22:00:00Z')));
		const ranges = (await bs.summary(NOW)).ranges;
		assert.equal(ranges['90d'].totalCost, 8);
		assert.equal(ranges['30d'].totalCost, 5);
	});
});

test('re-pushing the same snapshot leaves the file bytes identical', async () => {
	await withTempDir(async (dir) => {
		const bs = setup(dir);
		await bs.ingest(postJson(withRows([dayRow('2026-09-20', 'm', 3)], '2026-11-14T10:00:00Z')));
		const next = withRows([row('2026-11-13T05:00:00Z', 'm', 5)], '2026-11-14T22:00:00Z');
		await bs.ingest(postJson(next));
		const first = await readFile(join(dir, 'mac.json'), 'utf8');
		await bs.ingest(postJson(next));
		assert.equal(await readFile(join(dir, 'mac.json'), 'utf8'), first);
	});
});

test('a correction replaces the day instead of adding to it', async () => {
	await withTempDir(async (dir) => {
		const bs = setup(dir);
		await bs.ingest(postJson(withRows([dayRow('2026-11-13', 'm', 5)], '2026-11-14T10:00:00Z')));
		await bs.ingest(postJson(withRows([dayRow('2026-11-13', 'm', 2)], '2026-11-14T22:00:00Z')));
		assert.equal((await bs.summary(NOW)).ranges['7d'].totalCost, 2);
	});
});

test('a snapshot with fewer days does not erase stored days', async () => {
	await withTempDir(async (dir) => {
		const bs = setup(dir);
		const days = (from: number, to: number) =>
			Array.from({ length: to - from + 1 }, (_, i) =>
				dayRow(
					new Date(Date.parse('2026-09-01T00:00:00Z') + (from + i) * 86_400_000)
						.toISOString()
						.slice(0, 10),
					'm',
					1
				)
			);
		await bs.ingest(postJson(withRows(days(0, 59), '2026-11-14T10:00:00Z')));
		await bs.ingest(postJson(withRows(days(0, 29), '2026-11-14T22:00:00Z')));
		const stored = JSON.parse(await readFile(join(dir, 'mac.json'), 'utf8'));
		assert.equal(stored.hourly.length, 60);
		assert.equal((await bs.summary(NOW)).ranges['90d'].totalCost, 60);
	});
});

test('a day that moves from hourly rows to a daily row is not double counted', async () => {
	await withTempDir(async (dir) => {
		const bs = setup(dir);
		await bs.ingest(
			postJson(
				withRows(
					[row('2026-11-12T03:00:00Z', 'm', 2), row('2026-11-12T15:00:00Z', 'm', 2)],
					'2026-11-14T10:00:00Z'
				)
			)
		);
		await bs.ingest(postJson(withRows([dayRow('2026-11-12', 'm', 6)], '2026-11-14T22:00:00Z')));
		assert.equal((await bs.summary(NOW)).ranges['7d'].totalCost, 6);
	});
});

test('a stale snapshot leaves the merged history unchanged', async () => {
	await withTempDir(async (dir) => {
		const bs = setup(dir);
		await bs.ingest(postJson(withRows([dayRow('2026-09-20', 'm', 3)], '2026-11-14T10:00:00Z')));
		await bs.ingest(postJson(withRows([dayRow('2026-11-13', 'm', 5)], '2026-11-14T22:00:00Z')));
		const before = await readFile(join(dir, 'mac.json'), 'utf8');
		const stale = await bs.ingest(
			postJson(withRows([dayRow('2026-11-13', 'm', 99)], '2026-11-14T12:00:00Z'))
		);
		assert.equal(((await stale.json()) as { result: string }).result, 'stale');
		assert.equal(await readFile(join(dir, 'mac.json'), 'utf8'), before);
	});
});

test('the merged history reloads from disk', async () => {
	await withTempDir(async (dir) => {
		const bs = setup(dir);
		await bs.ingest(postJson(withRows([dayRow('2026-09-20', 'm', 3)], '2026-11-14T10:00:00Z')));
		await bs.ingest(postJson(withRows([dayRow('2026-11-13', 'm', 5)], '2026-11-14T22:00:00Z')));
		assert.equal((await setup(dir).summary(NOW)).ranges['90d'].totalCost, 8);
	});
});

test('kept hourly rows become one day row with summed cost and tokens', async () => {
	await withTempDir(async (dir) => {
		const bs = setup(dir);
		await bs.ingest(
			postJson(
				withRows(
					[row('2026-09-20T03:00:00Z', 'm', 1), row('2026-09-20T09:00:00Z', 'm', 3)],
					'2026-11-14T10:00:00Z'
				)
			)
		);
		await bs.ingest(postJson(withRows([dayRow('2026-11-13', 'm', 5)], '2026-11-14T22:00:00Z')));
		const stored = JSON.parse(await readFile(join(dir, 'mac.json'), 'utf8')) as UsageSnapshot;
		const [kept] = stored.hourly;
		assert.equal(stored.hourly.length, 2);
		assert.equal(kept.granularity, 'day');
		assert.equal(kept.hour, '2026-09-20T00:00:00.000Z');
		assert.equal(kept.inputTokens, 20);
		assert.equal(kept.costUsd.cacheRead, 2);
	});
});

test('over the row cap the store drops the oldest kept days and warns', async (t) => {
	await withTempDir(async (dir) => {
		const warn = t.mock.method(console, 'warn', () => {});
		const store = fileStore(dir);
		const old = Array.from({ length: 5 }, (_, d) => dayRow(`2026-01-0${d + 1}`, 'm', 1));
		await store.save(withRows(old, '2026-11-14T10:00:00Z'));

		const base = Date.parse('2026-11-13T00:00:00Z');
		const fresh = Array.from({ length: MAX_ROWS - 3 }, (_, i) =>
			row(new Date(base + i * 1000).toISOString(), 'm', 1)
		);
		const result = await store.save(
			withRows(fresh, '2026-11-14T22:00:00Z', { coverageStart: '2026-11-13T00:00:00Z' })
		);
		assert.equal(result, 'stored');

		const stored = JSON.parse(await readFile(join(dir, 'mac.json'), 'utf8'));
		assert.ok(usageSnapshotSchema.safeParse(stored).success);
		assert.equal(stored.hourly.length, MAX_ROWS);
		assert.equal(stored.hourly[0].hour, '2026-01-03T00:00:00Z');
		assert.equal(warn.mock.callCount(), 1);
		assert.match(String(warn.mock.calls[0].arguments[0]), /mac.*2 day/);
	});
});

test('snapshots round-trip through the data dir, atomically', async () => {
	await withTempDir(async (dir) => {
		const bs = setup(dir);
		await bs.ingest(postJson(snapshot('mac', '2026-11-14T22:00:00Z', 8)));
		await bs.ingest(postJson(snapshot('laptop', '2026-11-14T22:00:00Z', 2)));
		assert.deepEqual((await readdir(dir)).sort(), ['laptop.json', 'mac.json']);

		const reopened = setup(dir);
		const s = (await reopened.summary(NOW)).ranges['7d'];
		assert.equal(s.totalCost, 10);
		assert.deepEqual(
			s.devices.map((d) => [d.name, d.cost]),
			[
				['MacBook', 8],
				['Other', 2]
			]
		);
	});
});

test('invalid files on disk are ignored with a warning', async (t) => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, 'mac.json'), JSON.stringify(snapshot('mac')));
		await writeFile(join(dir, 'bad.json'), '{"schemaVersion":1}');
		await writeFile(join(dir, 'broken.json'), 'not json');
		await writeFile(join(dir, 'laptop.json'), JSON.stringify(snapshot('mac')));
		await writeFile(join(dir, 'notes.txt'), 'hello');
		const warn = t.mock.method(console, 'warn', () => {});

		const s = (await setup(dir).summary(NOW)).ranges['7d'];
		assert.equal(s.totalCost, 4);
		assert.equal(warn.mock.callCount(), 3);
	});
});

test('the summary is cached for five minutes and dropped by an ingest', async () => {
	await withTempDir(async (dir) => {
		const bs = setup(dir);
		await bs.ingest(postJson(snapshot('mac', '2026-11-14T22:00:00Z', 4)));
		const first = await bs.summary(NOW);
		assert.equal(await bs.summary(NOW + 4 * 60_000), first);
		assert.notEqual(await bs.summary(NOW + 5 * 60_000), first);

		const cached = await bs.summary(NOW + 6 * 60_000);
		await bs.ingest(postJson(snapshot('laptop', '2026-11-14T22:10:00Z', 6)));
		const fresh = await bs.summary(NOW + 6 * 60_000 + 1);
		assert.notEqual(fresh, cached);
		assert.equal(fresh.ranges['7d'].totalCost, 10);

		await bs.ingest(postJson(snapshot('laptop', '2026-11-14T22:00:00Z', 1)));
		assert.equal(await bs.summary(NOW + 6 * 60_000 + 2), fresh);
	});
});

test('saves that overlap still merge one after another', async () => {
	await withTempDir(async (dir) => {
		const store = fileStore(dir);
		await Promise.all([
			store.save(withRows([dayRow('2026-09-20', 'm', 3)], '2026-11-14T10:00:00Z')),
			store.save(withRows([dayRow('2026-11-13', 'm', 5)], '2026-11-14T22:00:00Z'))
		]);
		const [stored] = await fileStore(dir).list();
		assert.deepEqual(
			stored.hourly.map((r) => r.hour),
			['2026-09-20T00:00:00Z', '2026-11-13T00:00:00Z']
		);
	});
});
