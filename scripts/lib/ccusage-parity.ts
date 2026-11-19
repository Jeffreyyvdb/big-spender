import type { UsageSnapshot } from '../../src/schema.ts';

export type Totals = {
	input: number;
	cacheRead: number;
	cacheWrite: number;
	/** Null where ccusage does not report 1-hour writes on their own. */
	cacheWrite1h: number | null;
	output: number;
	/** Null where ccusage gives no per-model cost. */
	cost: number | null;
};

export type Rows = Map<string, Totals>;

type CcusageModel = {
	modelName?: string;
	inputTokens?: number;
	cacheReadTokens?: number;
	cacheCreationTokens?: number;
	cacheCreation1hTokens?: number;
	outputTokens?: number;
	cost?: number;
};

export type CcusageReport = {
	daily?: Array<{
		date: string;
		totalCost?: number;
		costUSD?: number;
		modelBreakdowns?: CcusageModel[];
		models?: Record<string, CcusageModel>;
	}>;
};

export type RowResult = {
	day: string;
	model: string;
	tokens: number;
	ours: number;
	theirs: number | null;
	costDiff: number | null;
	tokenDiffs: string[];
	ok: boolean;
};

export type DayResult = {
	day: string;
	ours: number;
	theirs: number;
	costDiff: number;
	ok: boolean;
};

const TOKEN_FIELDS = ['input', 'cacheRead', 'cacheWrite', 'cacheWrite1h', 'output'] as const;
const HOURS_PER_DAY = 24;
const COST_PARTS = 4;
const COLLECTOR_ROUNDS_TO_USD = 1e-6;
const ROUNDING_USD = 2 * HOURS_PER_DAY * COST_PARTS * (COLLECTOR_ROUNDS_TO_USD / 2);

const zero = (): Totals => ({
	input: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cacheWrite1h: 0,
	output: 0,
	cost: 0
});
const missing = (): Totals => ({ ...zero(), cacheWrite1h: null, cost: null });

const tokenSum = (t: Totals) => t.input + t.cacheRead + t.cacheWrite + t.output;

/** One provider's rows of a collector snapshot. */
export function collectorRows(snapshot: UsageSnapshot, provider: string): Rows {
	const out: Rows = new Map();
	for (const r of snapshot.hourly) {
		if (r.provider !== provider) continue;
		const key = `${r.hour.slice(0, 10)}|${r.model}`;
		const t = out.get(key) ?? zero();
		t.input += r.inputTokens;
		t.cacheRead += r.cacheReadTokens;
		t.cacheWrite += r.cacheWrite5mTokens + r.cacheWrite1hTokens;
		t.cacheWrite1h! += r.cacheWrite1hTokens;
		t.output += r.outputTokens;
		t.cost! += r.costUsd.input + r.costUsd.cacheRead + r.costUsd.cacheWrite + r.costUsd.output;
		out.set(key, t);
	}
	return out;
}

/**
 * ccusage's daily JSON. With `--breakdown`, agents list `modelBreakdowns` with a cost each.
 * Others (codex) list `models` with tokens only, so their cost is compared per day instead.
 */
export function ccusageRows(report: CcusageReport, renameModel: (m: string) => string = (m) => m) {
	const rows: Rows = new Map();
	const dayCost = new Map<string, number>();
	for (const day of report.daily ?? []) {
		dayCost.set(day.date, day.totalCost ?? day.costUSD ?? 0);
		const models: Array<[string, CcusageModel]> = day.modelBreakdowns
			? day.modelBreakdowns.map((m) => [m.modelName ?? 'unknown', m])
			: Object.entries(day.models ?? {});
		for (const [name, m] of models) {
			const key = `${day.date}|${renameModel(name)}`;
			const t = rows.get(key) ?? missing();
			t.input += m.inputTokens ?? 0;
			t.cacheRead += m.cacheReadTokens ?? 0;
			t.cacheWrite += m.cacheCreationTokens ?? 0;
			if (m.cacheCreation1hTokens !== undefined) {
				t.cacheWrite1h = (t.cacheWrite1h ?? 0) + m.cacheCreation1hTokens;
			}
			t.output += m.outputTokens ?? 0;
			if (typeof m.cost === 'number') t.cost = (t.cost ?? 0) + m.cost;
			rows.set(key, t);
		}
	}
	return { rows, dayCost };
}

const costGap = (a: number, b: number) =>
	Math.abs(a - b) <= ROUNDING_USD ? 0 : Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b));

export function compare(
	ours: Rows,
	theirs: ReturnType<typeof ccusageRows>,
	{ fromDay, tolerance }: { fromDay: string; tolerance: number }
): { rows: RowResult[]; days: DayResult[] } {
	const keys = new Set<string>();
	for (const [key, t] of ours) if (tokenSum(t) > 0) keys.add(key);
	for (const [key, t] of theirs.rows) if (tokenSum(t) > 0 && key >= fromDay) keys.add(key);

	const rows: RowResult[] = [];
	const ourDayCost = new Map<string, number>();
	const daysWithoutModelCost = new Set<string>();
	for (const key of [...keys].sort()) {
		const [day, model] = key.split('|');
		const a = ours.get(key) ?? zero();
		const b = theirs.rows.get(key) ?? missing();
		const tokenDiffs = TOKEN_FIELDS.filter((f) => b[f] !== null && a[f] !== b[f]).map(
			(f) => `${f} ${a[f]} vs ${b[f]}`
		);
		if (b.cost === null) daysWithoutModelCost.add(day);
		const costDiff = b.cost === null ? null : costGap(a.cost!, b.cost);
		rows.push({
			day,
			model,
			tokens: tokenSum(a),
			ours: a.cost!,
			theirs: b.cost,
			costDiff,
			tokenDiffs,
			ok: tokenDiffs.length === 0 && (costDiff === null || costDiff <= tolerance)
		});
		ourDayCost.set(day, (ourDayCost.get(day) ?? 0) + a.cost!);
	}

	const days = [...daysWithoutModelCost].sort().map((day) => {
		const a = ourDayCost.get(day) ?? 0;
		const b = theirs.dayCost.get(day) ?? 0;
		const costDiff = costGap(a, b);
		return { day, ours: a, theirs: b, costDiff, ok: costDiff <= tolerance };
	});
	return { rows, days };
}
