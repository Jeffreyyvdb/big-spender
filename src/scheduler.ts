import { execFile } from 'node:child_process';
import { readdir, readFile, rm, copyFile, mkdir, writeFile, access } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import type { Paths } from './paths.ts';

const execFileAsync = promisify(execFile);

const LEGACY_SCRIPT = '.local/share/usage-collector/collector.mjs';

export type Scheduler = {
	/** Fails with a clear message if the schedule cannot be managed from here. Changes nothing. */
	check(): Promise<void>;
	/** The schedule files the site's usage-collector installed that are still here. Changes nothing. */
	findLegacy(): Promise<string[]>;
	/** Removes schedules the site's usage-collector installed. Returns what it removed. */
	removeLegacy(): Promise<string[]>;
	/** Writes the schedule from the templates and enables it. */
	install(node: string): Promise<void>;
	uninstall(): Promise<void>;
	/** Runs the collector once now. Some schedulers already do that when enabled. */
	runNow(): Promise<void>;
	describe: string;
};

export type Ctl = (cmd: string, args: string[], opts?: { tolerate?: boolean }) => Promise<void>;

/**
 * The only place that talks to systemctl and launchctl. BIG_SPENDER_SCHEDULER=none turns every
 * call into a no-op so tests can run `install` against a throwaway HOME.
 */
export function makeCtl(env: NodeJS.ProcessEnv): Ctl {
	if (env.BIG_SPENDER_SCHEDULER === 'none') return async () => {};
	return async (cmd, args, opts) => {
		try {
			await execFileAsync(cmd, args);
		} catch (err) {
			if (!opts?.tolerate) throw err;
		}
	};
}

const exists = (path: string) =>
	access(path).then(
		() => true,
		() => false
	);

async function render(templatesDir: string, name: string, vars: Record<string, string>) {
	let text = await readFile(join(templatesDir, name), 'utf8');
	for (const [key, value] of Object.entries(vars)) text = text.replaceAll(key, value);
	return text;
}

/**
 * Without a user manager (no login session, no lingering) disable and stop fail quietly, and
 * deleting the unit files afterwards would leave a timer nobody can stop and no way to retry.
 */
async function requireManager(ctl: Ctl) {
	try {
		await ctl('systemctl', ['--user', 'show-environment']);
	} catch {
		throw new Error(
			'cannot reach the systemd user manager (systemctl --user failed). Run this from a login session, or enable lingering with `loginctl enable-linger $USER`, then run install again. Nothing was changed.'
		);
	}
}

/** XDG dirs set at install time, which the scheduled collector must see to use the same files. */
type Xdg = [name: string, value: string][];

function systemd(paths: Paths, templatesDir: string, ctl: Ctl, xdg: Xdg): Scheduler {
	const user = ['--user'];
	const legacyFiles = ['usage-collector.service', 'usage-collector.timer'].map((f) =>
		join(paths.systemdDir, f)
	);
	const findLegacy = async () =>
		(await Promise.all(legacyFiles.map(async (f) => ((await exists(f)) ? f : null)))).filter(
			(f): f is string => f !== null
		);
	return {
		describe: 'systemd user timer (hourly). Log: journalctl --user -u big-spender',
		check: () => requireManager(ctl),
		findLegacy,
		async removeLegacy() {
			const present = await findLegacy();
			await ctl('systemctl', [...user, 'disable', '--now', 'usage-collector.timer'], {
				tolerate: true
			});
			await ctl('systemctl', [...user, 'stop', 'usage-collector.service'], { tolerate: true });
			if (!present.length) return [];
			await requireManager(ctl);
			for (const f of present) await rm(f, { force: true });
			await ctl('systemctl', [...user, 'daemon-reload']);
			return present;
		},
		async install(node) {
			await mkdir(paths.systemdDir, { recursive: true });
			await writeFile(
				join(paths.systemdDir, 'big-spender.service'),
				await render(templatesDir, 'big-spender.service', {
					__NODE__: node,
					__HOME__: paths.home,
					__ENV_FILE__: paths.envFile,
					'__ENVIRONMENT__\n': xdg.map(([k, v]) => `Environment="${k}=${v}"\n`).join('')
				})
			);
			await copyFile(
				join(templatesDir, 'big-spender.timer'),
				join(paths.systemdDir, 'big-spender.timer')
			);
			await ctl('systemctl', [...user, 'daemon-reload']);
			await ctl('systemctl', [...user, 'enable', '--now', 'big-spender.timer']);
		},
		async uninstall() {
			await ctl('systemctl', [...user, 'disable', '--now', 'big-spender.timer'], {
				tolerate: true
			});
			await rm(join(paths.systemdDir, 'big-spender.service'), { force: true });
			await rm(join(paths.systemdDir, 'big-spender.timer'), { force: true });
			await ctl('systemctl', [...user, 'daemon-reload']);
		},
		async runNow() {
			await ctl('systemctl', [...user, 'start', 'big-spender.service']);
		}
	};
}

