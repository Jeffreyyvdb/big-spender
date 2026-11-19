// Checks one provider's collector numbers against ccusage, per UTC day and model.
//
//   node scripts/parity-ccusage.mjs <provider> [--home <dir>] [--tolerance <fraction>]
//                                   [--prices <file>] [--collector <path>] [--all]
//
// The collector runs with --dry-run, its cache and state in a temp dir, and no env file, so the
// real state is never touched. With --home, both tools run with HOME=<dir> and only PATH besides,
// so they read only the fixture logs under it. The collector prices with the LiteLLM file that the
// pinned ccusage embeds (or --prices), so a cost gap is a difference in how the tools count, not in
// prices. Token counts must match exactly; cost may differ by --tolerance (default 0.001).
// Exit code 0 is a match, 1 a mismatch, 2 nothing to compare or a usage error.
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { packageCollector } from './lib/parity.mjs';
import { ccusageRows, collectorRows, compare } from './lib/ccusage-parity.ts';

const execFileAsync = promisify(execFile);

/** @type {Record<string, { agent: string, args?: string[], renameModel?: (ccusageModel: string) => string }>} */
const AGENTS = {
	claude: { agent: 'claude', args: ['--mode', 'calculate'] },
	codex: { agent: 'codex' },
	pi: { agent: 'pi', args: ['--mode', 'calculate'], renameModel: (m) => m.replace(/^\[pi\] /, '') }
};

const CCUSAGE_VERSION = '20.0.51';
// ccusage 20.0.51 embeds this LiteLLM revision (flake.lock, nodes.litellm).
const CCUSAGE_PRICES =
	'https://raw.githubusercontent.com/BerriAI/litellm/d2bae98d97c6b9905bdebd96fde8b3d34176b857/model_prices_and_context_window.json';
const CCUSAGE_BIN =
	process.env.CCUSAGE_BIN || join(homedir(), '.cache/ccusage-bin/node_modules/.bin/ccusage');
const ATTEMPTS = 3;

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		home: { type: 'string' },
		tolerance: { type: 'string', default: '0.001' },
		prices: { type: 'string' },
		collector: { type: 'string', default: packageCollector },
		all: { type: 'boolean', default: false }
	}
});
const provider = positionals[0];
const mapping = AGENTS[provider];
if (!mapping) {
	console.error(`usage: parity-ccusage.mjs <${Object.keys(AGENTS).join('|')}> [--home <dir>]`);
	process.exit(2);
}
const tolerance = Number(values.tolerance);
if (!(tolerance >= 0 && tolerance < 1) || values.tolerance.trim() === '') {
	console.error(`--tolerance must be a fraction such as 0.001, not "${values.tolerance}"`);
	process.exit(2);
}

const { stdout: version } = await execFileAsync(CCUSAGE_BIN, ['--version']);
if (!version.includes(CCUSAGE_VERSION)) {
	console.error(
		`ccusage at ${CCUSAGE_BIN} is "${version.trim()}"; this script pins ${CCUSAGE_VERSION} and its prices. Update both constants together.`
	);
	process.exit(2);
}

const tmp = await mkdtemp(join(tmpdir(), 'big-spender-parity-'));
try {
	const models = values.prices
		? JSON.parse(await readFile(values.prices, 'utf8'))
		: await (await fetch(CCUSAGE_PRICES, { signal: AbortSignal.timeout(60_000) })).json();
	const cache = join(tmp, 'cache');
	await mkdir(join(cache, 'big-spender'), { recursive: true });
	await writeFile(
		join(cache, 'big-spender', 'litellm-prices.json'),
		JSON.stringify({ fetchedAt: Date.now(), models })
	);

	const base = values.home ? { PATH: process.env.PATH, HOME: values.home } : process.env;
	const collectorEnv = {
		...base,
		XDG_CACHE_HOME: cache,
		BIG_SPENDER_ENV_FILE: join(tmp, 'no-env-file'),
		BIG_SPENDER_DEVICE_ID: 'parity',
		BIG_SPENDER_CURSOR_API_KEY: ''
	};
	const run = async (file, args, env) =>
		(await execFileAsync(file, args, { env, maxBuffer: 1024 * 1024 * 1024 })).stdout;

	let result;
	let snapshot;
	for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
		const [ours, theirs] = await Promise.all([
			run(process.execPath, [values.collector, '--dry-run'], collectorEnv),
			run(
				CCUSAGE_BIN,
				[
					mapping.agent,
					'daily',
					'--json',
					'--breakdown',
					'--timezone',
					'UTC',
					'--offline',
					...(mapping.args ?? [])
				],
				base
			)
		]);
		snapshot = JSON.parse(ours);
		result = compare(
			collectorRows(snapshot, provider),
			ccusageRows(JSON.parse(theirs), mapping.renameModel),
			{ fromDay: snapshot.coverageStart.slice(0, 10), tolerance }
		);
		if (result.rows.every((r) => r.tokenDiffs.length === 0)) break;
		if (attempt < ATTEMPTS) console.error(`attempt ${attempt}: token counts differ, retrying`);
	}
	process.exitCode = report(result, snapshot);
} finally {
	await rm(tmp, { recursive: true, force: true });
}

