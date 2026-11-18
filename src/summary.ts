// Merges device snapshots and works out the totals for each range.
// Pure functions (no I/O) so they can be tested in isolation.
import type { UsageProvider, UsageRange, UsageRow, UsageSnapshot } from './schema.ts';
import { resolveDevices, type DeviceConfig, type ResolvedDevice } from './devices.ts';

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
// 1970-01-01 was a Thursday, so ISO weeks (Monday 00:00 UTC) start 4 days after a multiple of WEEK_MS.
const MONDAY_OFFSET_MS = 4 * DAY_MS;

export type Bucket = 'day' | 'week';

export type CostByType = { input: number; cacheRead: number; cacheWrite: number; output: number };

export type SeriesPoint = { start: string; cost: number; tokens: number };

export type ModelLine = {
	provider: UsageProvider;
	model: string;
	cost: number;
	/** Share of the range's cost. */
	share: number;
	tokens: number;
	/** Share of the range's processed tokens. */
	tokenShare: number;
};

export type ProviderLine = {
	provider: UsageProvider;
	cost: number;
	/** Share of the range's cost. */
	share: number;
	tokens: number;
	/** Share of the range's processed tokens. */
	tokenShare: number;
	/** Distinct sessions; null for `all`, which collectors send no count for. */
	sessions: number | null;
	/** Cost and tokens per point, aligned with the range's `series`. */
	series: { cost: number[]; tokens: number[] };
};

/**
 * One machine, under its public name (never the raw device id). Deliberately carries no
 * report time: per-device timestamps would show when each machine is online.
 */
export type DeviceLine = {
	name: string;
	color: string;
	coverageStart: string;
	pricingSource: string;
	cost: number;
	/** Cost per point, aligned with the range's `series`. */
	series: number[];
};

export type RangeSummary = {
	range: UsageRange;
	from: string;
	to: string;
	/** What one point of every series covers: a UTC day, or an ISO week starting Monday UTC. */
	bucket: Bucket;
	totalCost: number;
	/**
	 * Distinct sessions. Null for `all`: session ids never leave the device, and collectors
	 * only count sessions for 7d, 30d and 90d.
	 */
	sessions: number | null;
	tokens: {
		processed: number;
		cachedInput: number;
		uncachedInput: number;
		cacheWrite: number;
		output: number;
	};
	cacheSavings: number;
	costByType: CostByType;
	providers: ProviderLine[];
	models: ModelLine[];
	devices: DeviceLine[];
	series: SeriesPoint[];
};

export type UsageSummary = {
	generatedAt: string;
	ranges: Record<UsageRange, RangeSummary>;
};

type Window = { from: number; to: number; step: number; points: number; bucket: Bucket };

const mondayOnOrBefore = (t: number) =>
	Math.floor((t - MONDAY_OFFSET_MS) / WEEK_MS) * WEEK_MS + MONDAY_OFFSET_MS;

/**
 * Range windows end at the end of the current UTC day. 7d, 30d and 90d are bucketed by day;
 * `all` starts on the Monday on or before the oldest stored usage and is bucketed by ISO week,
 * so its last point may be a partial week. Never by hour: an hourly breakdown per device would
 * show when each machine is in use.
 */
export function rangeWindow(range: UsageRange, now: number, snapshots: UsageSnapshot[]): Window {
	const to = Math.floor(now / DAY_MS) * DAY_MS + DAY_MS;
	if (range !== 'all') {
		const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
		return { from: to - days * DAY_MS, to, step: DAY_MS, points: days, bucket: 'day' };
	}
	let earliest = to - DAY_MS;
	for (const snap of snapshots) {
		earliest = Math.min(earliest, Date.parse(snap.coverageStart));
		for (const r of snap.hourly) earliest = Math.min(earliest, Date.parse(r.hour));
	}
	const from = mondayOnOrBefore(earliest);
	return { from, to, step: WEEK_MS, points: Math.ceil((to - from) / WEEK_MS), bucket: 'week' };
}

const rowCost = (r: UsageRow) =>
	r.costUsd.input + r.costUsd.cacheRead + r.costUsd.cacheWrite + r.costUsd.output;

const rowTokens = (r: UsageRow) =>
	r.inputTokens + r.cacheReadTokens + r.cacheWrite5mTokens + r.cacheWrite1hTokens + r.outputTokens;

