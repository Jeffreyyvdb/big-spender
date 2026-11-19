// Proves a change leaves the collector's output alone: runs the collector from a git ref and from
// this checkout with --dry-run on this machine's logs, in the same environment and with the same
// prices, and diffs the two snapshots. Only generatedAt may differ. Each run gets its own cache
// dir and no env file, so the real state is never touched.
//
//   node scripts/parity-ref.mjs [ref, default origin/main]
import { execFile, execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fetchPricing, packageCollector } from './lib/parity.mjs';

const execFileAsync = promisify(execFile);
const ATTEMPTS = 5;
const ref = process.argv[2] ?? 'origin/main';
const strip = ({ generatedAt, ...rest }) => rest;
const same = (a, b) => JSON.stringify(strip(a)) === JSON.stringify(strip(b));

const dir = await mkdtemp(join(tmpdir(), 'big-spender-ref-'));
try {
	const old = join(dir, 'collector.mjs');
	await writeFile(old, execFileSync('git', ['show', `${ref}:src/collector.mjs`]));
	const pricing = await fetchPricing();

	const dryRun = async (collector, name) => {
		const cache = join(dir, name, 'cache');
		await mkdir(join(cache, 'big-spender'), { recursive: true });
		await cp(pricing, join(cache, 'big-spender', 'litellm-prices.json'));
		const env = {
			...process.env,
			XDG_CACHE_HOME: cache,
			BIG_SPENDER_ENV_FILE: join(dir, 'no-env-file'),
			BIG_SPENDER_DEVICE_ID: 'parity'
		};
		const { stdout } = await execFileAsync(process.execPath, [collector, '--dry-run'], {
			env,
			maxBuffer: 1024 * 1024 * 1024
		});
		await rm(join(dir, name), { recursive: true, force: true });
		return JSON.parse(stdout);
	};

	let before;
	let after;
	let attempt = 0;
	// Live logs grow between reads, so both run together and retry until they agree.
	while (attempt++ < ATTEMPTS) {
		[before, after] = await Promise.all([dryRun(old, 'before'), dryRun(packageCollector, 'after')]);
		if (same(before, after)) break;
		console.error(`attempt ${attempt}: snapshots differ, retrying`);
	}
	await rm(join(pricing, '..'), { recursive: true, force: true });

	const files = ['before', 'after'].map((name) => join(dir, `${name}.json`));
	await writeFile(files[0], JSON.stringify(before, null, 2) + '\n');
	await writeFile(files[1], JSON.stringify(after, null, 2) + '\n');
	let diff = '';
	try {
		execFileSync('diff', ['-u', '--label', ref, '--label', 'this checkout', ...files]);
	} catch (err) {
		diff = err.stdout.toString();
	}
	const providers = [...new Set(after.hourly.map((r) => r.provider))].join(', ') || 'none';
	console.log(
		`${after.hourly.length} rows (${providers}), ${after.sessionsTotal} sessions, ${after.pricingSource}`
	);
	if (diff) console.log(diff.trimEnd());
	if (after.hourly.length === 0) {
		console.log('inconclusive: the collector found no usage');
		process.exitCode = 2;
	} else if (same(before, after)) {
		console.log('ok: only generatedAt may differ');
	} else {
		console.log('FAIL: the snapshots differ');
		process.exitCode = 1;
	}
} finally {
	await rm(dir, { recursive: true, force: true });
}
