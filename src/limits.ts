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
// Reports of one window can put its reset seconds apart, across a minute boundary.
const RESET_SLACK_MS = 2 * MINUTE_MS;

type Tagged = { window: LimitWindow; deviceId?: string };

/**
 * Groups reports into window instances. Reports of one provider and window whose resets are at
 * most RESET_SLACK_MS after the earliest of the cluster (rounded down to the minute) are one
 * instance per account. Each member's `resetsAt` is rounded; the first member of a group carries
 * the earliest.
 */
function groupWindows(items: Tagged[]): Tagged[][] {
	const sorted = items
		.map(({ window: w, deviceId }): Tagged => ({
			window: { ...w, resetsAt: new Date(minuteOf(w.resetsAt)).toISOString() },
			deviceId
		}))
		.sort(
			(a, b) =>
				a.window.provider.localeCompare(b.window.provider) ||
				a.window.window.localeCompare(b.window.window) ||
				Date.parse(a.window.resetsAt) - Date.parse(b.window.resetsAt) ||
				(a.window.account ?? '').localeCompare(b.window.account ?? '')
		);
	const clusters: Tagged[][] = [];
	for (const item of sorted) {
		const cluster = clusters.at(-1);
		const first = cluster?.[0].window;
		if (
			cluster &&
			first &&
			first.provider === item.window.provider &&
			first.window === item.window.window &&
			Date.parse(item.window.resetsAt) - Date.parse(first.resetsAt) <= RESET_SLACK_MS
		) {
			cluster.push(item);
		} else {
			clusters.push([item]);
		}
	}
	return clusters.flatMap(splitByAccount);
}

/**
 * One group per account in a cluster. A report without an account (a log line names none, and
 * older collectors sent none) joins the account whose reset is nearest, so it is never counted
 * as a second instance; with no account in the cluster, those reports are one group.
 */
function splitByAccount(cluster: Tagged[]): Tagged[][] {
	const byAccount = new Map<string, Tagged[]>();
	for (const item of cluster) {
		const { account } = item.window;
		if (account) byAccount.set(account, [...(byAccount.get(account) ?? []), item]);
	}
	if (!byAccount.size) return [cluster];
	const groups = [...byAccount.values()];
	const gap = (group: Tagged[], ms: number) =>
		Math.min(...group.map((m) => Math.abs(Date.parse(m.window.resetsAt) - ms)));
	for (const item of cluster) {
		if (item.window.account) continue;
		const ms = Date.parse(item.window.resetsAt);
		groups.reduce((best, g) => (gap(g, ms) < gap(best, ms) ? g : best)).push(item);
	}
	for (const group of groups) {
		group.sort((a, b) => Date.parse(a.window.resetsAt) - Date.parse(b.window.resetsAt));
	}
	return groups;
}

const accountOf = (group: Tagged[]) => group.find((m) => m.window.account)?.window.account;

const byTime = (a: string, b: string) => Date.parse(a) - Date.parse(b);

/**
 * Merges window lists into one record per window instance (see groupWindows), which keeps the
 * earliest reset. A group keeps the highest peak and the earliest hit, so merging is idempotent
 * and one account's window reported by two devices counts once, while two accounts' windows stay
 * apart. Sorted by reset time; past the cap the oldest are dropped.
 */
export function mergeLimits(...lists: (LimitWindow[] | undefined)[]): LimitWindow[] {
	const groups = groupWindows(lists.flatMap((list) => list ?? []).map((window) => ({ window })));
	const merged = groups.map((group): LimitWindow => {
		const { provider, window, resetsAt } = group[0].window;
		const account = accountOf(group);
		const hitAt = group
			.map((m) => m.window.hitAt)
			.filter((t): t is string => t !== undefined)
			.sort(byTime)[0];
		return {
			provider,
			...(account ? { account } : {}),
			window,
			resetsAt,
			peakPercent: Math.max(...group.map((m) => m.window.peakPercent)),
			...(hitAt ? { hitAt } : {})
		};
	});
	const sorted = merged.sort(
		(a, b) =>
			Date.parse(a.resetsAt) - Date.parse(b.resetsAt) ||
			a.provider.localeCompare(b.provider) ||
			a.window.localeCompare(b.window) ||
			(a.account ?? '').localeCompare(b.account ?? '')
	);
	return sorted.slice(Math.max(0, sorted.length - MAX_LIMIT_WINDOWS));
}

export type LimitHitDevice = { deviceId: string; hitAt: string; peakPercent: number };

export type LimitHit = {
	provider: UsageProvider;
	/** The hashed account, when a report of the instance named one. */
	account?: string;
	window: string;
	/** Earliest reset of the window instance, as mergeLimits keeps it. */
	resetsAt: string;
	/** Earliest hitAt across devices. */
	hitAt: string;
	/** Devices that recorded a hit for this instance, earliest first (ties by deviceId). */
	devices: LimitHitDevice[];
};

