import { execFile } from 'node:child_process';
import { readdir, readFile, rm, copyFile, mkdir, writeFile, access } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import type { Paths } from './paths.ts';

const execFileAsync = promisify(execFile);

const LEGACY_SCRIPT = '.local/share/usage-collector/collector.mjs';

export type Scheduler = {
	/** Removes schedules the site's usage-collector installed. Returns what it removed. */
	removeLegacy(): Promise<string[]>;
	/** Writes the schedule from the templates and enables it. */
	install(node: string): Promise<void>;
	uninstall(): Promise<void>;
	/** Runs the collector once now. Some schedulers already do that when enabled. */
	runNow(): Promise<void>;
	describe: string;
};

type Ctl = (cmd: string, args: string[], opts?: { tolerate?: boolean }) => Promise<void>;

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

function systemd(paths: Paths, templatesDir: string, ctl: Ctl): Scheduler {
	const user = ['--user'];
	const legacyFiles = ['usage-collector.service', 'usage-collector.timer'].map((f) =>
		join(paths.systemdDir, f)
	);
	return {
		describe: 'systemd user timer (hourly). Log: journalctl --user -u big-spender',
		async removeLegacy() {
			const present = (
				await Promise.all(legacyFiles.map(async (f) => ((await exists(f)) ? f : null)))
			).filter((f): f is string => f !== null);
			if (!present.length) return [];
			await ctl('systemctl', [...user, 'disable', '--now', 'usage-collector.timer'], {
				tolerate: true
			});
			await ctl('systemctl', [...user, 'stop', 'usage-collector.service'], { tolerate: true });
			for (const f of present) await rm(f, { force: true });
			await ctl('systemctl', [...user, 'daemon-reload']);
			return present;
		},
		async install(node) {
			await mkdir(paths.systemdDir, { recursive: true });
			await writeFile(
				join(paths.systemdDir, 'big-spender.service'),
				await render(templatesDir, 'big-spender.service', { __NODE__: node, __HOME__: paths.home })
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

function launchd(paths: Paths, templatesDir: string, ctl: Ctl): Scheduler {
	const label = 'local.big-spender';
	const plist = join(paths.launchAgentsDir, `${label}.plist`);
	const domain = `gui/${process.getuid?.() ?? 0}`;
	const bootout = (name: string) =>
		ctl('launchctl', ['bootout', `${domain}/${name}`], { tolerate: true });
	return {
		describe: `launchd agent (hourly + at login). Log: ${join(paths.logsDir, 'big-spender.log')}`,
		async removeLegacy() {
			const removed: string[] = [];
			const names = await readdir(paths.launchAgentsDir).catch(() => [] as string[]);
			for (const name of names.filter((n) => n.endsWith('.usage-collector.plist'))) {
				const file = join(paths.launchAgentsDir, name);
				const isOurs =
					name === 'local.usage-collector.plist' ||
					(await readFile(file, 'utf8').catch(() => '')).includes(LEGACY_SCRIPT);
				if (!isOurs) continue;
				await bootout(basename(name, '.plist'));
				await rm(file, { force: true });
				removed.push(file);
			}
			return removed;
		},
		async install(node) {
			await mkdir(paths.launchAgentsDir, { recursive: true });
			await mkdir(paths.logsDir, { recursive: true });
			await writeFile(
				plist,
				await render(templatesDir, 'local.big-spender.plist', {
					__NODE__: node,
					__HOME__: paths.home
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
	templatesDir: string
): Scheduler {
	const ctl = makeCtl(env);
	const table: Partial<Record<NodeJS.Platform, () => Scheduler>> = {
		linux: () => systemd(paths, templatesDir, ctl),
		darwin: () => launchd(paths, templatesDir, ctl)
	};
	const make = table[platform] ?? (env.BIG_SPENDER_SCHEDULER === 'none' ? table.linux : undefined);
	if (!make)
		throw new Error(`scheduling is not supported on ${platform}; run \`big-spender push\` instead`);
	return make();
}
