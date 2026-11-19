// Proves a change leaves the collector's output alone: runs the collector from a git ref and from
// this checkout with --dry-run on this machine's logs, with the same prices, and diffs the two
// snapshots. Only generatedAt may differ. Run: node scripts/parity-ref.mjs [ref, default origin/main]
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectBoth, fetchPricing } from './lib/parity.mjs';

const ref = process.argv[2] ?? 'origin/main';
const strip = ({ generatedAt, ...rest }) => rest;
const same = (a, b) => JSON.stringify(strip(a)) === JSON.stringify(strip(b));

const dir = await mkdtemp(join(tmpdir(), 'big-spender-ref-'));
try {
	const old = join(dir, 'collector.mjs');
	await writeFile(old, execFileSync('git', ['show', `${ref}:src/collector.mjs`]));
	const pricing = await fetchPricing();
	const { theirs, ours, attempt } = await collectBoth(
		{ collector: old, kind: 'package' },
		'parity',
		pricing,
		same
	);
	await rm(join(pricing, '..'), { recursive: true, force: true });
	const files = ['before', 'after'].map((name) => join(dir, `${name}.json`));
	await writeFile(files[0], JSON.stringify(theirs, null, 2) + '\n');
	await writeFile(files[1], JSON.stringify(ours, null, 2) + '\n');
	let diff = '';
	try {
		execFileSync('diff', ['-u', '--label', `${ref}`, '--label', 'this checkout', ...files]);
	} catch (err) {
		diff = err.stdout.toString();
	}
	console.log(
		`${ours.hourly.length} rows, ${ours.sessionsTotal} sessions, ${ours.pricingSource}, attempt ${attempt}`
	);
	console.log(diff.trimEnd());
	process.exitCode = same(theirs, ours) ? 0 : 1;
	console.log(same(theirs, ours) ? 'ok: only generatedAt differs' : 'FAIL: the snapshots differ');
} finally {
	await rm(dir, { recursive: true, force: true });
}
