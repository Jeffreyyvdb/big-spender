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
	/** Collector rows summed in; each adds rounding to the cost. */
	rows: number;
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
		totalTokens?: number;
		inputTokens?: number;
		cacheCreationTokens?: number;
		cacheReadTokens?: number;
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

export type DayOutputResult = { day: string; ours: number; theirs: number | null; ok: boolean };

const TOKEN_FIELDS = ['input', 'cacheRead', 'cacheWrite', 'cacheWrite1h', 'output'] as const;
const COST_PARTS = 4;
const COLLECTOR_ROUNDS_TO_USD = 1e-6;
const roundingUsd = (rows: number) => rows * COST_PARTS * (COLLECTOR_ROUNDS_TO_USD / 2);

const zero = (): Totals => ({
	input: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cacheWrite1h: 0,
	output: 0,
	cost: 0,
	rows: 0
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
		t.rows++;
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
 *
 * `outputExcludesReasoning` is for agents (antigravity) whose `outputTokens` leave reasoning
 * out, while the collector counts it as output. Their rows have no reasoning field; only a day's
 * `totalTokens` includes it. So output is compared exactly per day, and per row only as a floor:
 * a collector row below ccusage's has lost output to another model.
 */
export function ccusageRows(
	report: CcusageReport,
	renameModel: (m: string) => string = (m) => m,
	{ outputExcludesReasoning = false }: { outputExcludesReasoning?: boolean } = {}
) {
	const rows: Rows = new Map();
	const dayCost = new Map<string, number>();
	const dayOutput = outputExcludesReasoning ? new Map<string, number | null>() : undefined;
	for (const day of report.daily ?? []) {
		dayCost.set(day.date, day.totalCost ?? day.costUSD ?? 0);
		const totals = [day.totalTokens, day.inputTokens, day.cacheCreationTokens, day.cacheReadTokens];
		dayOutput?.set(
			day.date,
			totals.every((n) => typeof n === 'number')
				? day.totalTokens! - day.inputTokens! - day.cacheCreationTokens! - day.cacheReadTokens!
				: null
		);
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
	return { rows, dayCost, dayOutput };
}

const costGap = (a: number, b: number, rows: number) =>
	Math.abs(a - b) <= roundingUsd(rows) ? 0 : Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b));

const counted = (t: Totals) => tokenSum(t) > 0 || (t.cost ?? 0) > 0;

export function compare(
	ours: Rows,
	theirs: ReturnType<typeof ccusageRows>,
	{ fromDay, tolerance }: { fromDay: string; tolerance: number }
): { rows: RowResult[]; days: DayResult[]; dayOutputs: DayOutputResult[] } {
	const keys = new Set<string>();
	for (const [key, t] of ours) if (counted(t)) keys.add(key);
	for (const [key, t] of theirs.rows) if (counted(t) && key >= fromDay) keys.add(key);

	const rows: RowResult[] = [];
	const ourDay = new Map<string, { cost: number; rows: number; output: number }>();
	const daysWithoutModelCost = new Set<string>();
	for (const key of [...keys].sort()) {
		const [day, model] = key.split('|');
		const a = ours.get(key) ?? zero();
		const b = theirs.rows.get(key) ?? missing();
		const outputIsFloor = (f: (typeof TOKEN_FIELDS)[number]) => f === 'output' && theirs.dayOutput;
		const tokenDiffs = TOKEN_FIELDS.filter(
			(f) => b[f] !== null && (outputIsFloor(f) ? a[f]! < b[f]! : a[f] !== b[f])
		).map((f) => `${f} ${a[f]} ${outputIsFloor(f) ? 'below' : 'vs'} ${b[f]}`);
		if (b.cost === null) daysWithoutModelCost.add(day);
		const costDiff = b.cost === null ? null : costGap(a.cost!, b.cost, a.rows);
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
		const d = ourDay.get(day) ?? { cost: 0, rows: 0, output: 0 };
		d.cost += a.cost!;
		d.rows += a.rows;
		d.output += a.output;
		ourDay.set(day, d);
	}

	const days = [...daysWithoutModelCost].sort().map((day) => {
		const a = ourDay.get(day) ?? { cost: 0, rows: 0 };
		const b = theirs.dayCost.get(day) ?? 0;
		const costDiff = costGap(a.cost, b, a.rows);
		return { day, ours: a.cost, theirs: b, costDiff, ok: costDiff <= tolerance };
	});
	const dayOutputs = theirs.dayOutput
		? [...ourDay].map(([day, a]) => {
				const b = theirs.dayOutput!.get(day) ?? null;
				return { day, ours: a.output, theirs: b, ok: a.output === b };
			})
		: [];
	return { rows, days, dayOutputs };
}