export type LimitHitsReport = { generatedAt: string; hits: LimitHit[] };

/**
 * Every recorded limit hit with its exact time and the devices that saw it, earliest device
 * first. Not public: it names devices.
 */
export function limitHits(snapshots: UsageSnapshot[], now: number): LimitHitsReport {
	const groups = groupWindows(
		snapshots.flatMap((s) => (s.limits ?? []).map((window) => ({ window, deviceId: s.deviceId })))
	);
	const hits = groups.flatMap((group): LimitHit[] => {
		const byDevice = new Map<string, LimitHitDevice>();
		for (const { window: w, deviceId } of group) {
			if (!w.hitAt || deviceId === undefined) continue;
			const seen = byDevice.get(deviceId);
			byDevice.set(deviceId, {
				deviceId,
				hitAt: seen && byTime(seen.hitAt, w.hitAt) <= 0 ? seen.hitAt : w.hitAt,
				peakPercent: Math.max(seen?.peakPercent ?? 0, w.peakPercent)
			});
		}
		const devices = [...byDevice.values()].sort(
			(a, b) => byTime(a.hitAt, b.hitAt) || a.deviceId.localeCompare(b.deviceId)
		);
		if (!devices.length) return [];
		const { provider, window, resetsAt } = group[0].window;
		const account = accountOf(group);
		return [
			{
				provider,
				...(account ? { account } : {}),
				window,
				resetsAt,
				hitAt: devices[0].hitAt,
				devices
			}
		];
	});
	hits.sort(
		(a, b) =>
			byTime(a.hitAt, b.hitAt) ||
			a.provider.localeCompare(b.provider) ||
			a.window.localeCompare(b.window) ||
			byTime(a.resetsAt, b.resetsAt) ||
			(a.account ?? '').localeCompare(b.account ?? '')
	);
	return { generatedAt: new Date(now).toISOString(), hits };
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
	/**
	 * Lockouts: instances where a request was blocked. A block before the previous lockout's reset
	 * extends that lockout (the provider moved its reset) instead of counting again.
	 */
	hit: number;
	/** Hours from the first block of each lockout to its last reset. */
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
 * The lockout a hit at hitMs extends: its account's, if still running. A window without an
 * account may be any account's, so it extends the one lockout running then, and an account takes
 * over a running lockout that windows without one started.
 */
function lockoutAt(
	lockouts: Map<string, { day: number; endMs: number }>,
	account: string,
	hitMs: number
) {
	const own = lockouts.get(account);
	if (own && hitMs < own.endMs) return own;
	const running = [...lockouts].filter(
		([key, l]) => key !== account && hitMs < l.endMs && (account === '' || key === '')
	);
	if (running.length !== 1) return undefined;
	const [key, lockout] = running[0];
	if (key === '') {
		lockouts.delete('');
		lockouts.set(account, lockout);
	}
	return lockout;
}

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
				let absorbed = 0;
				// Each account's lockout in progress (key '' for windows without one): its day, and
				// when it ends so far.
				const lockouts = new Map<string, { day: number; endMs: number }>();
				const byHit = list.sort(
					(a, b) => Date.parse(a.hitAt ?? a.resetsAt) - Date.parse(b.hitAt ?? b.resetsAt)
				);
				for (const w of byHit) {
					const day = Math.floor((anchor(w) - from) / DAY_MS);
					series.peakPercent[day] = Math.max(series.peakPercent[day] ?? 0, w.peakPercent);
					if (!w.hitAt) continue;
					const hitMs = Date.parse(w.hitAt);
					const resetMs = Date.parse(w.resetsAt);
					lastHit = Math.max(lastHit ?? 0, hitMs);
					// A provider can move the reset of a window while it is blocked (Claude does: a
					// refusal at 20:46 said 00:20, one at 22:23 said 01:40). A hit before the current
					// lockout ends is that lockout running longer, not a second one.
					const lockout = lockoutAt(lockouts, w.account ?? '', hitMs);
					if (lockout) {
						absorbed++;
						const extra = Math.max(0, resetMs - lockout.endMs) / HOUR_MS;
						lockout.endMs = Math.max(lockout.endMs, resetMs);
						locked += extra;
						series.lockedHours[lockout.day] += extra;
						continue;
					}
					const hours = Math.max(0, resetMs - hitMs) / HOUR_MS;
					lockouts.set(w.account ?? '', { day, endMs: resetMs });
					hit++;
					locked += hours;
					series.hits[day]++;
					series.lockedHours[day] += hours;
				}
				series.lockedHours = series.lockedHours.map(tenth);
				return {
					window,
					observed: list.length - absorbed,
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
