import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { mergeSnapshots } from '../src/history.ts';
import { mergeLimits } from '../src/limits.ts';
import {
	MAX_LIMIT_WINDOWS,
	usageSnapshotSchema,
	type LimitWindow,
	type UsageSnapshot
} from '../src/schema.ts';
import { createHttpServer } from '../src/serve.ts';
import { createBigSpender } from '../src/server/index.ts';
import { snapshot, withTempDir } from './helpers.ts';

const TOKEN = 'secret-token';
const DEVICES = { devices: {}, unknownDevices: 'by-id' as const };

const win = (extra: Partial<LimitWindow> = {}): LimitWindow => ({
	provider: 'claude',
	window: 'five_hour',
	resetsAt: '2026-11-14T20:00:00.000Z',
	peakPercent: 100,
	hitAt: '2026-11-14T17:30:00.000Z',
	...extra
});

const withLimits = (
	deviceId: string,
	limits: LimitWindow[],
	generatedAt?: string
): UsageSnapshot => ({
	...snapshot(deviceId, generatedAt),
	limits
});

const ingest = (bs: ReturnType<typeof createBigSpender>, body: unknown) =>
	bs.ingest(
		new Request('http://localhost/api/usage/ingest', {
			method: 'POST',
			headers: { authorization: `Bearer ${TOKEN}` },
			body: JSON.stringify(body)
		})
	);

test('a snapshot without limits still validates and stores no limits key', () => {
	assert.ok(usageSnapshotSchema.safeParse(snapshot('mac')).success);
	const { snapshot: merged } = mergeSnapshots(undefined, snapshot('mac'));
	assert.equal('limits' in merged, false);
});

test('merging keeps the highest peak and earliest hit, and is idempotent', () => {
	const a = win({ peakPercent: 80, hitAt: undefined, resetsAt: '2026-11-14T20:00:10.000Z' });
	const b = win({ resetsAt: '2026-11-14T20:00:40.000Z' });
	const c = win({ peakPercent: 100, hitAt: '2026-11-14T17:10:00.000Z' });
	const merged = mergeLimits([a], [b], [c]);
	assert.deepEqual(merged, [win({ hitAt: '2026-11-14T17:10:00.000Z' })]);
	assert.deepEqual(mergeLimits(merged, merged, [a, b, c]), merged);
});

test('windows with different providers, names or resets more than two minutes apart stay apart', () => {
	const merged = mergeLimits([
		win(),
		win({ provider: 'codex' }),
		win({ window: 'seven_day' }),
		win({ resetsAt: '2026-11-14T20:03:00.000Z' })
	]);
	assert.equal(merged.length, 4);
});

test('reports of one window whose reset crosses a minute boundary merge into the earlier reset', () => {
	const early = win({ resetsAt: '2026-11-14T19:59:59.000Z', hitAt: '2026-11-14T17:40:00.000Z' });
	const late = win({ resetsAt: '2026-11-14T20:00:01.000Z' });
	const expected = [win({ resetsAt: '2026-11-14T19:59:00.000Z' })];
	assert.deepEqual(mergeLimits([late], [early]), expected);
	assert.deepEqual(mergeLimits(expected, [early, late]), expected);
});

test('the stored history keeps windows the new snapshot no longer reports', () => {
	const old = win({ resetsAt: '2026-10-01T10:00:00.000Z', hitAt: '2026-10-01T08:00:00.000Z' });
	const current = win();
	const { snapshot: merged } = mergeSnapshots(
		withLimits('mac', [old]),
		withLimits('mac', [current])
	);
	assert.deepEqual(merged.limits, [old, current]);
	const { snapshot: plain } = mergeSnapshots(withLimits('mac', [old]), snapshot('mac'));
	assert.deepEqual(plain.limits, [old]);
});

test('past the cap the oldest windows are dropped', () => {
	const many = Array.from({ length: MAX_LIMIT_WINDOWS + 3 }, (_, i) =>
		win({ resetsAt: new Date(Date.parse('2026-01-01T00:00:00Z') + i * 600_000).toISOString() })
	);
	const merged = mergeLimits(many);
	assert.equal(merged.length, MAX_LIMIT_WINDOWS);
	assert.equal(merged[0].resetsAt, many[3].resetsAt);
});

test('ingest stores limits and merges a later report of the same window', async () => {
	await withTempDir(async (dir) => {
		const bs = createBigSpender({ dataDir: dir, ingestToken: TOKEN, devices: DEVICES });
		const first = await ingest(bs, withLimits('mac', [win({ peakPercent: 70, hitAt: undefined })]));
		assert.equal(first.status, 200);
		const second = await ingest(bs, withLimits('mac', [win()], '2026-11-14T23:00:00Z'));
		assert.equal(second.status, 200);
		const stored = JSON.parse(await readFile(join(dir, 'mac.json'), 'utf8')) as UsageSnapshot;
		assert.deepEqual(stored.limits, [win()]);
	});
});

