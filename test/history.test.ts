import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeSnapshots } from '../src/history.ts';
import { MAX_ROWS, usageSnapshotSchema, type UsageRow, type UsageSnapshot } from '../src/schema.ts';

const DAY_MS = 86_400_000;

function row(hour: string, model: string, cost: number, extra: Partial<UsageRow> = {}): UsageRow {
	return {
		hour,
		provider: 'claude',
		model,
		sessions: 1,
		inputTokens: 10,
		cacheReadTokens: 1000,
		cacheWrite5mTokens: 0,
		cacheWrite1hTokens: 100,
		outputTokens: 50,
		costUsd: { input: 0, cacheRead: cost / 2, cacheWrite: cost / 4, output: cost / 4 },
		cacheSavingsUsd: 1,
		...extra
	};
}

function snap(hourly: UsageRow[], extra: Partial<UsageSnapshot> = {}): UsageSnapshot {
	return {
		schemaVersion: 1,
		deviceId: 'mac',
		generatedAt: '2026-11-14T22:00:00Z',
		coverageStart: '2026-08-16T00:00:00Z',
		pricingSource: 'litellm@2026-11-14',
		hourly,
		sessionsTotal: 1,
		...extra
	};
}

const total = (s: UsageSnapshot) =>
	s.hourly.reduce((sum, r) => sum + Object.values(r.costUsd).reduce((a, b) => a + b, 0), 0);

test('without a stored snapshot the result is the new one with sorted rows', () => {
	const next = snap([row('2026-11-12T10:00:00Z', 'm', 2), row('2026-11-10T10:00:00Z', 'm', 1)]);
	const { snapshot, droppedDays } = mergeSnapshots(undefined, next);
	assert.equal(droppedDays, 0);
	assert.deepEqual(
		snapshot.hourly.map((r) => r.hour),
		['2026-11-10T10:00:00Z', '2026-11-12T10:00:00Z']
	);
	assert.deepEqual({ ...snapshot, hourly: [] }, { ...next, hourly: [] });
});

test('a stored day the new snapshot does not report is kept', () => {
	const stored = snap([row('2026-09-01T00:00:00Z', 'm', 3, { granularity: 'day' })]);
	const next = snap([row('2026-11-14T00:00:00Z', 'm', 5, { granularity: 'day' })]);
	const { snapshot } = mergeSnapshots(stored, next);
	assert.equal(snapshot.hourly.length, 2);
	assert.equal(total(snapshot), 8);
});

test('a reported day replaces the stored one per provider and model', () => {
	const day = '2026-11-10T00:00:00Z';
	const stored = snap([
		row(day, 'a', 3, { granularity: 'day' }),
		row(day, 'b', 4, { granularity: 'day' }),
		row(day, 'a', 7, { granularity: 'day', provider: 'codex' })
	]);
	const next = snap([row(day, 'a', 1, { granularity: 'day' })]);
	const { snapshot } = mergeSnapshots(stored, next);
	const byKey = Object.fromEntries(
		snapshot.hourly.map((r) => [`${r.provider}/${r.model}`, r.costUsd.cacheRead * 2])
	);
	assert.deepEqual(byKey, { 'claude/a': 1, 'claude/b': 4, 'codex/a': 7 });
});

test('a day that moves from hourly rows to a daily row is not double counted', () => {
	const stored = snap([row('2026-11-10T03:00:00Z', 'm', 2), row('2026-11-10T15:00:00Z', 'm', 2)]);
	const next = snap([row('2026-11-10T00:00:00Z', 'm', 6, { granularity: 'day' })]);
	const { snapshot } = mergeSnapshots(stored, next);
	assert.equal(snapshot.hourly.length, 1);
	assert.equal(total(snapshot), 6);
});

test('a day that moves from a daily row to hourly rows takes the hourly rows', () => {
	const stored = snap([row('2026-11-10T00:00:00Z', 'm', 9, { granularity: 'day' })]);
	const next = snap([row('2026-11-10T03:00:00Z', 'm', 1), row('2026-11-10T15:00:00Z', 'm', 2)]);
	const { snapshot } = mergeSnapshots(stored, next);
	assert.equal(snapshot.hourly.length, 2);
	assert.equal(total(snapshot), 3);
});

