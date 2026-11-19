import { z } from 'zod';

// Snapshot one device's collector sends to POST /api/usage/ingest.
// Objects are strict: unknown keys are rejected, so nothing beyond numbers,
// model names, timestamps and the device id can be stored or served.

const tokens = z.number().int().nonnegative().max(1e15);
const usd = z.number().nonnegative().max(1e9);
// No AI coding agent usage predates 2020. The floor also bounds the all-time range: it is
// bucketed by week from the oldest date, so year 0 would mean 100,000+ points per series.
export const EARLIEST_DATE = '2020-01-01T00:00:00Z';
const isoDate = z.iso
	.datetime({ offset: true })
	.refine((s) => Date.parse(s) >= Date.parse(EARLIEST_DATE), `must be ${EARLIEST_DATE} or later`);

export const MAX_ROWS = 50_000;
export const DEVICE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const PROVIDERS = ['claude', 'codex', 'cursor'] as const;
// Public ranges. 7d, 30d and 90d are bucketed by UTC day, `all` by ISO week. Nothing is finer
// than a day: an hourly view would show when each machine is in use.
export const RANGES = ['7d', '30d', '90d', 'all'] as const;

export const usageRowSchema = z.strictObject({
	hour: isoDate,
	granularity: z.enum(['hour', 'day']).optional(),
	provider: z.enum(PROVIDERS),
	model: z
		.string()
		.min(1)
		.max(100)
		.regex(/^[A-Za-z0-9._:/@-]+$/),
	sessions: z.number().int().nonnegative().max(1e6),
	inputTokens: tokens,
	cacheReadTokens: tokens,
	cacheWrite5mTokens: tokens,
	cacheWrite1hTokens: tokens,
	outputTokens: tokens,
	costUsd: z.strictObject({ input: usd, cacheRead: usd, cacheWrite: usd, output: usd }),
	cacheSavingsUsd: usd
});

const sessionCount = z.strictObject({
	claude: z.number().int().nonnegative(),
	codex: z.number().int().nonnegative(),
	// Sent by collectors that read Cursor; older ones only know claude and codex.
	cursor: z.number().int().nonnegative().optional(),
	all: z.number().int().nonnegative()
});

export const usageSnapshotSchema = z.strictObject({
	schemaVersion: z.literal(1),
	deviceId: z.string().regex(DEVICE_ID),
	generatedAt: isoDate,
	coverageStart: isoDate,
	pricingSource: z
		.string()
		.max(80)
		.regex(/^[A-Za-z0-9@._:/-]+$/),
	hourly: z.array(usageRowSchema).max(MAX_ROWS),
	sessionsTotal: z.number().int().nonnegative(),
	// Distinct sessions per range, counted on the device (session ids are never sent).
	sessionCounts: z
		.strictObject({
			// Sent by older collectors only; accepted and ignored.
			'24h': sessionCount.optional(),
			'7d': sessionCount,
			'30d': sessionCount,
			'90d': sessionCount
		})
		.optional()
});

export type UsageRow = z.infer<typeof usageRowSchema>;
export type UsageSnapshot = z.infer<typeof usageSnapshotSchema>;
export type UsageProvider = (typeof PROVIDERS)[number];
export type UsageRange = (typeof RANGES)[number];