test('a server rejects an unknown key inside a window', async () => {
	await withTempDir(async (dir) => {
		const bs = createBigSpender({ dataDir: dir, ingestToken: TOKEN, devices: DEVICES });
		const res = await ingest(bs, withLimits('mac', [{ ...win(), extra: 1 } as LimitWindow]));
		assert.equal(res.status, 422);
	});
});

const NOW = Date.parse('2026-11-14T22:30:00Z');
const DAY = 86_400_000;

async function limitsOf(windows: Record<string, LimitWindow[]>, now = NOW) {
	return withTempDir(async (dir) => {
		const bs = createBigSpender({ dataDir: dir, ingestToken: TOKEN, devices: DEVICES });
		for (const [device, limits] of Object.entries(windows)) {
			assert.equal((await ingest(bs, withLimits(device, limits))).status, 200);
		}
		return { limits: await bs.limits(now), summary: await bs.summary(now) };
	});
}

test('limits() counts a window reported by two devices once and attributes it to its day', async () => {
	const hit = win({ hitAt: '2026-11-14T17:30:00.000Z', resetsAt: '2026-11-14T20:00:00.000Z' });
	const { limits } = await limitsOf({
		mac: [hit, win({ resetsAt: '2026-11-13T12:00:00.000Z', hitAt: undefined, peakPercent: 40 })],
		pc: [{ ...hit, resetsAt: '2026-11-14T20:00:30.000Z' }]
	});
	assert.equal(limits.bucket, 'day');
	assert.equal(limits.to, '2026-11-15T00:00:00.000Z');
	assert.equal(Date.parse(limits.to) - Date.parse(limits.from), 90 * DAY);
	assert.deepEqual(
		limits.providers.map((p) => p.provider),
		['claude']
	);
	const [w] = limits.providers[0].windows;
	assert.equal(w.window, 'five_hour');
	assert.equal(w.observed, 2);
	assert.equal(w.hit, 1);
	assert.equal(w.lockedHours, 2.5);
	assert.equal(w.lastHit, '2026-11-14');
	assert.equal(w.series.hits.length, 90);
	assert.deepEqual(w.series.hits.slice(-3), [0, 0, 1]);
	assert.deepEqual(w.series.lockedHours.slice(-3), [0, 0, 2.5]);
	assert.deepEqual(w.series.peakPercent.slice(-3), [null, 40, 100]);
	assert.ok(w.series.peakPercent.slice(0, -2).every((p) => p === null));
});

test('limits() shows a window that resets after today on today, with its peak so far', async () => {
	const { limits } = await limitsOf({
		mac: [
			win({
				window: 'seven_day',
				resetsAt: '2026-11-19T07:16:00.000Z',
				hitAt: undefined,
				peakPercent: 66
			})
		]
	});
	const [w] = limits.providers[0].windows;
	assert.equal(w.observed, 1);
	assert.equal(w.hit, 0);
	assert.deepEqual(w.series.peakPercent.slice(-2), [null, 66]);
});

test('limits() leaves out windows older than 90 days and the public summary is unchanged', async () => {
	const old = win({ resetsAt: '2026-06-01T00:00:00.000Z', hitAt: '2026-06-01T00:00:00.000Z' });
	const withWindows = await limitsOf({ mac: [old, win()] });
	assert.equal(withWindows.limits.providers[0].windows[0].observed, 1);
	const without = await limitsOf({ mac: [] });
	assert.deepEqual(without.limits.providers, []);
	assert.deepEqual(withWindows.summary, without.summary);
});

test('GET /api/usage/limits answers JSON', async () => {
	await withTempDir(async (dir) => {
		const bs = createBigSpender({ dataDir: dir, ingestToken: TOKEN, devices: DEVICES });
		// No hit: an unhit window counts on its reset day, so this one stays in range whenever it runs.
		await ingest(
			bs,
			withLimits('mac', [win({ resetsAt: new Date().toISOString(), hitAt: undefined })])
		);
		const server = createHttpServer(bs);
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		try {
			const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
			const res = await fetch(`${base}/api/usage/limits`);
			assert.equal(res.status, 200);
			assert.match(res.headers.get('cache-control') ?? '', /max-age=300/);
			const body = (await res.json()) as { providers: { windows: { window: string }[] }[] };
			assert.equal(body.providers[0].windows[0].window, 'five_hour');
			assert.equal(JSON.stringify(body).includes('"mac"'), false);
			const page = await (await fetch(base)).text();
			assert.match(page, /Usage limits/);
			assert.match(page, /5-hour session/);
		} finally {
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		}
	});
});