function report({ rows, days }, snapshot) {
	const usd = (n) => (n === null ? '-' : `$${n.toFixed(4)}`);
	const pct = (n) => (n === null ? '-' : `${(n * 100).toFixed(3)}%`);
	console.log(
		`${provider} vs ccusage ${mapping.agent} ${CCUSAGE_VERSION}, UTC days from ${snapshot.coverageStart.slice(0, 10)}, ` +
			`LiteLLM prices ${values.prices ?? CCUSAGE_PRICES.split('/')[5].slice(0, 7)}, cost tolerance ${pct(tolerance)}`
	);
	if (rows.length === 0) {
		console.log('inconclusive: neither tool reported usage');
		return 2;
	}

	const shown = values.all ? rows : rows.filter((r) => !r.ok);
	if (shown.length) {
		console.log(
			`\n${'day'.padEnd(10)}  ${'model'.padEnd(28)}  ${'ours'.padStart(12)}  ${'ccusage'.padStart(12)}  ${'diff'.padStart(8)}  tokens`
		);
		for (const r of shown) {
			console.log(
				`${r.day}  ${r.model.padEnd(28)}  ${usd(r.ours).padStart(12)}  ${usd(r.theirs).padStart(12)}  ${pct(r.costDiff).padStart(8)}  ${r.tokenDiffs.join(', ') || 'equal'}`
			);
		}
	}
	const badDays = days.filter((d) => values.all || !d.ok);
	if (badDays.length) {
		console.log(`\nper-day cost (ccusage gives no per-model cost for ${mapping.agent})`);
		for (const d of badDays) {
			console.log(
				`${d.day}  ${usd(d.ours).padStart(12)}  ${usd(d.theirs).padStart(12)}  ${pct(d.costDiff).padStart(8)}`
			);
		}
	}

	const byModel = new Map();
	for (const r of rows) {
		const m = byModel.get(r.model) ?? { rows: 0, tokens: 0, ours: 0, theirs: 0, priced: true };
		m.rows++;
		m.tokens += r.tokens;
		m.ours += r.ours;
		if (r.theirs === null) m.priced = false;
		else m.theirs += r.theirs;
		byModel.set(r.model, m);
	}
	console.log(
		`\n${'model'.padEnd(28)}  ${'days'.padStart(4)}  ${'tokens'.padStart(14)}  ${'ours'.padStart(12)}  ${'ccusage'.padStart(12)}`
	);
	for (const [model, m] of [...byModel].sort((a, b) => b[1].ours - a[1].ours)) {
		console.log(
			`${model.padEnd(28)}  ${String(m.rows).padStart(4)}  ${m.tokens.toLocaleString('en-US').padStart(14)}  ${usd(m.ours).padStart(12)}  ${usd(m.priced ? m.theirs : null).padStart(12)}`
		);
	}

	const tokenBad = rows.filter((r) => r.tokenDiffs.length).length;
	const costBad = rows.filter((r) => r.costDiff !== null && r.costDiff > tolerance).length;
	const dayBad = days.filter((d) => !d.ok).length;
	console.log(
		`\n${rows.length} day-model rows: tokens ${tokenBad ? `differ on ${tokenBad}` : 'identical'}; ` +
			`cost ${costBad ? `over tolerance on ${costBad}` : 'within tolerance'}` +
			(days.length
				? `; ${days.length} day totals ${dayBad ? `over tolerance on ${dayBad}` : 'within tolerance'}`
				: '')
	);
	return tokenBad || costBad || dayBad ? 1 : 0;
}
