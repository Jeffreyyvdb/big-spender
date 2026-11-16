import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../src/summary.ts';
import type { DeviceConfig } from '../src/devices.ts';
import { usageSnapshotSchema, type UsageRow, type UsageSnapshot } from '../src/schema.ts';

const NOW = Date.parse('2026-11-14T22:30:00Z');

const CONFIG: DeviceConfig = {
	devices: {
		mac: { name: 'MacBook', color: '#7fa034' },
		'vps-01': { name: 'VPS', color: '#3899e2' },
		desktop: { name: 'Home agent', color: '#d77343' },
		'laptop-2': { name: 'MacBook 2', color: '#a03fa7' }
	},
	unknownDevices: 'other'
};

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

function snap(deviceId: string, hourly: UsageRow[], sessions24h: number): UsageSnapshot {
	const c = { claude: sessions24h, codex: 0, all: sessions24h };
	return {
		schemaVersion: 1,
		deviceId,
		generatedAt: '2026-11-14T22:00:00Z',
		coverageStart: '2026-08-16T00:00:00Z',
		pricingSource: 'litellm@2026-11-14',
		hourly,
		sessionsTotal: 10,
		sessionCounts: { '24h': c, '7d': c, '30d': c, '90d': c }
	};
}

test('merges devices: matching hours and models add up', () => {
	const mac = snap('mac', [row('2026-11-14T21:00:00Z', 'claude-opus-5-5', 8)], 3);
	const desktop = snap(
		'desktop',
		[
			row('2026-11-14T21:00:00Z', 'claude-opus-5-5', 4),
			row('2026-11-14T22:00:00Z', 'claude-sonnet-5-5', 4)
		],
		2
	);
	const s = summarize([mac, desktop], NOW, CONFIG).ranges['7d'];

	assert.equal(s.totalCost, 16);
	assert.equal(s.sessions, 5);
	assert.equal(s.series.length, 7);
	assert.equal(s.series.at(-1)?.start, '2026-11-14T00:00:00.000Z');
	assert.equal(s.series.at(-1)?.cost, 16);
	assert.deepEqual(
		s.models.map((m) => [m.model, m.cost, m.share]),
		[
			['claude-opus-5-5', 12, 0.75],
			['claude-sonnet-5-5', 4, 0.25]
		]
	);
	assert.equal(s.tokens.cachedInput, 3000);
	assert.equal(s.tokens.processed, 3 * 1160);
	assert.equal(s.cacheSavings, 3);
	assert.deepEqual(
		s.devices.map((d) => [d.name, d.cost]),
		[
			['MacBook', 8],
			['Home agent', 8]
		]
	);
	assert.equal(s.devices[1].series.at(-1), 8);
});

test('device ids never reach the summary; unknown devices merge into "Other"', () => {
	const a = snap('some-hostname', [row('2026-11-14T21:00:00Z', 'claude-opus-5-5', 2)], 1);
	const b = snap('another-box', [row('2026-11-14T21:00:00Z', 'claude-opus-5-5', 3)], 1);
	const vps = snap('vps-01', [row('2026-11-14T22:00:00Z', 'claude-opus-5-5', 1)], 1);
	const s = summarize([a, b, vps], NOW, CONFIG).ranges['7d'];
	assert.deepEqual(
		s.devices.map((d) => [d.name, d.cost]),
		[
			['VPS', 1],
			['Other', 5]
		]
	);
	assert.doesNotMatch(JSON.stringify(s), /some-hostname|another-box|vps-01/);
});

test('device report times never reach the summary', () => {
	const mac = snap('mac', [row('2026-11-14T21:00:00Z', 'claude-opus-5-5', 2)], 1);
	mac.generatedAt = '2026-11-14T21:37:12Z';
	const s = summarize([mac], NOW, CONFIG);
	assert.doesNotMatch(JSON.stringify(s), /21:37/);
	for (const d of s.ranges['7d'].devices) assert.equal('generatedAt' in d, false);
});

test('range windows: every range is bucketed by UTC day, never by hour', () => {
	const device = snap(
		'mac',
		[
			row('2026-11-13T22:00:00Z', 'claude-opus-5-5', 1),
			row('2026-11-13T23:00:00Z', 'claude-opus-5-5', 2), // same day: merges with the row above
			row('2026-10-20T00:00:00Z', 'claude-opus-5-5', 5, { granularity: 'day' }),
			row('2026-08-01T00:00:00Z', 'claude-opus-5-5', 7, { granularity: 'day' }) // > 90d
		],
		1
	);
	const r = summarize([device], NOW, CONFIG).ranges;

	assert.deepEqual(Object.keys(r), ['7d', '30d', '90d']);
	for (const range of Object.values(r)) {
		for (const p of range.series) assert.match(p.start, /T00:00:00\.000Z$/);
	}
	assert.equal(r['7d'].totalCost, 3);
	assert.equal(r['7d'].series.at(-2)?.cost, 3);
	assert.equal(r['30d'].totalCost, 8);
	assert.equal(r['30d'].series.length, 30);
	assert.equal(r['30d'].series.find((p) => p.start.startsWith('2026-10-20'))?.cost, 5);
	assert.equal(r['90d'].totalCost, 8);
});

test('no devices gives an empty, zeroed summary', () => {
	const s = summarize([], NOW, CONFIG).ranges['7d'];
	assert.equal(s.totalCost, 0);
	assert.equal(s.series.length, 7);
	assert.deepEqual(s.models, []);
});

