#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defaultContext, UsageError, type Context } from './context.ts';
import { install, INSTALL_USAGE, uninstall, UNINSTALL_USAGE } from './install.ts';
import { push, PUSH_USAGE } from './push.ts';
import { serve, SERVE_USAGE } from './serve.ts';

type Command = {
	summary: string;
	usage: string;
	run(args: string[], ctx: Context): Promise<number>;
};

const status: Command = {
	summary: "Print this machine's 24h usage summary. Sends nothing.",
	usage: 'Usage: big-spender status',
	run: (_args, ctx) =>
		new Promise((resolve) => {
			const child = spawn(process.execPath, [ctx.collector, '--summary'], {
				env: ctx.env,
				stdio: 'inherit'
			});
			child.on('close', (code) => resolve(code ?? 1));
		})
};

export const commands: Record<string, Command> = {
	install: {
		summary: 'Schedule the collector on this machine and run it once.',
		usage: INSTALL_USAGE,
		run: install
	},
	uninstall: {
		summary: 'Remove the schedule. Keeps the env file and state.',
		usage: UNINSTALL_USAGE,
		run: uninstall
	},
	push: {
		summary: 'Review and send one snapshot by hand, without a schedule.',
		usage: PUSH_USAGE,
		run: push
	},
	status,
	serve: {
		summary: 'Run the server: ingest, JSON API and a plain HTML page.',
		usage: SERVE_USAGE,
		run: async (args) => {
			await serve(args);
			return 0;
		}
	},
	help: {
		summary: 'Show this help, or help for one command.',
		usage: 'Usage: big-spender help [command]',
		run: async (args, ctx) => {
			const [name] = args;
			if (name && Object.hasOwn(commands, name)) ctx.out(commands[name].usage);
			else ctx.out(helpText());
			return 0;
		}
	}
};

function helpText(): string {
	const width = Math.max(...Object.keys(commands).map((n) => n.length));
	return [
		'big-spender: track what your AI coding agents would cost at API prices.',
		'',
		'Usage: big-spender <command> [options]',
		'',
		...Object.entries(commands).map(([name, c]) => `  ${name.padEnd(width)}  ${c.summary}`),
		'',
		"Run `big-spender help <command>` for a command's options."
	].join('\n');
}

export async function main(argv: string[], ctx: Context): Promise<number> {
	const [name, ...args] = argv;
	if (!name || name === '--help' || name === '-h') {
		ctx.out(helpText());
		return name ? 0 : 2;
	}
	if (!Object.hasOwn(commands, name)) {
		ctx.err(`unknown command "${name}"\n\n${helpText()}`);
		return 2;
	}
	const command = commands[name];
	if (args.includes('--help') || args.includes('-h')) {
		ctx.out(command.usage);
		return 0;
	}
	try {
		return await command.run(args, ctx);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const isUsage =
			err instanceof UsageError || (err as { code?: string }).code?.startsWith('ERR_PARSE_ARGS');
		ctx.err(`big-spender ${name}: ${message}`);
		if (isUsage) ctx.err(`\n${command.usage}`);
		return isUsage ? 2 : 1;
	} finally {
		if (name !== 'serve') ctx.dispose();
	}
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2), defaultContext()).then((code) => {
		if (code !== 0) process.exitCode = code;
	});
}
