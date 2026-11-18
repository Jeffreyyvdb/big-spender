import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createBigSpender } from '../src/server/index.ts';
import { createHttpServer, loadServeConfig } from '../src/serve.ts';
import { snapshot, withTempDir } from './helpers.ts';

const TOKEN = 'secret-token';

async function withServer(
	dir: string,
	run: (base: string) => Promise<void>,
	devices = {
		devices: { mac: { name: 'Mac <b>book</b>', color: '#7fa034' } },
		unknownDevices: 'by-id' as const
	}
) {
	const server = createHttpServer(createBigSpender({ dataDir: dir, ingestToken: TOKEN, devices }));
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	try {
		await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
	} finally {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	}
}

const ingest = (base: string, snap: unknown, token = TOKEN) =>
	fetch(`${base}/api/usage/ingest`, {
		method: 'POST',
		headers: {
			authorization: `Bearer ${token}`,
			'content-type': 'application/json',
			'content-encoding': 'gzip'
		},
		body: gzipSync(JSON.stringify(snap))
	});

test('ingest, JSON summary and HTML page over HTTP', async () => {
	await withTempDir((dir) =>
		withServer(dir, async (base) => {
			assert.equal((await ingest(base, snapshot('mac'), 'nope')).status, 401);
			const stored = await ingest(base, snapshot('mac'));
			assert.equal(stored.status, 200);
			assert.equal(((await stored.json()) as { result: string }).result, 'stored');

			const api = await fetch(`${base}/api/usage`);
			assert.equal(api.status, 200);
			assert.equal(
				api.headers.get('cache-control'),
				'public, max-age=300, stale-while-revalidate=900'
			);
			assert.match(api.headers.get('content-type') ?? '', /^application\/json/);
			const summary = (await api.json()) as {
				ranges: Record<string, { devices: { name: string }[] }>;
			};
			assert.deepEqual(Object.keys(summary.ranges), ['7d', '30d', '90d', 'all']);
			assert.equal(summary.ranges.all.devices[0].name, 'Mac <b>book</b>');

			const page = await fetch(`${base}/`);
			const html = await page.text();
			assert.match(page.headers.get('content-type') ?? '', /^text\/html/);
			assert.match(html, /prefers-color-scheme: dark/);
			assert.match(html, /background:#7fa034/);
			assert.match(html, /Mac &#60;b&#62;book&#60;\/b&#62;/);
			assert.match(html, /claude-opus-5-5/);
			assert.match(html, /<h3>All time<\/h3>/);
			assert.match(html, /<th>All time<\/th>/);
			assert.doesNotMatch(html, /<script|https?:\/\/(?!www\.w3)/);
		})
	);
});

test('an empty server renders a page and a zeroed summary', async () => {
	await withTempDir((dir) =>
		withServer(dir, async (base) => {
			assert.match(await (await fetch(`${base}/`)).text(), /No devices have reported yet/);
			const summary = (await (await fetch(`${base}/api/usage`)).json()) as {
				ranges: { '7d': { totalCost: number } };
			};
			assert.equal(summary.ranges['7d'].totalCost, 0);
		})
	);
});

test('healthz, unknown paths and wrong methods', async () => {
	await withTempDir((dir) =>
		withServer(dir, async (base) => {
			assert.equal(await (await fetch(`${base}/healthz`)).text(), 'ok\n');
			assert.equal((await fetch(`${base}/nope`)).status, 404);
			assert.equal((await fetch(`${base}/constructor`)).status, 404);
			const wrong = await fetch(`${base}/api/usage/ingest`);
			assert.equal(wrong.status, 405);
			assert.equal(wrong.headers.get('allow'), 'POST');
			assert.equal((await fetch(`${base}/api/usage`, { method: 'POST' })).status, 405);
			const head = await fetch(`${base}/api/usage`, { method: 'HEAD' });
			assert.equal(head.status, 200);
			assert.equal(await head.text(), '');
		})
	);
});

test('serve config comes from flags, then env, then defaults', async () => {
	await withTempDir(async (dir) => {
		const defaults = await loadServeConfig([], {});
		assert.deepEqual(defaults, {
			port: 8787,
			host: '0.0.0.0',
			dataDir: './data',
			ingestToken: undefined,
			devices: { devices: {}, unknownDevices: 'by-id' }
		});

		const file = join(dir, 'devices.json');
		await writeFile(
			file,
			JSON.stringify({ devices: { a: { name: 'A', color: '#fff' } }, unknownDevices: 'other' })
		);
		const env = {
			PORT: '9000',
			HOST: '127.0.0.1',
			BIG_SPENDER_DATA_DIR: '/data',
			BIG_SPENDER_INGEST_TOKEN: ' tok \n',
			BIG_SPENDER_DEVICES_FILE: file
		};
		const fromEnv = await loadServeConfig([], env);
		assert.equal(fromEnv.port, 9000);
		assert.equal(fromEnv.ingestToken, 'tok');
		assert.equal(fromEnv.devices.unknownDevices, 'other');

		const flagged = await loadServeConfig(['--port', '1234', '--host', '::1', '--data', 'x'], env);
		assert.deepEqual([flagged.port, flagged.host, flagged.dataDir], [1234, '::1', 'x']);
	});
});

test('bad serve config is rejected', async () => {
	await withTempDir(async (dir) => {
		await assert.rejects(loadServeConfig(['--port', 'abc'], {}), /invalid port/);
		await assert.rejects(loadServeConfig(['--bogus'], {}));
		const file = join(dir, 'devices.json');
		await writeFile(file, JSON.stringify({ devices: { a: { name: 'A' } } }));
		await assert.rejects(loadServeConfig(['--devices', file], {}), /invalid devices file/);
	});
});
