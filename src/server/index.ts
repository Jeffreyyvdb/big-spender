import type { DeviceConfig } from '../devices.ts';
import { fileStore } from '../store.ts';
import { summarize, type UsageSummary } from '../summary.ts';
import { createIngest } from './ingest.ts';

export {
	DEVICE_ID,
	PROVIDERS,
	RANGES,
	usageRowSchema,
	usageSnapshotSchema,
	type UsageProvider,
	type UsageRange,
	type UsageRow,
	type UsageSnapshot
} from '../schema.ts';
export { OTHER, PALETTE, resolveDevices, type DeviceConfig, type DeviceInfo } from '../devices.ts';
export {
	summarize,
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
};

export function createBigSpender({ dataDir, ingestToken, devices }: BigSpenderOptions): BigSpender {
	const store = fileStore(dataDir);
	let cache: { value: UsageSummary; computedAt: number } | null = null;

	return {
		ingest: createIngest({
			store,
			token: ingestToken,
			onStored: () => {
				cache = null;
			}
		}),
		async summary(now = Date.now()) {
			if (cache && now - cache.computedAt < SUMMARY_TTL_MS) return cache.value;
			const value = summarize(await store.list(), now, devices);
			cache = { value, computedAt: now };
			return value;
		}
	};
}