test('schema rejects anything beyond numbers, models, timestamps and device id', () => {
	const ok = snap('mac', [row('2026-11-14T21:00:00Z', 'claude-opus-5-5', 1)], 1);
	assert.equal(usageSnapshotSchema.safeParse(ok).success, true);

	const withPath = { ...ok, cwd: '/home/me/secret-project' };
	assert.equal(usageSnapshotSchema.safeParse(withPath).success, false);

	const rowWithSession = { ...ok, hourly: [{ ...ok.hourly[0], sessionId: 'abc' }] };
	assert.equal(usageSnapshotSchema.safeParse(rowWithSession).success, false);

	const badModel = { ...ok, hourly: [{ ...ok.hourly[0], model: 'see /home/me <prompt>' }] };
	assert.equal(usageSnapshotSchema.safeParse(badModel).success, false);

	assert.equal(usageSnapshotSchema.safeParse({ ...ok, deviceId: '../etc' }).success, false);
});

test('an offline device adds no sessions to a range it has no usage in', () => {
	const online = snap('desktop', [row('2026-11-14T21:00:00Z', 'claude-opus-5-5', 1)], 4);
	// No usage in the past 7 days: its 7d session count is stale.
	const offline = snap('mac', [row('2026-10-20T10:00:00Z', 'claude-opus-5-5', 1)], 3);
	const r = summarize([online, offline], NOW, CONFIG).ranges;
	assert.equal(r['7d'].sessions, 4);
	assert.equal(r['7d'].providers[0].sessions, 4);
	assert.equal(r['30d'].sessions, 7);
});

test('providers carry daily series and token shares for the comparison chart', () => {
	const mac = snap(
		'mac',
		[
			row('2026-11-14T21:00:00Z', 'claude-opus-5-5', 9),
			row('2026-11-13T10:00:00Z', 'gpt-6.1-sol', 1, {
				provider: 'codex',
				cacheReadTokens: 3000,
				cacheWrite1hTokens: 0
			})
		],
		1
	);
	const s = summarize([mac], NOW, CONFIG).ranges['7d'];
	const [claude, codex] = s.providers;

	assert.deepEqual(
		s.providers.map((p) => p.provider),
		['claude', 'codex']
	);
	assert.equal(claude.share, 0.9);
	assert.equal(codex.tokens, 3060);
	assert.equal(codex.tokenShare, 3060 / (1160 + 3060));
	assert.equal(claude.series.cost.length, 7);
	assert.equal(claude.series.cost.at(-1), 9);
	assert.equal(codex.series.cost.at(-2), 1);
	assert.equal(codex.series.tokens.at(-1), 0);
	// Per-provider days add up to the range's daily totals.
	s.series.forEach((p, i) => assert.equal(claude.series.cost[i] + codex.series.cost[i], p.cost));
	assert.equal(s.models.find((m) => m.model === 'gpt-6.1-sol')?.tokenShare, codex.tokenShare);
});

test('by-id mode: unlisted devices show under their id with a free palette colour', () => {
	const config = {
		devices: { desk: { name: 'Desktop', color: '#3899e2' } },
		unknownDevices: 'by-id' as const
	};
	const devices = [
		snap('laptop', [row('2026-11-14T21:00:00Z', 'claude-opus-5-5', 5)], 1),
		snap('desk', [row('2026-11-14T21:00:00Z', 'claude-opus-5-5', 1)], 1),
		snap('build-box', [row('2026-11-14T21:00:00Z', 'claude-opus-5-5', 2)], 1)
	];
	const s = summarize(devices, NOW, config).ranges['7d'];
	// Listed devices first, in config order, then unlisted ones by id.
	assert.deepEqual(
		s.devices.map((d) => [d.name, d.color, d.cost]),
		[
			['Desktop', '#3899e2', 1],
			['build-box', '#7fa034', 2],
			['laptop', '#d77343', 5]
		]
	);
});

test('a device keeps its colour in every range, even with no usage in that range', () => {
	const config = { devices: {} };
	const old = snap('aaa', [row('2026-10-20T10:00:00Z', 'claude-opus-5-5', 1)], 1);
	const recent = snap('bbb', [row('2026-11-14T21:00:00Z', 'claude-opus-5-5', 1)], 1);
	const r = summarize([old, recent], NOW, config).ranges;
	const color = (range: '7d' | '30d', name: string) =>
		r[range].devices.find((d) => d.name === name)?.color;
	assert.equal(color('7d', 'bbb'), color('30d', 'bbb'));
});

test('schema accepts snapshots without the old 24h session count', () => {
	const s = snap('mac', [row('2026-11-14T21:00:00Z', 'claude-opus-5-5', 1)], 1);
	const counts: Record<string, unknown> = { ...s.sessionCounts };
	delete counts['24h'];
	assert.equal(usageSnapshotSchema.safeParse({ ...s, sessionCounts: counts }).success, true);
});

test('a device id that matches an Object property is still an unlisted device', () => {
	const s = summarize(
		[snap('constructor', [row('2026-11-14T21:00:00Z', 'claude-opus-5-5', 1)], 1)],
		NOW,
		CONFIG
	);
	assert.deepEqual(
		s.ranges['7d'].devices.map((d) => [d.name, d.cost]),
		[['Other', 1]]
	);
});
