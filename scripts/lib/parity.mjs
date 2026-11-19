import { execFile, execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
export const packageCollector = join(packageRoot, 'src', 'collector.mjs');

/**
 * Exports the site's usage code from origin/main into a temp dir, never from its working tree.
 * `SITE_REPO` is a checkout of the site; node_modules is linked so the site's schema.ts finds zod.
 */
export async function exportSite(repo = process.env.SITE_REPO) {
	if (!repo) throw new Error('set SITE_REPO to a checkout of the site repo');
	execFileSync('git', ['-C', repo, 'fetch', '-q', 'origin']);
	const dir = await mkdtemp(join(tmpdir(), 'big-spender-site-'));
	const archive = execFileSync(
		'git',
		['-C', repo, 'archive', 'origin/main', 'scripts/usage-collector', 'src/lib/usage'],
		{ maxBuffer: 64 * 1024 * 1024 }
	);
	execFileSync('tar', ['-x', '-C', dir], { input: archive });
	await symlink(join(packageRoot, 'node_modules'), join(dir, 'node_modules'));
	return {
		dir,
		collector: join(dir, 'scripts', 'usage-collector', 'collector.mjs'),
		lib: join(dir, 'src', 'lib', 'usage')
	};
}

/**
 * Runs a collector with `--dry-run` in a fresh HOME, cache and config dir. The real Claude and
 * Codex logs are read through CLAUDE_CONFIG_DIR and CODEX_HOME and never written; the real
 * ~/.cache and ~/.config are never touched. `kind` picks the env var names and cache dir name.
 * With `pricingFrom`, the LiteLLM price cache is copied in so both runs use identical prices.
 */
export async function dryRun(collector, kind, deviceId, { pricingFrom } = {}) {
	const realHome = process.env.HOME;
	const root = await mkdtemp(join(tmpdir(), `big-spender-${kind}-`));
	const home = join(root, 'home');
	const cache = join(root, 'cache');
	const config = join(root, 'config');
	await mkdir(home, { recursive: true });
	const cacheName = kind === 'site' ? 'usage-collector' : 'big-spender';
	if (pricingFrom) {
		await mkdir(join(cache, cacheName), { recursive: true });
		await cp(pricingFrom, join(cache, cacheName, 'litellm-prices.json'));
	}
	const env = {
		PATH: process.env.PATH,
		HOME: home,
		XDG_CACHE_HOME: cache,
		XDG_CONFIG_HOME: config,
		CLAUDE_CONFIG_DIR: join(realHome, '.claude'),
		CODEX_HOME: join(realHome, '.codex'),
		[kind === 'site' ? 'USAGE_DEVICE_ID' : 'BIG_SPENDER_DEVICE_ID']: deviceId
	};
	try {
		const { stdout, stderr } = await execFileAsync(process.execPath, [collector, '--dry-run'], {
			env,
			maxBuffer: 512 * 1024 * 1024
		});
		return {
			snapshot: JSON.parse(stdout),
			stderr
		};
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

const PRICING_URL =
	'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

/** One LiteLLM price file, in the collectors' cache format, shared by both runs. */
export async function fetchPricing() {
	const res = await fetch(PRICING_URL, { signal: AbortSignal.timeout(30_000) });
	if (!res.ok) throw new Error(`pricing fetch failed: HTTP ${res.status}`);
	const dir = await mkdtemp(join(tmpdir(), 'big-spender-pricing-'));
	const file = join(dir, 'litellm-prices.json');
	await writeFile(file, JSON.stringify({ fetchedAt: Date.now(), models: await res.json() }));
	return file;
}

/**
 * Real logs keep growing while a session is open, so two reads a few seconds apart can differ.
 * Runs both collectors together and retries until they read the same logs.
 */
export async function collectBoth(site, deviceId, pricingFrom, same, attempts = 5) {
	let last;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		const [theirs, ours] = await Promise.all([
			dryRun(site.collector, 'site', deviceId, { pricingFrom }),
			dryRun(packageCollector, 'package', deviceId, { pricingFrom })
		]);
		last = { theirs: theirs.snapshot, ours: ours.snapshot, attempt };
		if (same(last.theirs, last.ours)) return last;
		console.error(
			`attempt ${attempt}: snapshots differ (live logs changed between reads?), retrying`
		);
	}
	return last;
}
