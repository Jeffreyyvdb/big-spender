import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	ccusageRows,
	collectorRows,
	compare,
	type CcusageReport
} from '../scripts/lib/ccusage-parity.ts';
import type { UsageRow, UsageSnapshot } from '../src/schema.ts';

function row(hour: string, model: string, tokens: number, cost: number): UsageRow {
	return {
		hour,
		provider: 'claude',
		model,
		sessions: 1,
		inputTokens: tokens,
		cacheReadTokens: 10 * tokens,
		cacheWrite5mTokens: tokens,
		cacheWrite1hTokens: 2 * tokens,
		outputTokens: 3 * tokens,
		costUsd: { input: cost / 4, cacheRead: cost / 4, cacheWrite: cost / 4, output: cost / 4 },
		cacheSavingsUsd: 0
	};
}

const snapshot = (hourly: UsageRow[]): UsageSnapshot => ({
	schemaVersion: 1,
	deviceId: 'parity',
	generatedAt: '2026-11-15T00:00:00Z',
	coverageStart: '2026-08-17T00:00:00Z',
	pricingSource: 'litellm@2026-11-15',
	hourly,
	sessionsTotal: 1
});

const ours = snapshot([
	row('2026-11-14T09:00:00Z', 'opus', 100, 4),
	row('2026-11-14T21:00:00Z', 'opus', 50, 2),
	row('2026-11-14T21:00:00Z', 'haiku', 10, 1),
	row('2026-11-13T00:00:00Z', 'opus', 7, 1)
]);

const breakdown = (modelName: string, tokens: number, cost: number) => ({
	modelName,
	inputTokens: tokens,
	cacheReadTokens: 10 * tokens,
	cacheCreationTokens: 3 * tokens,
	cacheCreation1hTokens: 2 * tokens,
	outputTokens: 3 * tokens,
	cost
});

const matching = (): CcusageReport => ({
	daily: [
		{ date: '2026-11-13', modelBreakdowns: [breakdown('opus', 7, 1)] },
		{
			date: '2026-11-14',
			modelBreakdowns: [breakdown('opus', 150, 6), breakdown('haiku', 10, 1)]
		}
	]
});

const run = (report: CcusageReport, tolerance = 0.001) =>
	compare(collectorRows(ours, 'claude'), ccusageRows(report), {
		fromDay: '2026-08-17',
		tolerance
	});

test('identical tokens and cost match on every day and model', () => {
	const { rows, days, dayOutputs } = run(matching());
	assert.deepEqual(
		rows.map((r) => [r.day, r.model, r.ok]),
		[
			['2026-11-13', 'opus', true],
			['2026-11-14', 'haiku', true],
			['2026-11-14', 'opus', true]
		]
	);
	assert.deepEqual(days, []);
	assert.deepEqual(dayOutputs, []);
});

test('a changed token total is reported with both values', () => {
	const report = matching();
	report.daily![1].modelBreakdowns![0].outputTokens! += 1;
	const bad = run(report).rows.filter((r) => !r.ok);
	assert.deepEqual(
		bad.map((r) => [r.day, r.model, r.tokenDiffs]),
		[['2026-11-14', 'opus', ['output 450 vs 451']]]
	);
});

test('tokens swapped between models are reported even when the day total is equal', () => {
	const report = matching();
	const [opus, haiku] = report.daily![1].modelBreakdowns!;
	opus.inputTokens! -= 5;
	haiku.inputTokens! += 5;
	const bad = run(report).rows.filter((r) => !r.ok);
	assert.deepEqual(
		bad.map((r) => [r.model, r.tokenDiffs]),
		[
			['haiku', ['input 10 vs 15']],
			['opus', ['input 150 vs 145']]
		]
	);
});

test('a 1-hour cache write moved to 5 minutes is reported', () => {
	const report = matching();
	report.daily![0].modelBreakdowns![0].cacheCreation1hTokens! -= 1;
	const [bad] = run(report).rows.filter((r) => !r.ok);
	assert.deepEqual(bad.tokenDiffs, ['cacheWrite1h 14 vs 13']);
});

test('cost outside the tolerance fails, inside it passes, and rounding never fails', () => {
	const report = matching();
	report.daily![1].modelBreakdowns![0].cost = 6.06;
	assert.equal(run(report, 0.001).rows.find((r) => r.model === 'opus' && !r.ok)?.day, '2026-11-14');
	assert.ok(run(report, 0.01).rows.every((r) => r.ok));
	report.daily![1].modelBreakdowns![0].cost = 6.000002;
	assert.ok(run(report, 0).rows.every((r) => r.ok));
	report.daily![0].modelBreakdowns![0].cost = 1.00006;
	assert.equal(run(report, 0).rows.find((r) => !r.ok)?.day, '2026-11-13');
});

test('a cost on a row without tokens is compared', () => {
	const report = matching();
	report.daily![0].modelBreakdowns!.push({ ...breakdown('sonnet', 0, 0), cost: 2 });
	const bad = run(report).rows.filter((r) => !r.ok);
	assert.deepEqual(
		bad.map((r) => [r.day, r.model, r.ours, r.theirs]),
		[['2026-11-13', 'sonnet', 0, 2]]
	);
});

test('a model only one tool reports is a mismatch', () => {
	const report = matching();
	report.daily![1].modelBreakdowns!.pop();
	report.daily![0].modelBreakdowns!.push(breakdown('sonnet', 1, 0.1));
	const bad = run(report).rows.filter((r) => !r.ok);
	assert.deepEqual(
		bad.map((r) => [r.day, r.model]),
		[
			['2026-11-13', 'sonnet'],
			['2026-11-14', 'haiku']
		]
	);
});

