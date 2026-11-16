import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createBigSpender } from '../src/server/index.ts';
import type { DeviceConfig } from '../src/devices.ts';
import { snapshot, withTempDir } from './helpers.ts';

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
