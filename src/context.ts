import { fileURLToPath } from 'node:url';
import { resolvePaths, type Paths } from './paths.ts';
import type { Ctl } from './scheduler.ts';
import { createPrompter, type Prompter } from './prompt.ts';

/** Everything a command reads from its surroundings, so tests can hand it a throwaway HOME. */
export type Context = {
	env: NodeJS.ProcessEnv;
	platform: NodeJS.Platform;
	paths: Paths;
	/** The collector bundled with this package. `install` copies it to `paths.collector`. */
	collector: string;
	templatesDir: string;
	prompter: () => Prompter;
	/** Replaces systemctl and launchctl, so tests can watch and fail the calls. */
	ctl?: Ctl;
	/** Releases the prompter if one was opened, so stdin does not keep the process alive. */
	dispose(): void;
	out(line: string): void;
	err(line: string): void;
};

export function defaultContext(): Context {
	let prompter: Prompter | undefined;
	return {
		env: process.env,
		platform: process.platform,
		paths: resolvePaths(),
		collector: fileURLToPath(new URL('./collector.mjs', import.meta.url)),
		templatesDir: fileURLToPath(new URL('../templates', import.meta.url)),
		prompter: () => (prompter ??= createPrompter()),
		dispose: () => prompter?.close(),
		out: (line) => console.log(line),
		err: (line) => console.error(line)
	};
}

export class UsageError extends Error {}
