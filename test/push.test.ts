import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
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
			const { ctx, err } = harness(box, {
				answers: ['y'],
				env: { BIG_SPENDER_INGEST_URL: url, BIG_SPENDER_INGEST_TOKEN: 'wrong' }
			});
			assert.equal(await main(['push', 'laptop'], ctx), 1);
			assert.match(err.join('\n'), /401/);
			assert.doesNotMatch(err.join('\n'), /wrong/);
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

test('push sends the exact snapshot it showed, from a single collector run', async () => {
	await withSandbox(async (box) => {
		await seedPricing(join(box.env.XDG_CACHE_HOME, 'big-spender'));
		await writeClaudeLog(box, 'claude-test-model');

		const record = join(box.home, 'record');
		await mkdir(record);
		const wrapper = join(box.home, 'collector-wrapper.mjs');
		const collector = new URL('../src/collector.mjs', import.meta.url).href;
		await writeFile(
			wrapper,
			`import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(join(record, 'runs'))}, process.argv.slice(2).join(' ') + '\\n');
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
	appendFileSync(${JSON.stringify(join(record, 'stdout'))}, chunk);
	return write(chunk, ...rest);
};
await import(${JSON.stringify(collector)});
`
		);

		const received: { headers: IncomingHttpHeaders; body: Buffer }[] = [];
		const server = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on('data', (c: Buffer) => chunks.push(c));
			req.on('end', () => {
				received.push({ headers: req.headers, body: Buffer.concat(chunks) });
				res.setHeader('content-type', 'application/json');
				res.end('{"ok":true,"stored":"laptop"}');
			});
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		try {
			const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/usage/ingest`;
			const { ctx, out, err } = harness(box, {
				answers: ['y'],
				env: { BIG_SPENDER_INGEST_URL: url, BIG_SPENDER_INGEST_TOKEN: 'tok-s5' }
			});
			ctx.collector = wrapper;
			assert.equal(await main(['push', 'laptop'], ctx), 0, err.join('\n'));

			assert.deepEqual((await readFile(join(record, 'runs'), 'utf8')).split('\n'), [
				'--dry-run',
				''
			]);
			assert.equal(received.length, 1);
			const [{ headers, body }] = received;
			assert.equal(
				gunzipSync(body).toString('utf8'),
				await readFile(join(record, 'stdout'), 'utf8')
			);
			assert.equal(headers.authorization, 'Bearer tok-s5');
			assert.equal(headers['content-type'], 'application/json');
			assert.equal(headers['content-encoding'], 'gzip');

			const printed = [...out, ...err].join('\n');
			assert.match(printed, new RegExp(`posted 1 rows \\(${body.length} bytes gzipped\\)`));
			assert.ok(printed.includes('{"ok":true,"stored":"laptop"}'), printed);
			assert.doesNotMatch(printed, /tok-s5/);
		} finally {
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		}
	});
});

test('an empty answer falls back to the env file the collector reads, wherever it points', async () => {
	await withSandbox(async (box) => {
		await seedPricing(join(box.env.XDG_CACHE_HOME, 'big-spender'));
		await withIngestServer(box, async (url, dataDir) => {
			const custom = join(box.home, 'custom.env');
			await writeFile(custom, `BIG_SPENDER_INGEST_URL=${url}\nBIG_SPENDER_INGEST_TOKEN=tok\n`, {
				mode: 0o600
			});
			for (const name of ['BIG_SPENDER_ENV_FILE', 'USAGE_ENV_FILE']) {
				await rm(dataDir, { recursive: true, force: true });
				const { ctx, err } = harness(box, { answers: ['y', '', ''], env: { [name]: custom } });
				assert.equal(await main(['push', 'laptop'], ctx), 0, `${name}: ${err.join('\n')}`);
				const stored = JSON.parse(await readFile(join(dataDir, 'laptop.json'), 'utf8'));
				assert.equal(stored.deviceId, 'laptop');
			}
		});
	});
});

test('a token that cannot go in an HTTP header fails at once and is never printed', async () => {
	await withSandbox(async (box) => {
		await seedPricing(join(box.env.XDG_CACHE_HOME, 'big-spender'));
		await withIngestServer(box, async (url, dataDir) => {
			const { ctx, out, err } = harness(box, { answers: ['y', url, 'sekrit-1\rsekrit-2'] });
			assert.equal(await main(['push', 'laptop'], ctx), 1);
			const printed = [...out, ...err].join('\n');
			assert.doesNotMatch(printed, /sekrit/);
			assert.doesNotMatch(printed, /retrying/);
			assert.match(printed, /not allowed in an HTTP header/);
			assert.equal(
				await readdir(dataDir)
					.catch(() => [])
					.then((l) => l.length),
				0
			);
		});
	});
});

test('an older server gets the limits without accounts, and one older still gets none', async () => {
	await withSandbox(async (box) => {
		await seedPricing(join(box.env.XDG_CACHE_HOME, 'big-spender'));
		await writeClaudeLog(box, 'claude-test-model');
		const profile = join(
			box.home,
			'.t3',
			'userdata',
			'providers',
			'antigravity',
			'p1',
			'antigravity-acp'
		);
		await mkdir(profile, { recursive: true });
		const expiry = new Date(Date.now() + 3_600_000).toISOString();
		await writeFile(
			join(profile, 'antigravity-oauth-token'),
			JSON.stringify({ token: { access_token: 'ag', expiry }, id_token_email: 'a@example.com' })
		);
		const resetTime = new Date(Date.now() + 3_600_000).toISOString();
		const bodies: Record<string, unknown>[] = [];
		const server = createServer(async (req, res) => {
			res.setHeader('content-type', 'application/json');
			if (req.url?.startsWith('/quota')) {
				res.end(
					JSON.stringify({
						buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.5, resetTime }]
					})
				);
				return;
			}
			const chunks: Buffer[] = [];
			for await (const c of req) chunks.push(c as Buffer);
			const body = JSON.parse(gunzipSync(Buffer.concat(chunks)).toString());
			bodies.push(body);
			const issue = !('limits' in body)
				? null
				: body.limits.some((w: object) => 'account' in w)
					? 'limits.0: Unrecognized key: "account"'
					: '(root): Unrecognized key: "limits"';
			res.statusCode = issue ? 422 : 200;
			res.end(
				JSON.stringify(issue ? { error: 'invalid snapshot', issues: [issue] } : { ok: true })
			);
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		try {
			const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
			const { ctx, err } = harness(box, {
				answers: ['y'],
				env: {
					BIG_SPENDER_INGEST_URL: `${base}/ingest`,
					BIG_SPENDER_INGEST_TOKEN: 'tok',
					BIG_SPENDER_ANTIGRAVITY_DAILY_URL: `${base}/quota`,
					BIG_SPENDER_ANTIGRAVITY_USAGE_URL: `${base}/quota`
				}
			});
			assert.equal(await main(['push', 'laptop'], ctx), 0, err.join('\n'));
			assert.equal(bodies.length, 3);
			assert.equal((bodies[0].limits as object[]).length, 1);
			assert.deepEqual(Object.keys((bodies[1].limits as object[])[0]).includes('account'), false);
			assert.equal('limits' in bodies[2], false);
			assert.match(
				err.join('\n'),
				/too old to tell accounts apart[\s\S]*too old to store limit data/
			);
		} finally {
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		}
	});
});

test('a server that keeps refusing accounts fails the push after one retry', async () => {
	await withSandbox(async (box) => {
		await seedPricing(join(box.env.XDG_CACHE_HOME, 'big-spender'));
		await writeClaudeLog(box, 'claude-test-model');
		const profile = join(
			box.home,
			'.t3',
			'userdata',
			'providers',
			'antigravity',
			'p1',
			'antigravity-acp'
		);
		await mkdir(profile, { recursive: true });
		const expiry = new Date(Date.now() + 3_600_000).toISOString();
		await writeFile(
			join(profile, 'antigravity-oauth-token'),
			JSON.stringify({ token: { access_token: 'ag', expiry }, id_token_email: 'a@example.com' })
		);
		const resetTime = new Date(Date.now() + 3_600_000).toISOString();
		const bodies: Record<string, unknown>[] = [];
		const server = createServer(async (req, res) => {
			res.setHeader('content-type', 'application/json');
			if (req.url?.startsWith('/quota')) {
				res.end(
					JSON.stringify({
						buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.5, resetTime }]
					})
				);
				return;
			}
			const chunks: Buffer[] = [];
			for await (const c of req) chunks.push(c as Buffer);
			const body = JSON.parse(gunzipSync(Buffer.concat(chunks)).toString());
			bodies.push(body);
			res.statusCode = 422;
			res.end(
				JSON.stringify({
					error: 'invalid snapshot',
					issues: ['limits.0: Unrecognized key: "account"']
				})
			);
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		try {
			const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
			const { ctx, err } = harness(box, {
				answers: ['y'],
				env: {
					BIG_SPENDER_INGEST_URL: `${base}/ingest`,
					BIG_SPENDER_INGEST_TOKEN: 'tok',
					BIG_SPENDER_ANTIGRAVITY_DAILY_URL: `${base}/quota`,
					BIG_SPENDER_ANTIGRAVITY_USAGE_URL: `${base}/quota`
				}
			});
			assert.equal(await main(['push', 'laptop'], ctx), 1);
			assert.equal(bodies.length, 2);
			assert.match(err.join('\n'), /422/);
		} finally {
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		}
	});
});
