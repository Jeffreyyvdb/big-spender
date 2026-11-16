// End to end: start the server, push a real snapshot with the collector, read it back.
//   node scripts/e2e-serve.mjs              runs `node dist/cli.js serve` (run `npm run build` first)
//   node scripts/e2e-serve.mjs --docker big-spender:local
// The collector reads the real Claude and Codex logs read-only; its HOME, cache and config are
// throwaway, so nothing under the real ~/.cache or ~/.config is touched.
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { packageCollector, packageRoot } from './lib/parity.mjs';

const execFileAsync = promisify(execFile);
const dockerImage = process.argv[2] === '--docker' ? process.argv[3] : undefined;
const TOKEN = 'e2e-token';

const port = await new Promise((resolve) => {
	const probe = createServer().listen(0, '127.0.0.1', () => {
		const { port } = probe.address();
		probe.close(() => resolve(port));
	});
});
const base = `http://127.0.0.1:${port}`;
const scratch = await mkdtemp(join(tmpdir(), 'big-spender-e2e-'));
const dataDir = join(scratch, 'data');
await mkdir(dataDir);

let stop;
if (dockerImage) {
	const id = execFileSync(
		'docker',
		[
			'run',
			'-d',
			'--rm',
			'-p',
			`127.0.0.1:${port}:8787`,
			'-e',
			`BIG_SPENDER_INGEST_TOKEN=${TOKEN}`,
			dockerImage
		],
		{ encoding: 'utf8' }
	).trim();
	stop = () => execFileSync('docker', ['rm', '-f', id], { stdio: 'ignore' });
	console.log(`docker container ${id.slice(0, 12)} from ${dockerImage}`);
} else {
	const child = spawn(process.execPath, [join(packageRoot, 'dist', 'cli.js'), 'serve'], {
		env: {
			PATH: process.env.PATH,
			PORT: String(port),
			HOST: '127.0.0.1',
			BIG_SPENDER_DATA_DIR: dataDir,
			BIG_SPENDER_INGEST_TOKEN: TOKEN
		},
		stdio: ['ignore', 'inherit', 'inherit']
	});
	stop = () => child.kill('SIGTERM');
}

try {
	for (let i = 0; ; i++) {
		try {
			if ((await fetch(`${base}/healthz`)).ok) break;
		} catch {
			// not listening yet
		}
		assert.ok(i < 100, 'server did not become healthy');
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	console.log('ok /healthz');

	const home = join(scratch, 'home');
	await mkdir(home);
	const realHome = process.env.HOME;
	const collectorEnv = (token) => ({
		PATH: process.env.PATH,
		HOME: home,
		XDG_CACHE_HOME: join(scratch, 'cache'),
		XDG_CONFIG_HOME: join(scratch, 'config'),
		CLAUDE_CONFIG_DIR: join(realHome, '.claude'),
		CODEX_HOME: join(realHome, '.codex'),
		BIG_SPENDER_DEVICE_ID: 'desktop',
		BIG_SPENDER_INGEST_URL: `${base}/api/usage/ingest`,
		BIG_SPENDER_INGEST_TOKEN: token
	});

	await assert.rejects(
		execFileAsync(process.execPath, [packageCollector], { env: collectorEnv('wrong') }),
		(err) => /HTTP 401/.test(err.stderr)
	);
	console.log('ok a wrong token is refused with 401');

	const pushed = await execFileAsync(process.execPath, [packageCollector], {
		env: collectorEnv(TOKEN),
		maxBuffer: 64 * 1024 * 1024
	});
	const posted = /posted (\d+) rows \((\d+) bytes gzipped\): (.*)/.exec(pushed.stderr);
	assert.ok(posted, pushed.stderr);
	console.log(`ok collector pushed ${posted[1]} rows (${posted[2]} bytes gzipped): ${posted[3]}`);

	const api = await fetch(`${base}/api/usage`);
	assert.equal(api.status, 200);
	assert.equal(api.headers.get('cache-control'), 'public, max-age=300, stale-while-revalidate=900');
	const summary = await api.json();
	const r90 = summary.ranges['90d'];
	assert.ok(r90.totalCost > 0, 'no cost in the 90d range');
	assert.deepEqual(
		r90.devices.map((d) => d.name),
		['desktop']
	);
	assert.equal(r90.series.length, 90);
	console.log(
		`ok /api/usage: 90d ${r90.totalCost.toFixed(2)} USD, ${r90.sessions} sessions, ` +
			`${r90.models.length} models, devices ${r90.devices.map((d) => d.name).join(', ')}`
	);

	const page = await fetch(`${base}/`);
	const html = await page.text();
	assert.equal(page.status, 200);
	assert.match(html, /<title>big-spender<\/title>/);
	assert.match(html, /class="swatch"/);
	assert.ok(html.includes(`${r90.models[0].model}`));
	assert.doesNotMatch(html, /<script/);
	console.log(
		`ok /: ${html.length} bytes of HTML, top model ${r90.models[0].model}, no script tags`
	);

	if (!dockerImage) {
		await access(join(dataDir, 'desktop.json'));
		const stored = JSON.parse(await readFile(join(dataDir, 'desktop.json'), 'utf8'));
		assert.equal(stored.deviceId, 'desktop');
		console.log(`ok data dir holds desktop.json (${stored.hourly.length} rows)`);
	}
} finally {
	stop();
}
