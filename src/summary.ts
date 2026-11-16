// Merges device snapshots and works out the totals for each range.
// Pure functions (no I/O) so they can be tested in isolation.
import type { UsageProvider, UsageRange, UsageRow, UsageSnapshot } from './schema.ts';
import { resolveDevices, type DeviceConfig, type ResolvedDevice } from './devices.ts';

const DAY_MS = 86_400_000;

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
	sessions: number;
	/** Cost and tokens per UTC day, aligned with the range's `series`. */
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
	totalCost: number;
	sessions: number;
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

type Window = { from: number; to: number; points: number };

/**
 * Range windows end at the end of the current UTC day and are bucketed by day. Never by hour:
 * an hourly breakdown per device would show when each machine is in use.
 */
export function rangeWindow(range: UsageRange, now: number): Window {
	const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
	const to = Math.floor(now / DAY_MS) * DAY_MS + DAY_MS;
	return { from: to - days * DAY_MS, to, points: days };
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
	const w = rangeWindow(range, now);
	const series: SeriesPoint[] = Array.from({ length: w.points }, (_, i) => ({
		start: new Date(w.from + i * DAY_MS).toISOString(),
		cost: 0,
		tokens: 0
	}));
	const costByType: CostByType = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
	const tokens = { processed: 0, cachedInput: 0, uncachedInput: 0, cacheWrite: 0, output: 0 };
	const models = new Map<string, ModelLine>();
	const providers = new Map<UsageProvider, ProviderLine>();
	const devices = new Map<string, DeviceLine>();
	let cacheSavings = 0;
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
				sessions: 0,
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
		const counts = snap.sessionCounts?.[range];

		for (const r of snap.hourly) {
			const start = Date.parse(r.hour);
			if (start < w.from || start >= w.to) continue;
			const cost = rowCost(r);
			const tok = rowTokens(r);
			if (tok > 0) active.add(r.provider);
			const idx = Math.floor((start - w.from) / DAY_MS);
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
				provider(id).sessions += counts[id];
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
		totalCost,
		sessions,
		tokens,
		cacheSavings,
		costByType,
		providers: [...providers.values()]
			.filter((p) => p.cost > 0 || p.tokens > 0 || p.sessions > 0)
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
			'90d': summarizeRange('90d', snapshots, now, resolved)
		}
	};
}
