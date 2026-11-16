import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where everything lives on one machine, resolved once from the environment. */
export type Paths = {
	home: string;
	tmpDir: string;
	envFile: string;
	configDir: string;
	cacheDir: string;
	shareDir: string;
	collector: string;
	systemdDir: string;
	launchAgentsDir: string;
	logsDir: string;
	legacy: { configDir: string; cacheDir: string; shareDir: string; lock: string };
};

export function resolvePaths(env: NodeJS.ProcessEnv = process.env, home = homedir()): Paths {
	const config = env.XDG_CONFIG_HOME || join(home, '.config');
	const cache = env.XDG_CACHE_HOME || join(home, '.cache');
	const share = join(home, '.local', 'share');
	const configDir = join(config, 'big-spender');
	const shareDir = join(share, 'big-spender');
	const legacyCacheDir = join(cache, 'usage-collector');
	return {
		home,
		tmpDir: env.TMPDIR || env.TEMP || '/tmp',
		envFile: join(configDir, 'env'),
		configDir,
		cacheDir: join(cache, 'big-spender'),
		shareDir,
		collector: join(shareDir, 'collector.mjs'),
		systemdDir: join(config, 'systemd', 'user'),
		launchAgentsDir: join(home, 'Library', 'LaunchAgents'),
		logsDir: join(home, 'Library', 'Logs'),
		legacy: {
			configDir: join(config, 'usage-collector'),
			cacheDir: legacyCacheDir,
			shareDir: join(share, 'usage-collector'),
			lock: join(legacyCacheDir, 'run.lock')
		}
	};
}