function launchd(paths: Paths, templatesDir: string, ctl: Ctl, xdg: Xdg): Scheduler {
	const label = 'local.big-spender';
	const plist = join(paths.launchAgentsDir, `${label}.plist`);
	const domain = `gui/${process.getuid?.() ?? 0}`;
	const bootout = (name: string) =>
		ctl('launchctl', ['bootout', `${domain}/${name}`], { tolerate: true });
	const findLegacy = async () => {
		const found: string[] = [];
		const names = await readdir(paths.launchAgentsDir).catch(() => [] as string[]);
		for (const name of names.filter((n) => n.endsWith('.usage-collector.plist'))) {
			const file = join(paths.launchAgentsDir, name);
			const isOurs =
				name === 'local.usage-collector.plist' ||
				(await readFile(file, 'utf8').catch(() => '')).includes(LEGACY_SCRIPT);
			if (isOurs) found.push(file);
		}
		return found;
	};
	return {
		check: async () => {},
		describe: `launchd agent (hourly + at login). Log: ${join(paths.logsDir, 'big-spender.log')}`,
		findLegacy,
		async removeLegacy() {
			const found = await findLegacy();
			for (const file of found) {
				await bootout(basename(file, '.plist'));
				await rm(file, { force: true });
			}
			return found;
		},
		async install(node) {
			await mkdir(paths.launchAgentsDir, { recursive: true });
			await mkdir(paths.logsDir, { recursive: true });
			await writeFile(
				plist,
				await render(templatesDir, 'local.big-spender.plist', {
					__NODE__: node,
					__HOME__: paths.home,
					'__ENVIRONMENT__\n': xdg.length
						? `\t<key>EnvironmentVariables</key>\n\t<dict>\n${xdg
								.map(([k, v]) => `\t\t<key>${k}</key>\n\t\t<string>${v}</string>\n`)
								.join('')}\t</dict>\n`
						: ''
				})
			);
			await bootout(label);
			await ctl('launchctl', ['bootstrap', domain, plist]);
		},
		async uninstall() {
			await bootout(label);
			await rm(plist, { force: true });
		},
		async runNow() {
			// RunAtLoad already ran it when the agent was bootstrapped.
		}
	};
}

export function pickScheduler(
	env: NodeJS.ProcessEnv,
	platform: NodeJS.Platform,
	paths: Paths,
	templatesDir: string,
	ctl: Ctl = makeCtl(env)
): Scheduler {
	const xdg: Xdg = ['XDG_CONFIG_HOME', 'XDG_CACHE_HOME'].flatMap((k) =>
		env[k] ? [[k, env[k]]] : []
	);
	const table: Partial<Record<NodeJS.Platform, () => Scheduler>> = {
		linux: () => systemd(paths, templatesDir, ctl, xdg),
		darwin: () => launchd(paths, templatesDir, ctl, xdg)
	};
	const make = table[platform] ?? (env.BIG_SPENDER_SCHEDULER === 'none' ? table.linux : undefined);
	if (!make)
		throw new Error(`scheduling is not supported on ${platform}; run \`big-spender push\` instead`);
	return make();
}
