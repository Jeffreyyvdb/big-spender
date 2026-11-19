// Subscription usage-limit windows: merging them across reports and devices, and the public
// summary. Pure functions (no I/O).
import {
	MAX_LIMIT_WINDOWS,
	PROVIDERS,
	type LimitWindow,
	type UsageProvider,
	type UsageSnapshot
} from './schema.ts';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const RANGE_DAYS = 90;

const minuteOf = (iso: string) => Math.floor(Date.parse(iso) / MINUTE_MS) * MINUTE_MS;
const keyOf = (w: LimitWindow) => `${w.provider}|${w.window}|${minuteOf(w.resetsAt)}`;

/**
 * Merges window lists into one record per window instance, keyed by provider, window and the
 * reset time rounded down to the minute. A key seen twice keeps the highest peak and the
 * earliest hit, so merging is idempotent and one account's window reported by two devices
 * counts once. Sorted by reset time; past the cap the oldest are dropped.
 */
export function mergeLimits(...lists: (LimitWindow[] | undefined)[]): LimitWindow[] {
	const byKey = new Map<string, LimitWindow>();
	for (const w of lists.flatMap((list) => list ?? [])) {
		const key = keyOf(w);
		const prev = byKey.get(key);
		const hits = [prev?.hitAt, w.hitAt].filter((t): t is string => t !== undefined);
		const hitAt = hits.sort((a, b) => Date.parse(a) - Date.parse(b))[0];
		byKey.set(key, {
			provider: w.provider,
			window: w.window,
			resetsAt: new Date(minuteOf(w.resetsAt)).toISOString(),
			peakPercent: Math.max(prev?.peakPercent ?? 0, w.peakPercent),
			...(hitAt ? { hitAt } : {})
		});
	}
	const sorted = [...byKey.values()].sort(
		(a, b) =>
			Date.parse(a.resetsAt) - Date.parse(b.resetsAt) ||
			a.provider.localeCompare(b.provider) ||
			a.window.localeCompare(b.window)
	);
	return sorted.slice(Math.max(0, sorted.length - MAX_LIMIT_WINDOWS));
}

export type LimitsSeries = {
	hits: number[];
	lockedHours: number[];
	peakPercent: (number | null)[];
};

export type LimitWindowSummary = {
	window: string;
	/** Window instances seen in range, after de-duplicating across devices. */
	observed: number;
	/** Instances where a request was blocked. */
	hit: number;
	/** Hours from the first block to the reset, summed over hit instances. */
	lockedHours: number;
	/** UTC day (YYYY-MM-DD) of the latest hit. */
	lastHit: string | null;
	/**
	 * One entry per UTC day from `from` to `to`. An instance belongs to the day of its first
	 * block, or of its reset when it was never blocked; a window still open belongs to today.
	 */
	series: LimitsSeries;
};

export type LimitsSummary = {
	generatedAt: string;
	from: string;
	to: string;
	bucket: 'day';
	providers: { provider: UsageProvider; windows: LimitWindowSummary[] }[];
};

const KNOWN_ORDER = ['five_hour', 'seven_day'];
const rank = (w: string) => {
	const i = KNOWN_ORDER.indexOf(w);
	return i === -1 ? KNOWN_ORDER.length : i;
};
const tenth = (n: number) => Math.round(n * 10) / 10;

/**
 * Limit hits over the last 90 UTC days, ending at the end of today (the 90d range window).
 * Nothing finer than a UTC day is published and no device is named.
 */
export function summarizeLimits(snapshots: UsageSnapshot[], now: number): LimitsSummary {
	const to = Math.floor(now / DAY_MS) * DAY_MS + DAY_MS;
	const from = to - RANGE_DAYS * DAY_MS;
	const windows = mergeLimits(...snapshots.map((s) => s.limits));
	const anchor = (w: LimitWindow) => Math.min(Date.parse(w.hitAt ?? w.resetsAt), now);

	const providers = PROVIDERS.flatMap((provider) => {
		const byWindow = new Map<string, LimitWindow[]>();
		for (const w of windows) {
			if (w.provider !== provider) continue;
			if (anchor(w) < from || anchor(w) >= to) continue;
			byWindow.set(w.window, [...(byWindow.get(w.window) ?? []), w]);
		}
		const summaries = [...byWindow]
			.sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
			.map(([window, list]): LimitWindowSummary => {
				const series: LimitsSeries = {
					hits: Array(RANGE_DAYS).fill(0),
					lockedHours: Array(RANGE_DAYS).fill(0),
					peakPercent: Array(RANGE_DAYS).fill(null)
				};
				let lastHit: number | null = null;
				let hit = 0;
				let locked = 0;
				for (const w of list) {
					const day = Math.floor((anchor(w) - from) / DAY_MS);
					series.peakPercent[day] = Math.max(series.peakPercent[day] ?? 0, w.peakPercent);
					if (!w.hitAt) continue;
					const hours = Math.max(0, Date.parse(w.resetsAt) - Date.parse(w.hitAt)) / HOUR_MS;
					hit++;
					locked += hours;
					series.hits[day]++;
					series.lockedHours[day] += hours;
					lastHit = Math.max(lastHit ?? 0, Date.parse(w.hitAt));
				}
				series.lockedHours = series.lockedHours.map(tenth);
				return {
					window,
					observed: list.length,
					hit,
					lockedHours: tenth(locked),
					lastHit: lastHit === null ? null : new Date(lastHit).toISOString().slice(0, 10),
					series
				};
			});
		return summaries.length ? [{ provider, windows: summaries }] : [];
	});

	return {
		generatedAt: new Date(now).toISOString(),
		from: new Date(from).toISOString(),
		to: new Date(to).toISOString(),
		bucket: 'day',
		providers
	};
}
