import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mergeSnapshots } from '../src/history.ts';
import { mergeLimits } from '../src/limits.ts';
import {
	MAX_LIMIT_WINDOWS,
	usageSnapshotSchema,
	type LimitWindow,
	type UsageSnapshot
} from '../src/schema.ts';
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

test('windows with different providers, names or reset minutes stay apart', () => {
	const merged = mergeLimits([
		win(),
		win({ provider: 'codex' }),
		win({ window: 'seven_day' }),
		win({ resetsAt: '2026-11-14T20:01:00.000Z' })
	]);
	assert.equal(merged.length, 4);
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
		win({ resetsAt: new Date(Date.parse('2026-01-01T00:00:00Z') + i * 60_000).toISOString() })
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
