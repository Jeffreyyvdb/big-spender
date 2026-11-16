import { execFile, spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import { UsageError, type Context } from './context.ts';
import { setting } from './envfile.ts';
import { DEVICE_ID, type UsageSnapshot } from './schema.ts';

export const PUSH_USAGE = `Usage: big-spender push <device> [--dry-run] [--url <ingest url>]

One-off push from a machine without a schedule. Builds the snapshot, shows what it would publish
and stops if a model name looks like a cloud resource id (for example a Bedrock inference-profile
ARN, which contains an account id). Asks before sending. The URL comes from --url,
BIG_SPENDER_INGEST_URL or a prompt, and the token from BIG_SPENDER_INGEST_TOKEN or a hidden
prompt, so neither is written to this machine. Nothing is scheduled.

--dry-run prints the overview, writes the exact JSON that would be sent to
$TMPDIR/big-spender-snapshot-<device>.json and never asks for the token. Both modes update the
collector's local state in ~/.cache/big-spender (which logs were read), never anything remote.`;

const MAX_SNAPSHOT_BYTES = 512 * 1024 * 1024;

function runCollector(ctx: Context, extraEnv: Record<string, string>, args: string[]) {
	return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
		execFile(
			process.execPath,
			[ctx.collector, ...args],
			{ env: { ...ctx.env, ...extraEnv }, maxBuffer: MAX_SNAPSHOT_BYTES },
			(err, stdout, stderr) => {
				const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
				resolve({ code, stdout, stderr });
			}
		);
	});
}

function overview(snapshot: UsageSnapshot): string[] {
	const byModel = new Map<string, { tokens: number; cost: number }>();
	for (const r of snapshot.hourly) {
		const key = `${r.provider}  ${r.model}`;
		const m = byModel.get(key) ?? { tokens: 0, cost: 0 };
		m.tokens +=
			r.inputTokens +
			r.cacheReadTokens +
			r.cacheWrite5mTokens +
			r.cacheWrite1hTokens +
			r.outputTokens;
		m.cost += r.costUsd.input + r.costUsd.cacheRead + r.costUsd.cacheWrite + r.costUsd.output;
		byModel.set(key, m);
	}
	const rows = [...byModel].sort((a, b) => b[1].cost - a[1].cost);
	const width = Math.max(20, ...rows.map(([k]) => k.length));
	const days = snapshot.hourly.map((r) => r.hour.slice(0, 10)).sort();
	const gzipped = gzipSync(JSON.stringify(snapshot)).length;
	const line = (label: string, tokens: number, cost: number) =>
		`  ${label.padEnd(width)}  ${`${(tokens / 1e6).toFixed(1)}M`.padStart(10)}  ${`$${cost.toFixed(2)}`.padStart(10)}`;

	let tokens = 0;
	let cost = 0;
	for (const [, m] of rows) {
		tokens += m.tokens;
		cost += m.cost;
	}
	return [
		'',
		`Snapshot for "${snapshot.deviceId}": ${snapshot.hourly.length} rows, ${days[0] ?? '-'} to ${days.at(-1) ?? '-'}, ${gzipped} bytes gzipped`,
		'Model names are published on the server as shown.',
		'',
		`  ${'provider  model'.padEnd(width)}  ${'tokens'.padStart(10)}  ${'cost'.padStart(10)}`,
		...rows.map(([k, m]) => line(k, m.tokens, m.cost)),
		line('total', tokens, cost)
	];
}

export async function push(args: string[], ctx: Context): Promise<number> {
	const { values, positionals } = parseArgs({
		args,
		options: { 'dry-run': { type: 'boolean' }, url: { type: 'string' } },
		allowPositionals: true,
		strict: true
	});
	const deviceId = positionals[0] ?? '';
	if (positionals.length !== 1 || !DEVICE_ID.test(deviceId)) {
		throw new UsageError('<device> must be a lowercase slug such as laptop or desktop');
	}

	const built = await runCollector(ctx, { BIG_SPENDER_DEVICE_ID: deviceId }, ['--dry-run']);
	if (built.code !== 0) {
		ctx.err(built.stderr.trimEnd());
		return 1;
	}
	for (const line of built.stderr.split('\n')) if (/warning/i.test(line)) ctx.err(line);

	const snapshot = JSON.parse(built.stdout) as UsageSnapshot;
	for (const line of overview(snapshot)) ctx.out(line);

	const blocked = snapshot.hourly.some((r) => /arn:|\//i.test(r.model));
	if (blocked) {
		ctx.err('\nWould NOT send: a model name looks like a cloud resource id or gateway path.');
	}

	if (values['dry-run']) {
		const file = join(ctx.paths.tmpDir, `big-spender-snapshot-${deviceId}.json`);
		await writeFile(file, built.stdout);
		ctx.out(`\nDry run: nothing sent. The exact JSON that would be sent is in ${file}`);
		return blocked ? 1 : 0;
	}
	if (blocked) return 1;

	const prompter = ctx.prompter();
	const answer = await prompter.ask(`\nSend this snapshot as "${deviceId}"? [y/N] `);
	if (!/^[yY]$/.test(answer)) {
		ctx.out('Nothing sent.');
		return 0;
	}

	const url =
		values.url ??
		(setting(ctx.env, 'INGEST_URL') ||
			(await prompter.ask('Ingest URL (https://…/api/usage/ingest): ')));
	const token = setting(ctx.env, 'INGEST_TOKEN') || (await prompter.askHidden('Ingest token: '));
	// Pass only what was given, so an empty answer still lets the collector read its env file.
	const given: Record<string, string> = { BIG_SPENDER_DEVICE_ID: deviceId };
	if (url) given.BIG_SPENDER_INGEST_URL = url;
	if (token) given.BIG_SPENDER_INGEST_TOKEN = token;

	return new Promise<number>((resolve) => {
		const child = spawn(process.execPath, [ctx.collector], {
			env: { ...ctx.env, ...given },
			stdio: ['ignore', 'inherit', 'inherit']
		});
		child.on('close', (code) => resolve(code ?? 1));
	});
}