function summarizeRange(
	range: UsageRange,
	snapshots: UsageSnapshot[],
	now: number,
	resolved: Map<string, ResolvedDevice>
): RangeSummary {
	const w = rangeWindow(range, now, snapshots);
	const series: SeriesPoint[] = Array.from({ length: w.points }, (_, i) => ({
		start: new Date(w.from + i * w.step).toISOString(),
		cost: 0,
		tokens: 0
	}));
	const costByType: CostByType = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
	const tokens = { processed: 0, cachedInput: 0, uncachedInput: 0, cacheWrite: 0, output: 0 };
	const models = new Map<string, ModelLine>();
	const providers = new Map<UsageProvider, ProviderLine>();
	const devices = new Map<string, DeviceLine>();
	let cacheSavings = 0;
	const countsSessions = range !== 'all';
	let sessions = 0;

	const provider = (id: UsageProvider): ProviderLine => {
		let p = providers.get(id);
		if (!p) {
			p = {
				provider: id,
				cost: 0,
				share: 0,
				tokens: 0,
				tokenShare: 0,
				sessions: countsSessions ? 0 : null,
				series: {
					cost: new Array<number>(w.points).fill(0),
					tokens: new Array<number>(w.points).fill(0)
				}
			};
			providers.set(id, p);
		}
		return p;
	};

	for (const snap of snapshots) {
		const { name, color } = resolved.get(snap.deviceId)!;
		const device = devices.get(name) ?? {
			name,
			color,
			coverageStart: snap.coverageStart,
			pricingSource: snap.pricingSource,
			cost: 0,
			series: new Array<number>(w.points).fill(0)
		};
		devices.set(name, device);
		const active = new Set<UsageProvider>();
		const counts = range === 'all' ? undefined : snap.sessionCounts?.[range];

		for (const r of snap.hourly) {
			const start = Date.parse(r.hour);
			if (start < w.from || start >= w.to) continue;
			const cost = rowCost(r);
			const tok = rowTokens(r);
			if (tok > 0) active.add(r.provider);
			const idx = Math.floor((start - w.from) / w.step);
			device.cost += cost;
			device.series[idx] += cost;
			series[idx].cost += cost;
			series[idx].tokens += tok;
			costByType.input += r.costUsd.input;
			costByType.cacheRead += r.costUsd.cacheRead;
			costByType.cacheWrite += r.costUsd.cacheWrite;
			costByType.output += r.costUsd.output;
			tokens.processed += tok;
			tokens.cachedInput += r.cacheReadTokens;
			tokens.uncachedInput += r.inputTokens;
			tokens.cacheWrite += r.cacheWrite5mTokens + r.cacheWrite1hTokens;
			tokens.output += r.outputTokens;
			cacheSavings += r.cacheSavingsUsd;

			const mKey = `${r.provider}|${r.model}`;
			const m = models.get(mKey) ?? {
				provider: r.provider,
				model: r.model,
				cost: 0,
				share: 0,
				tokens: 0,
				tokenShare: 0
			};
			m.cost += cost;
			m.tokens += tok;
			models.set(mKey, m);

			const p = provider(r.provider);
			p.cost += cost;
			p.tokens += tok;
			p.series.cost[idx] += cost;
			p.series.tokens[idx] += tok;
		}

		// Session counts are relative to the device's last report. Only count a provider
		// that has usage inside this window, so an offline device's old sessions drop out.
		if (counts) {
			for (const id of active) {
				if (!counts[id]) continue;
				sessions += counts[id];
				provider(id).sessions! += counts[id];
			}
		}
	}

	const totalCost =
		costByType.input + costByType.cacheRead + costByType.cacheWrite + costByType.output;
	const share = (c: number) => (totalCost > 0 ? c / totalCost : 0);
	const tokenShare = (t: number) => (tokens.processed > 0 ? t / tokens.processed : 0);
	const byCost = <T extends { cost: number; tokens: number }>(a: T, b: T) =>
		b.cost - a.cost || b.tokens - a.tokens;
	const order = new Map<string, number>();
	for (const d of resolved.values())
		order.set(d.name, Math.min(order.get(d.name) ?? d.order, d.order));

	return {
		range,
		from: new Date(w.from).toISOString(),
		to: new Date(w.to).toISOString(),
		bucket: w.bucket,
		totalCost,
		sessions: countsSessions ? sessions : null,
		tokens,
		cacheSavings,
		costByType,
		providers: [...providers.values()]
			.filter((p) => p.cost > 0 || p.tokens > 0 || (p.sessions ?? 0) > 0)
			.map((p) => ({ ...p, share: share(p.cost), tokenShare: tokenShare(p.tokens) }))
			.sort(byCost),
		models: [...models.values()]
			.map((m) => ({ ...m, share: share(m.cost), tokenShare: tokenShare(m.tokens) }))
			.sort(byCost),
		devices: [...devices.values()].sort((a, b) => order.get(a.name)! - order.get(b.name)!),
		series
	};
}

export function summarize(
	snapshots: UsageSnapshot[],
	now: number,
	config: DeviceConfig
): UsageSummary {
	// Resolved once over every device, so a device keeps its name and colour in every range.
	const resolved = resolveDevices(
		snapshots.map((s) => s.deviceId),
		config
	);
	return {
		generatedAt: new Date(now).toISOString(),
		ranges: {
			'7d': summarizeRange('7d', snapshots, now, resolved),
			'30d': summarizeRange('30d', snapshots, now, resolved),
			'90d': summarizeRange('90d', snapshots, now, resolved),
			all: summarizeRange('all', snapshots, now, resolved)
		}
	};
}
