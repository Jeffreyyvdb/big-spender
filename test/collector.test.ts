import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBigSpender } from '../src/server/index.ts';
import { createHttpServer } from '../src/serve.ts';
import { run, seedPricing, withSandbox } from './helpers.ts';

const COLLECTOR = fileURLToPath(new URL('../src/collector.mjs', import.meta.url));

test('the device id is read from the new name, then the legacy one', async () => {
	await withSandbox(async ({ env }) => {
		await seedPricing(join(env.XDG_CACHE_HOME, 'big-spender'));
		const deviceOf = async (extra: Record<string, string>) => {
			const res = await run(COLLECTOR, ['--dry-run'], { ...env, ...extra });
			assert.equal(res.code, 0, res.stderr);
			return JSON.parse(res.stdout).deviceId;
		};

		assert.equal(await deviceOf({ USAGE_DEVICE_ID: 'legacy' }), 'legacy');
		assert.equal(await deviceOf({ BIG_SPENDER_DEVICE_ID: 'fresh' }), 'fresh');
		assert.equal(
			await deviceOf({ BIG_SPENDER_DEVICE_ID: 'fresh', USAGE_DEVICE_ID: 'legacy' }),
			'fresh'
		);
		assert.equal(
			await deviceOf({ BIG_SPENDER_DEVICE_ID: '', USAGE_DEVICE_ID: 'legacy' }),
			'legacy'
		);
		assert.ok(existsSync(join(env.XDG_CACHE_HOME, 'big-spender', 'state.json')));
		assert.ok(!existsSync(join(env.XDG_CACHE_HOME, 'usage-collector')));
	});
});

test('a legacy env file still posts to a server', async () => {
	await withSandbox(async ({ env }) => {
		await seedPricing(join(env.XDG_CACHE_HOME, 'big-spender'));
		const dataDir = join(env.HOME, 'data');
		const bs = createBigSpender({ dataDir, ingestToken: 'tok', devices: { devices: {} } });
		const server = createHttpServer(bs);
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		try {
			const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/usage/ingest`;
			const configDir = join(env.XDG_CONFIG_HOME, 'big-spender');
			await mkdir(configDir, { recursive: true });
			const envFile = (prefix: string) =>
				[
					`${prefix}_DEVICE_ID=laptop`,
					`${prefix}_INGEST_URL=${url}`,
					`${prefix}_INGEST_TOKEN='tok'`,
					''
				].join('\n');

			for (const prefix of ['USAGE', 'BIG_SPENDER']) {
				await writeFile(join(configDir, 'env'), envFile(prefix), { mode: 0o600 });
				const res = await run(COLLECTOR, [], env);
				assert.equal(res.code, 0, res.stderr);
				assert.match(res.stderr, /posted 0 rows/);
				const stored = JSON.parse(await readFile(join(dataDir, 'laptop.json'), 'utf8'));
				assert.equal(stored.deviceId, 'laptop');
			}

			await writeFile(join(configDir, 'env'), envFile('BIG_SPENDER').replace(`'tok'`, 'wrong'));
			const refused = await run(COLLECTOR, [], env);
			assert.equal(refused.code, 1);
			assert.match(refused.stderr, /HTTP 401/);
			assert.doesNotMatch(refused.stderr, /wrong/);
		} finally {
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		}
	});
});

test('a real device id is required to post', async () => {
	await withSandbox(async ({ env }) => {
		await seedPricing(join(env.XDG_CACHE_HOME, 'big-spender'));
		const res = await run(COLLECTOR, [], env);
		assert.equal(res.code, 1);
		assert.match(res.stderr, /BIG_SPENDER_DEVICE_ID must be a lowercase slug/);
	});
});

test('a token that cannot go in an HTTP header fails at once and is never printed', async () => {
	await withSandbox(async ({ env }) => {
		await seedPricing(join(env.XDG_CACHE_HOME, 'big-spender'));
		const dataDir = join(env.HOME, 'data');
		const bs = createBigSpender({ dataDir, ingestToken: 'tok', devices: { devices: {} } });
		const server = createHttpServer(bs);
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		try {
			const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/usage/ingest`;
			const configDir = join(env.XDG_CONFIG_HOME, 'big-spender');
			await mkdir(configDir, { recursive: true });
			const base = { ...env, BIG_SPENDER_DEVICE_ID: 'laptop', BIG_SPENDER_INGEST_URL: url };

			await writeFile(join(configDir, 'env'), 'BIG_SPENDER_INGEST_TOKEN=sekrit-1\x01sekrit-2\n', {
				mode: 0o600
			});
			const fromFile = await run(COLLECTOR, [], base);
			const fromEnv = await run(COLLECTOR, [], {
				...base,
				BIG_SPENDER_INGEST_TOKEN: 'sekrit-1\rsekrit-2'
			});
			for (const res of [fromEnv, fromFile]) {
				assert.equal(res.code, 1);
				const printed = res.stdout + res.stderr;
				assert.doesNotMatch(printed, /sekrit/);
				assert.doesNotMatch(printed, /retrying/);
				assert.match(printed, /not allowed in an HTTP header/);
			}
			assert.equal(existsSync(join(dataDir, 'laptop.json')), false);
		} finally {
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		}
	});
});
