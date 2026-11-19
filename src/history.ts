import { mergeLimits } from './limits.ts';
import { MAX_ROWS, usageRowSchema, type UsageRow, type UsageSnapshot } from './schema.ts';

const DAY_MS = 86_400_000;

const round = (n: number) => Math.round(n * 1e6) / 1e6;
const dayOf = (r: UsageRow) => Math.floor(Date.parse(r.hour) / DAY_MS);
const keyOf = (r: UsageRow) => `${dayOf(r)}|${r.provider}|${r.model}`;

function compareRows(a: UsageRow, b: UsageRow): number {
	return (
		Date.parse(a.hour) - Date.parse(b.hour) ||
		a.provider.localeCompare(b.provider) ||
		a.model.localeCompare(b.model) ||
		(a.granularity ?? 'hour').localeCompare(b.granularity ?? 'hour')
	);
}

function group(rows: UsageRow[]): Map<string, UsageRow[]> {
	const out = new Map<string, UsageRow[]>();
	for (const r of rows) {
		const key = keyOf(r);
		const list = out.get(key);
		if (list) list.push(r);
		else out.set(key, [r]);
	}
	return out;
}

function rollUp(rows: UsageRow[]): UsageRow[] {
	const [first] = rows;
	if (rows.length === 1 && first.granularity === 'day') return rows;
	const sum = (pick: (r: UsageRow) => number) => rows.reduce((total, r) => total + pick(r), 0);
	const sessionsAtLeast = Math.max(...rows.map((r) => r.sessions));
	const day: UsageRow = {
		hour: new Date(dayOf(first) * DAY_MS).toISOString(),
		granularity: 'day',
		provider: first.provider,
		model: first.model,
		sessions: sessionsAtLeast,
		inputTokens: sum((r) => r.inputTokens),
		cacheReadTokens: sum((r) => r.cacheReadTokens),
		cacheWrite5mTokens: sum((r) => r.cacheWrite5mTokens),
		cacheWrite1hTokens: sum((r) => r.cacheWrite1hTokens),
		outputTokens: sum((r) => r.outputTokens),
		costUsd: {
			input: round(sum((r) => r.costUsd.input)),
			cacheRead: round(sum((r) => r.costUsd.cacheRead)),
			cacheWrite: round(sum((r) => r.costUsd.cacheWrite)),
			output: round(sum((r) => r.costUsd.output))
		},
		cacheSavingsUsd: round(sum((r) => r.cacheSavingsUsd))
	};
	// A sum can pass a field's cap, and a day can start outside the schema's date range.
	return usageRowSchema.safeParse(day).success ? [day] : rows;
}

function dropOldestDays(rows: UsageRow[], excess: number): { rows: UsageRow[]; days: number } {
	let cut = 0;
	let days = 0;
	while (cut < excess) {
		const day = dayOf(rows[cut]);
		while (cut < rows.length && dayOf(rows[cut]) === day) cut++;
		days++;
	}
	return { rows: rows.slice(cut), days };
}

export function mergeSnapshots(
	stored: UsageSnapshot | undefined,
	next: UsageSnapshot
): { snapshot: UsageSnapshot; droppedDays: number } {
	const fresh = [...next.hourly].sort(compareRows);
	const limits = mergeLimits(stored?.limits, next.limits);
	const withLimits = limits.length ? { limits } : {};
	const { limits: _, ...rest } = next;
	if (!stored) return { snapshot: { ...rest, hourly: fresh, ...withLimits }, droppedDays: 0 };

	const reported = new Set(fresh.map(keyOf));
	const kept = [...group(stored.hourly)]
		.filter(([key]) => !reported.has(key))
		.flatMap(([, rows]) => rollUp(rows))
		.sort(compareRows);

	let coverage =
		Date.parse(stored.coverageStart) < Date.parse(next.coverageStart)
			? stored.coverageStart
			: next.coverageStart;

	const trimmed = dropOldestDays(kept, kept.length + fresh.length - MAX_ROWS);
	const droppedDays = trimmed.days;
	const hourly = [...trimmed.rows, ...fresh].sort(compareRows);
	if (droppedDays > 0) {
		const earliest = dayOf(hourly[0]) * DAY_MS;
		const latest = Math.min(earliest, Date.parse(next.coverageStart));
		if (latest > Date.parse(coverage)) coverage = new Date(latest).toISOString();
	}
	return { snapshot: { ...rest, coverageStart: coverage, hourly, ...withLimits }, droppedDays };
}
