import { RANGES, type UsageRange } from './schema.ts';
import type { LimitsSummary } from './limits.ts';
import type { RangeSummary, UsageSummary } from './summary.ts';

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const safeColor = (c: string) => (/^#[0-9a-f]{3,8}$/i.test(c) ? c : '#888888');

const usd = (n: number) =>
	`$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const tokens = (n: number) =>
	n >= 1e9
		? `${(n / 1e9).toFixed(2)}B`
		: n >= 1e6
			? `${(n / 1e6).toFixed(1)}M`
			: n.toLocaleString('en-US');

const percent = (share: number) => `${(share * 100).toFixed(1)}%`;

const LABELS: Record<UsageRange, string> = {
	'7d': 'Last 7 days',
	'30d': 'Last 30 days',
	'90d': 'Last 90 days',
	all: 'All time'
};
const TOP_MODELS = 8;

const STYLE = `
:root { color-scheme: light dark; --bg: #fafaf7; --fg: #1b1f1c; --muted: #66706a; --card: #ffffff; --line: #dfe3dd; }
@media (prefers-color-scheme: dark) {
	:root { --bg: #121614; --fg: #e6ebe7; --muted: #97a098; --card: #1a201d; --line: #2a322e; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, sans-serif; }
main { max-width: 56rem; margin: 0 auto; padding: 2rem 1rem 4rem; }
h1 { margin: 0; font-size: 1.5rem; }
h2 { margin: 2.5rem 0 0.75rem; font-size: 1.1rem; }
.sub { margin: 0.25rem 0 0; color: var(--muted); }
.totals { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: 1rem; margin-top: 1.5rem; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 0.75rem; padding: 1rem; }
.card h3 { margin: 0; font-size: 0.85rem; font-weight: 500; color: var(--muted); }
.card .cost { margin: 0.25rem 0 0.5rem; font-size: 1.75rem; font-weight: 600; font-variant-numeric: tabular-nums; }
.card p { margin: 0; color: var(--muted); font-size: 0.9rem; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th, td { padding: 0.5rem 0.5rem; border-bottom: 1px solid var(--line); text-align: right; }
th:first-child, td:first-child { text-align: left; }
th { color: var(--muted); font-weight: 500; font-size: 0.85rem; }
.swatch { display: inline-block; width: 0.75rem; height: 0.75rem; margin-right: 0.5rem; border-radius: 50%; vertical-align: -0.05em; }
.scroll { overflow-x: auto; }
.empty { color: var(--muted); }
.days td, .days th { padding: 0.35rem 0.25rem; font-size: 0.8rem; text-align: center; }
.days td:first-child, .days th:first-child { padding-right: 0.75rem; text-align: left; }
.days .hit { color: #c0392b; font-weight: 600; }
`;

function totalsCard(r: RangeSummary): string {
	return `<section class="card"><h3>${LABELS[r.range]}</h3>
<p class="cost">${usd(r.totalCost)}</p>
<p>${r.sessions === null ? '' : `${r.sessions.toLocaleString('en-US')} sessions · `}${tokens(r.tokens.processed)} tokens</p>
<p>${usd(r.cacheSavings)} saved by caching</p></section>`;
}

function devicesTable(summary: UsageSummary): string {
	const widest = summary.ranges.all;
	if (!widest.devices.length) return '<p class="empty">No devices have reported yet.</p>';
	const rows = widest.devices.map((d) => {
		const cells = RANGES.map((range) => {
			const line = summary.ranges[range].devices.find((x) => x.name === d.name);
			return `<td>${usd(line?.cost ?? 0)}</td>`;
		});
		return `<tr><td><span class="swatch" style="background:${safeColor(d.color)}"></span>${escapeHtml(d.name)}</td>${cells.join('')}</tr>`;
	});
	const heads = RANGES.map((range) => `<th>${LABELS[range]}</th>`).join('');
	return `<div class="scroll"><table><thead><tr><th>Device</th>${heads}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

function modelsTable(r: RangeSummary): string {
	if (!r.models.length) return '<p class="empty">No usage in this range.</p>';
	const rows = r.models
		.slice(0, TOP_MODELS)
		.map(
			(m) =>
				`<tr><td>${escapeHtml(m.model)}</td><td>${escapeHtml(m.provider)}</td><td>${usd(m.cost)}</td><td>${percent(m.share)}</td><td>${tokens(m.tokens)}</td></tr>`
		);
	return `<div class="scroll"><table><thead><tr><th>Model</th><th>Agent</th><th>Cost</th><th>Share</th><th>Tokens</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

const WINDOW_LABELS: Record<string, string> = {
	five_hour: '5-hour session',
	seven_day: 'Weekly'
};
const windowLabel = (w: string) =>
	WINDOW_LABELS[w] ??
	(w.startsWith('seven_day_') ? `Weekly · ${w.slice(10)}` : w).replace(/_/g, ' ');
const RECENT_DAYS = 14;

function limitsSection(limits: LimitsSummary): string {
	const rows = limits.providers.flatMap((p) => p.windows.map((w) => ({ provider: p.provider, w })));
	if (!rows.length)
		return '<p class="empty">No usage limit windows recorded in the last 90 days.</p>';
	const totals = rows.map(
		({ provider, w }) =>
			`<tr><td>${escapeHtml(provider)} · ${escapeHtml(windowLabel(w.window))}</td><td>${w.observed}</td><td>${w.hit}</td><td>${w.lockedHours.toFixed(1)}</td><td>${w.lastHit ?? '-'}</td></tr>`
	);
	const first = Date.parse(limits.to) - RECENT_DAYS * 86_400_000;
	const heads = Array.from({ length: RECENT_DAYS }, (_, i) =>
		new Date(first + i * 86_400_000).toISOString().slice(8, 10)
	);
	const days = rows.map(({ provider, w }) => {
		const cells = w.series.hits
			.slice(-RECENT_DAYS)
			.map((n) => (n ? `<td class="hit">${n}</td>` : '<td>·</td>'));
		return `<tr><td>${escapeHtml(provider)} · ${escapeHtml(windowLabel(w.window))}</td>${cells.join('')}</tr>`;
	});
	return `<div class="scroll"><table><thead><tr><th>Window</th><th>Seen</th><th>Hit</th><th>Locked hours</th><th>Last hit</th></tr></thead><tbody>${totals.join('')}</tbody></table></div>
<p class="sub">Hits per day, last ${RECENT_DAYS} days (UTC day of month)</p>
<div class="scroll"><table class="days"><thead><tr><th>Window</th>${heads.map((d) => `<th>${d}</th>`).join('')}</tr></thead><tbody>${days.join('')}</tbody></table></div>`;
}

export function renderPage(summary: UsageSummary, limits?: LimitsSummary): string {
	const updated = escapeHtml(summary.generatedAt);
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>big-spender</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>big-spender</h1>
<p class="sub">What AI coding agents would cost at API prices, across all devices. Computed ${updated}.</p>
<div class="totals">${RANGES.map((range) => totalsCard(summary.ranges[range])).join('\n')}</div>
<h2>Devices</h2>
${devicesTable(summary)}
<h2>Top models, last 30 days</h2>
${modelsTable(summary.ranges['30d'])}
${limits ? `<h2>Usage limits, last 90 days</h2>\n${limitsSection(limits)}\n` : ''}</main>
</body>
</html>
`;
}
