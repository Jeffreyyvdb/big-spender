import { execFileSync } from 'node:child_process';
import {
	access,
	chmod,
	copyFile,
	mkdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile
} from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { UsageError, type Context } from './context.ts';
import { parseEnv, renameLegacyKeys, setting, upsertEnv } from './envfile.ts';
import { DEVICE_ID } from './schema.ts';
import { pickScheduler } from './scheduler.ts';

// The collector removes its lock when it finishes, so one this young belongs to a live run.
const LOCK_FRESH_MS = 30 * 60 * 1000;

const exists = (path: string) =>
	access(path).then(
		() => true,
		() => false
	);

const readText = (path: string) => readFile(path, 'utf8').catch(() => undefined);

async function writePrivate(path: string, text: string) {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	await writeFile(tmp, text, { mode: 0o600 });
	await rename(tmp, path);
	await chmod(path, 0o600);
}

/** The `node` on PATH if it is new enough (stable across upgrades), else the one running us. */
function nodeForSchedule(ctx: Context): string {
	for (const dir of (ctx.env.PATH ?? '').split(delimiter).filter(Boolean)) {
		const candidate = join(dir, 'node');
		try {
			const major = Number(
				execFileSync(candidate, ['-p', 'process.versions.node.split(".")[0]'], {
					encoding: 'utf8',
					timeout: 10_000
				})
			);
			return major >= 20 ? candidate : process.execPath;
		} catch {
			continue;
		}
	}
	return process.execPath;
}

async function lockIsFresh(lock: string): Promise<boolean> {
	const st = await stat(lock).catch(() => null);
	return st !== null && Date.now() - st.mtimeMs < LOCK_FRESH_MS;
}

async function migrateConfig(ctx: Context, log: string[]) {
	const { paths } = ctx;
	if (!(await exists(paths.configDir)) && (await exists(paths.legacy.configDir))) {
		await rename(paths.legacy.configDir, paths.configDir);
		log.push(`moved ${paths.legacy.configDir} to ${paths.configDir}`);
	}
	const text = await readText(paths.envFile);
	if (text === undefined) return;
	const renamed = renameLegacyKeys(text);
	if (renamed !== text) {
		await writePrivate(paths.envFile, renamed);
		log.push(`renamed USAGE_* keys in ${paths.envFile}`);
	} else {
		await chmod(paths.envFile, 0o600);
	}
}

async function migrateCache(ctx: Context, log: string[]) {
	const { paths } = ctx;
	if (!(await exists(paths.legacy.cacheDir))) return;
	if (await exists(paths.cacheDir)) {
		log.push(
			`left ${paths.legacy.cacheDir} in place: ${paths.cacheDir} already exists, so the old state was not moved`
		);
		return;
	}
	await rename(paths.legacy.cacheDir, paths.cacheDir);
	log.push(`moved ${paths.legacy.cacheDir} to ${paths.cacheDir}`);
}

type Existing = { deviceId: string; url: string; token: string };

/** Settings already on this machine, from the new env file or the one the old collector made. */
async function existingSettings(ctx: Context): Promise<Existing> {
	const { paths } = ctx;
	const text =
		(await readText(paths.envFile)) ?? (await readText(join(paths.legacy.configDir, 'env'))) ?? '';
	const vars = parseEnv(text);
	return {
		deviceId: setting(vars, 'DEVICE_ID'),
		url: setting(vars, 'INGEST_URL'),
		token: setting(vars, 'INGEST_TOKEN')
	};
}

export const INSTALL_USAGE = `Usage: big-spender install --device <id> [--url <ingest url>] [--rename]

Copies the collector to ~/.local/share/big-spender, schedules it hourly (systemd user timer on
Linux, launchd agent on macOS) and runs it once. The ingest token comes from the existing env
file, BIG_SPENDER_INGEST_TOKEN, or a hidden prompt. It is never taken from a flag.
Re-running is safe. A usage-collector install from before the rename is migrated in place.
A machine that already has a device id keeps it: --device with a different id needs --rename,
because the server would count the same history twice, under the old id and the new one.`;

