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
// Collectors send the Cursor account's usage under this id, so no machine may use it.
export const CURSOR_DEVICE_ID = 'cursor';
export const PROVIDERS = [
	'claude',
	'codex',
	'cursor',
	'pi',
	'grok',
	'copilot',
	'antigravity',
	'gemini'
] as const;
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

export const MAX_LIMIT_WINDOWS = 5_000;

// One subscription usage window (the 5-hour session, the weekly cap, ...) as it was observed.
// A window instance is identified by (provider, window, resetsAt rounded down to the minute).
export const limitWindowSchema = z.strictObject({
	provider: z.enum(PROVIDERS),
	// five_hour, seven_day, seven_day_opus, ...; Codex windows are named from window_minutes
	// (300 -> five_hour, 10080 -> seven_day, otherwise `${minutes}m`).
	window: z.string().regex(/^[a-z0-9_]{1,40}$/),
	resetsAt: isoDate,
	// Highest share of the window seen used, 0-100. A blocked request means 100.
	peakPercent: z.number().min(0).max(100),
	// First time a request was refused because this window was used up.
	hitAt: isoDate.optional()
});

const count = z.number().int().nonnegative();
const sessionCount = z.strictObject({
	...(Object.fromEntries(PROVIDERS.map((p) => [p, count.optional()])) as Record<
		UsageProvider,
		z.ZodOptional<typeof count>
	>),
	claude: count,
	codex: count,
	all: count
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
		.optional(),
	limits: z.array(limitWindowSchema).max(MAX_LIMIT_WINDOWS).optional()
});

export type LimitWindow = z.infer<typeof limitWindowSchema>;
export type UsageRow = z.infer<typeof usageRowSchema>;
export type UsageSnapshot = z.infer<typeof usageSnapshotSchema>;
export type UsageProvider = (typeof PROVIDERS)[number];
export type UsageRange = (typeof RANGES)[number];