test('kept hourly rows roll up into one day row with summed fields', () => {
	const stored = snap([
		row('2026-09-02T03:00:00Z', 'm', 1, { sessions: 2, cacheSavingsUsd: 0.1 }),
		row('2026-09-02T09:00:00Z', 'm', 2, { sessions: 3, cacheSavingsUsd: 0.2 }),
		row('2026-09-02T23:00:00Z', 'm', 4, { sessions: 1, cacheSavingsUsd: 0.3 }),
		row('2026-09-03T01:00:00Z', 'm', 8)
	]);
	const next = snap([row('2026-11-14T00:00:00Z', 'm', 1, { granularity: 'day' })]);
	const { snapshot } = mergeSnapshots(stored, next);
	const [first, second] = snapshot.hourly;
	assert.equal(snapshot.hourly.length, 3);
	assert.equal(first.hour, '2026-09-02T00:00:00.000Z');
	assert.equal(first.granularity, 'day');
	assert.equal(first.sessions, 3);
	assert.equal(first.inputTokens, 30);
	assert.equal(first.cacheReadTokens, 3000);
	assert.equal(first.cacheWrite1hTokens, 300);
	assert.equal(first.outputTokens, 150);
	assert.deepEqual(first.costUsd, { input: 0, cacheRead: 3.5, cacheWrite: 1.75, output: 1.75 });
	assert.equal(first.cacheSavingsUsd, 0.6);
	assert.equal(second.hour, '2026-09-03T00:00:00.000Z');
	assert.equal(second.costUsd.cacheRead, 4);
});

test('a kept single daily row is unchanged', () => {
	const kept = row('2026-09-02T00:00:00Z', 'm', 3, { granularity: 'day', sessions: 4 });
	const next = snap([row('2026-11-14T00:00:00Z', 'm', 1, { granularity: 'day' })]);
	const { snapshot } = mergeSnapshots(snap([kept]), next);
	assert.deepEqual(snapshot.hourly[0], kept);
});

test('metadata comes from the new snapshot and coverageStart is the earlier one', () => {
	const stored = snap([], {
		coverageStart: '2026-06-01T00:00:00Z',
		generatedAt: '2026-11-13T00:00:00Z',
		pricingSource: 'litellm@old',
		sessionsTotal: 99,
		sessionCounts: {
			'7d': { claude: 1, codex: 1, all: 2 },
			'30d': { claude: 1, codex: 1, all: 2 },
			'90d': { claude: 1, codex: 1, all: 2 }
		}
	});
	const next = snap([], { coverageStart: '2026-08-16T00:00:00Z', sessionsTotal: 5 });
	const { snapshot } = mergeSnapshots(stored, next);
	assert.equal(snapshot.coverageStart, '2026-06-01T00:00:00Z');
	assert.equal(snapshot.generatedAt, next.generatedAt);
	assert.equal(snapshot.pricingSource, 'litellm@2026-11-14');
	assert.equal(snapshot.sessionsTotal, 5);
	assert.equal('sessionCounts' in snapshot, false);

	const earlierNext = mergeSnapshots(stored, snap([], { coverageStart: '2026-05-01T00:00:00Z' }));
	assert.equal(earlierNext.snapshot.coverageStart, '2026-05-01T00:00:00Z');
});

test('merging the same snapshot again changes nothing', () => {
	const stored = snap([
		row('2026-09-02T03:00:00Z', 'm', 1),
		row('2026-09-02T09:00:00Z', 'm', 2),
		row('2026-10-01T00:00:00Z', 'n', 3, { granularity: 'day' })
	]);
	const next = snap([
		row('2026-11-14T05:00:00Z', 'm', 1),
		row('2026-11-14T06:00:00Z', 'm', 1),
		row('2026-11-13T00:00:00Z', 'm', 5, { granularity: 'day' })
	]);
	const once = mergeSnapshots(stored, next).snapshot;
	const twice = mergeSnapshots(once, next).snapshot;
	assert.deepEqual(twice, once);
});

test('over the row cap the oldest kept days go and every new row stays', () => {
	const start = Date.parse('2026-01-01T00:00:00Z');
	const storedDays = 10;
	const models = ['a', 'b'];
	const roomForKept = 7;
	const rowsToDrop = storedDays * models.length - roomForKept;
	const daysToDrop = Math.ceil(rowsToDrop / models.length);
	const firstKeptDay = new Date(start + daysToDrop * DAY_MS).toISOString();

	const stored = snap(
		Array.from({ length: storedDays }, (_, d) =>
			models.map((m) => row(new Date(start + d * DAY_MS + 3_600_000).toISOString(), m, 1))
		).flat(),
		{ coverageStart: new Date(start).toISOString() }
	);
	const newDay = start + 100 * DAY_MS;
	const next = snap(
		Array.from({ length: MAX_ROWS - roomForKept }, (_, i) =>
			row(new Date(newDay + i * 1000).toISOString(), 'a', 1)
		),
		{ coverageStart: new Date(newDay).toISOString() }
	);

	const { snapshot, droppedDays } = mergeSnapshots(stored, next);
	assert.equal(droppedDays, daysToDrop);
	assert.equal(
		snapshot.hourly.filter((r) => r.granularity !== 'day').length,
		MAX_ROWS - roomForKept
	);
	assert.equal(
		snapshot.hourly.filter((r) => r.granularity === 'day').length,
		(storedDays - daysToDrop) * models.length
	);
	assert.equal(snapshot.hourly[0].hour, firstKeptDay);
	assert.equal(snapshot.coverageStart, firstKeptDay);
	assert.ok(usageSnapshotSchema.safeParse(snapshot).success);
});
