import type { DeviceConfig } from '../devices.ts';
import { fileStore } from '../store.ts';
import { summarizeLimits, type LimitsSummary } from '../limits.ts';
import { summarize, type UsageSummary } from '../summary.ts';
import { createIngest } from './ingest.ts';

export {
	DEVICE_ID,
	MAX_LIMIT_WINDOWS,
	PROVIDERS,
	RANGES,
	limitWindowSchema,
	usageRowSchema,
	usageSnapshotSchema,
	type LimitWindow,
	type UsageProvider,
	type UsageRange,
	type UsageRow,
	type UsageSnapshot
} from '../schema.ts';
export {
	summarizeLimits,
	type LimitsSeries,
	type LimitsSummary,
	type LimitWindowSummary
} from '../limits.ts';
export { OTHER, PALETTE, resolveDevices, type DeviceConfig, type DeviceInfo } from '../devices.ts';
export {
	summarize,
	type Bucket,
	type CostByType,
	type DeviceLine,
	type ModelLine,
	type ProviderLine,
	type RangeSummary,
	type SeriesPoint,
	type UsageSummary
} from '../summary.ts';

const SUMMARY_TTL_MS = 5 * 60 * 1000;

export type BigSpenderOptions = {
	/** Directory for the per-device snapshot files. Use a persistent volume. */
	dataDir: string;
	/** Bearer token collectors must send. Missing or empty turns ingest off (503). */
	ingestToken: string | undefined;
	devices: DeviceConfig;
};

export type BigSpender = {
	/** Handles a collector's `POST`. Wire it to whatever route you serve ingest on. */
	ingest(request: Request): Promise<Response>;
	/** Merged totals for every range, recomputed at most every few minutes or after an ingest. */
	summary(now?: number): Promise<UsageSummary>;
	/** Subscription limit hits over the last 90 UTC days, cached like `summary`. */
	limits(now?: number): Promise<LimitsSummary>;
};

export function createBigSpender({ dataDir, ingestToken, devices }: BigSpenderOptions): BigSpender {
	const store = fileStore(dataDir);
	let cache: { value: UsageSummary; computedAt: number } | null = null;
	let limitsCache: { value: LimitsSummary; computedAt: number } | null = null;

	return {
		ingest: createIngest({
			store,
			token: ingestToken,
			onStored: () => {
				cache = null;
				limitsCache = null;
			}
		}),
		async summary(now = Date.now()) {
			if (cache && now - cache.computedAt < SUMMARY_TTL_MS) return cache.value;
			const value = summarize(await store.list(), now, devices);
			cache = { value, computedAt: now };
			return value;
		},
		async limits(now = Date.now()) {
			if (limitsCache && now - limitsCache.computedAt < SUMMARY_TTL_MS) return limitsCache.value;
			const value = summarizeLimits(await store.list(), now);
			limitsCache = { value, computedAt: now };
			return value;
		}
	};
}