test('ccusage days before the collector window are left out', () => {
	const report = matching();
	report.daily!.unshift({
		date: '2026-08-16',
		modelBreakdowns: [breakdown('opus', 1, 1)]
	});
	assert.ok(run(report).rows.every((r) => r.ok));
});

test('without per-model cost, tokens are compared per model and cost per day', () => {
	const tokensOnly = (tokens: number) => ({
		inputTokens: tokens,
		cacheReadTokens: 10 * tokens,
		cacheCreationTokens: 3 * tokens,
		outputTokens: 3 * tokens
	});
	const report: CcusageReport = {
		daily: [
			{ date: '2026-11-13', costUSD: 1, models: { opus: tokensOnly(7) } },
			{ date: '2026-11-14', costUSD: 7.5, models: { opus: tokensOnly(150), haiku: tokensOnly(10) } }
		]
	};
	const { rows, days } = run(report);
	assert.ok(rows.every((r) => r.ok && r.costDiff === null));
	assert.deepEqual(
		days.map((d) => [d.day, d.ok]),
		[
			['2026-11-13', true],
			['2026-11-14', false]
		]
	);
});

function withoutReasoning(): CcusageReport {
	const report = matching();
	for (const day of report.daily!) {
		let total = 0;
		day.inputTokens = day.cacheReadTokens = day.cacheCreationTokens = 0;
		for (const m of day.modelBreakdowns!) {
			const reasoning = m.outputTokens! / 3;
			m.outputTokens! -= reasoning;
			day.inputTokens += m.inputTokens!;
			day.cacheReadTokens += m.cacheReadTokens!;
			day.cacheCreationTokens += m.cacheCreationTokens!;
			total += m.inputTokens! + m.cacheReadTokens! + m.cacheCreationTokens! + m.outputTokens!;
			total += reasoning;
		}
		day.totalTokens = total;
	}
	return report;
}

const runWithoutReasoning = (report: CcusageReport) =>
	compare(
		collectorRows(ours, 'claude'),
		ccusageRows(report, undefined, { outputExcludesReasoning: true }),
		{ fromDay: '2026-08-17', tolerance: 0.001 }
	);

test('output without reasoning is compared per day against the day total', () => {
	const { rows, dayOutputs } = runWithoutReasoning(withoutReasoning());
	assert.ok(rows.every((r) => r.ok));
	assert.deepEqual(dayOutputs, [
		{ day: '2026-11-13', ours: 21, theirs: 21, ok: true },
		{ day: '2026-11-14', ours: 480, theirs: 480, ok: true }
	]);
	assert.ok(
		run(withoutReasoning()).rows.every((r) => !r.ok),
		'the same report fails per row'
	);
});

test('a day whose output with reasoning differs is reported', () => {
	const report = withoutReasoning();
	report.daily![1].totalTokens! += 1;
	const { rows, dayOutputs } = runWithoutReasoning(report);
	assert.ok(rows.every((r) => r.ok));
	assert.deepEqual(
		dayOutputs.filter((d) => !d.ok),
		[{ day: '2026-11-14', ours: 480, theirs: 481, ok: false }]
	);

	delete report.daily![0].totalTokens;
	assert.deepEqual(
		runWithoutReasoning(report).dayOutputs.map((d) => d.ok),
		[false, false]
	);
});

test('a day that only ccusage has, with nothing but reasoning, is reported', () => {
	const report = withoutReasoning();
	report.daily!.unshift({
		date: '2026-11-12',
		inputTokens: 0,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
		totalTokens: 7,
		modelBreakdowns: [{ ...breakdown('opus', 0, 0), outputTokens: 0 }]
	});
	const { dayOutputs } = runWithoutReasoning(report);
	assert.deepEqual(
		dayOutputs.filter((d) => !d.ok),
		[{ day: '2026-11-12', ours: 0, theirs: 7, ok: false }]
	);
});

test('the other token counts stay exact per row when output is compared per day', () => {
	const report = withoutReasoning();
	report.daily![1].modelBreakdowns![0].inputTokens! += 1;
	report.daily![1].inputTokens! += 1;
	report.daily![1].totalTokens! += 1;
	const { rows, dayOutputs } = runWithoutReasoning(report);
	assert.deepEqual(
		rows.filter((r) => !r.ok).map((r) => [r.day, r.model, r.tokenDiffs]),
		[['2026-11-14', 'opus', ['input 150 vs 151']]]
	);
	assert.ok(dayOutputs.every((d) => d.ok));
});

test('output moved to another model on the same day is reported for the row that lost it', () => {
	const report = withoutReasoning();
	const [opus, haiku] = report.daily![1].modelBreakdowns!;
	opus.outputTokens! -= 15;
	haiku.outputTokens! += 15;
	const { rows, dayOutputs } = runWithoutReasoning(report);
	assert.deepEqual(
		rows.filter((r) => !r.ok).map((r) => [r.day, r.model, r.tokenDiffs]),
		[['2026-11-14', 'haiku', ['output 30 below 35']]]
	);
	assert.ok(dayOutputs.every((d) => d.ok));
});

test('nothing reported on either side leaves nothing to compare', () => {
	const { rows, days } = compare(
		collectorRows(snapshot([]), 'claude'),
		ccusageRows({ daily: [] }),
		{
			fromDay: '2026-08-17',
			tolerance: 0
		}
	);
	assert.equal(rows.length + days.length, 0);
});