export async function install(args: string[], ctx: Context): Promise<number> {
	const { values } = parseArgs({
		args,
		options: {
			device: { type: 'string' },
			url: { type: 'string' },
			rename: { type: 'boolean' }
		},
		strict: true
	});
	const { paths } = ctx;
	const existing = await existingSettings(ctx);

	const deviceId = values.device ?? ctx.env.BIG_SPENDER_DEVICE_ID ?? existing.deviceId;
	if (!DEVICE_ID.test(deviceId)) {
		throw new UsageError('--device must be a lowercase slug such as laptop or desktop');
	}

	if (existing.deviceId && deviceId !== existing.deviceId && !values.rename) {
		throw new UsageError(
			`this machine already reports as "${existing.deviceId}", not "${deviceId}". Under a new id the server would count the same usage twice, because ${existing.deviceId}.json stays on the server next to the new one. Keep "${existing.deviceId}", or pass --rename if you mean to change it and will remove the old device's data on the server`
		);
	}

	const migrating = !(await exists(paths.cacheDir)) && (await exists(paths.legacy.cacheDir));
	if (migrating && (await lockIsFresh(paths.legacy.lock))) {
		throw new UsageError(
			`the old collector is running (${paths.legacy.lock} is recent); wait for it to finish and run install again`
		);
	}

	let url = values.url ?? ctx.env.BIG_SPENDER_INGEST_URL ?? existing.url;
	let token = ctx.env.BIG_SPENDER_INGEST_TOKEN || existing.token;
	if (!url) url = await ctx.prompter().ask('Ingest URL (https://…/api/usage/ingest): ');
	if (!token) token = await ctx.prompter().askHidden('Ingest token: ');
	if (!url || !token) throw new UsageError('an ingest URL and token are required');

	const scheduler = pickScheduler(ctx.env, ctx.platform, paths, ctx.templatesDir);
	const log: string[] = [];

	for (const removed of await scheduler.removeLegacy()) log.push(`removed old schedule ${removed}`);
	await migrateConfig(ctx, log);
	await migrateCache(ctx, log);
	if (await exists(paths.legacy.shareDir)) {
		await rm(paths.legacy.shareDir, { recursive: true, force: true });
		log.push(`removed ${paths.legacy.shareDir}`);
	}

	const base =
		(await readText(paths.envFile)) ??
		(await readText(join(ctx.templatesDir, 'env.example'))) ??
		'';
	await writePrivate(
		paths.envFile,
		upsertEnv(base, {
			BIG_SPENDER_DEVICE_ID: deviceId,
			BIG_SPENDER_INGEST_URL: url,
			BIG_SPENDER_INGEST_TOKEN: token
		})
	);

	await mkdir(paths.shareDir, { recursive: true });
	await copyFile(ctx.collector, paths.collector);
	await scheduler.install(nodeForSchedule(ctx));

	for (const line of log) ctx.out(line);
	ctx.out(`Scheduled with ${scheduler.describe}`);
	try {
		await scheduler.runNow();
	} catch (err) {
		ctx.err(
			`The schedule is installed, but the first run failed: ${err instanceof Error ? err.message : err}`
		);
		return 1;
	}
	return 0;
}

export const UNINSTALL_USAGE =
	'Usage: big-spender uninstall\n\nRemoves the schedule. The env file and state are kept.';

export async function uninstall(args: string[], ctx: Context): Promise<number> {
	parseArgs({ args, options: {}, strict: true });
	const scheduler = pickScheduler(ctx.env, ctx.platform, ctx.paths, ctx.templatesDir);
	await scheduler.removeLegacy();
	await scheduler.uninstall();
	ctx.out(
		`Schedule removed. Env (${ctx.paths.envFile}) and state (${ctx.paths.cacheDir}) were kept.`
	);
	return 0;
}
