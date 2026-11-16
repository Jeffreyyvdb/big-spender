import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.ts';
import { createBigSpender } from '../src/server/index.ts';
import { createHttpServer } from '../src/serve.ts';
import { harness, run, seedPricing, withSandbox, type Sandbox } from './helpers.ts';

async function writeClaudeLog(box: Sandbox, model: string) {
	const dir = join(box.home, '.claude', 'projects', 'p');
	await mkdir(dir, { recursive: true });
	const line = {
		type: 'assistant',
		timestamp: new Date().toISOString(),
		requestId: 'req-1',
		sessionId: 'session-1',
		message: { id: 'msg-1', model, usage: { input_tokens: 1000, output_tokens: 500 } }
	};
	await writeFile(join(dir, 'session.jsonl'), `${JSON.stringify(line)}\n`);
}

async function withIngestServer(box: Sandbox, fn: (url: string, dataDir: string) => Promise<void>) {
	const dataDir = join(box.home, 'server-data');
	const bs = createBigSpender({ dataDir, ingestToken: 'tok', devices: { devices: {} } });
	const server = createHttpServer(bs);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	try {
		await fn(
			`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/usage/ingest`,
			dataDir
		);
	} finally {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	}
}

test('push --dry-run shows the overview, keeps the JSON, and never asks for anything', async () => {
	await withSandbox(async (box) => {
		await seedPricing(join(box.env.XDG_CACHE_HOME, 'big-spender'));
		await writeClaudeLog(box, 'claude-test-model');
		const { ctx, out, asked } = harness(box);

		assert.equal(await main(['push', 'laptop', '--dry-run'], ctx), 0);
		assert.deepEqual(asked, []);
		const text = out.join('\n');
		assert.match(text, /Snapshot for "laptop": 1 rows/);
		assert.match(text, /claude {2}claude-test-model/);
		assert.match(text, /Model names are published on the server as shown/);

		const file = join(box.home, 'big-spender-snapshot-laptop.json');
		const snapshot = JSON.parse(await readFile(file, 'utf8'));
		assert.equal(snapshot.deviceId, 'laptop');
		assert.equal(snapshot.hourly[0].inputTokens, 1000);
		assert.ok(text.includes(file));
	});
});

test('a model name that looks like a resource id or gateway path is never sent', async () => {
	await withSandbox(async (box) => {
		await seedPricing(join(box.env.XDG_CACHE_HOME, 'big-spender'));
		await writeClaudeLog(box, 'gateway/some-model');

		const dry = harness(box);
		assert.equal(await main(['push', 'laptop', '--dry-run'], dry.ctx), 1);
		assert.match(dry.err.join('\n'), /Would NOT send/);

		const real = harness(box);
		assert.equal(await main(['push', 'laptop'], real.ctx), 1);
		assert.deepEqual(real.asked, []);
	});
});

test('declining the confirmation sends nothing and asks for no secrets', async () => {
	await withSandbox(async (box) => {
		await seedPricing(join(box.env.XDG_CACHE_HOME, 'big-spender'));
		await writeClaudeLog(box, 'claude-test-model');
		const { ctx, out, asked } = harness(box, { answers: ['n'] });

		assert.equal(await main(['push', 'laptop'], ctx), 0);
		assert.equal(asked.length, 1);
		assert.match(asked[0], /Send this snapshot as "laptop"\? \[y\/N\]/);
		assert.ok(out.includes('Nothing sent.'));
	});
});

test('confirming sends the snapshot with a prompted URL and token, and stores neither', async () => {
	await withSandbox(async (box) => {
		await seedPricing(join(box.env.XDG_CACHE_HOME, 'big-spender'));
		await writeClaudeLog(box, 'claude-test-model');
		await withIngestServer(box, async (url, dataDir) => {
			const { ctx, out, err, asked } = harness(box, { answers: ['y', url, 'tok'] });
			assert.equal(await main(['push', 'laptop'], ctx), 0, err.join('\n'));
			assert.deepEqual(asked.length, 3);

			const stored = JSON.parse(await readFile(join(dataDir, 'laptop.json'), 'utf8'));
			assert.equal(stored.hourly[0].model, 'claude-test-model');
			assert.doesNotMatch([...out, ...err].join('\n'), /tok(?!en)/);
			assert.equal(
				await readdir(box.env.XDG_CONFIG_HOME)
					.catch(() => [])
					.then((l) => l.length),
				0
			);
		});
	});
});

test('a wrong token fails the push with the server status', async () => {
	await withSandbox(async (box) => {
		await seedPricing(join(box.env.XDG_CACHE_HOME, 'big-spender'));
		await withIngestServer(box, async (url) => {
			const { ctx } = harness(box, {
				answers: ['y'],
				env: { BIG_SPENDER_INGEST_URL: url, BIG_SPENDER_INGEST_TOKEN: 'wrong' }
			});
			assert.equal(await main(['push', 'laptop'], ctx), 1);
		});
	});
});

test('the CLI entry point runs from source and from a symlink-free path', async () => {
	await withSandbox(async (box) => {
		const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
		const help = await run(cli, ['help'], box.env);
		assert.equal(help.code, 0);
		assert.match(help.stdout, /install\s+Schedule the collector/);

		const unknown = await run(cli, ['nope'], box.env);
		assert.equal(unknown.code, 2);
		const noArgs = await run(cli, [], box.env);
		assert.equal(noArgs.code, 2);
	});
});
