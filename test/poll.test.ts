import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, seedPricing, withSandbox, type Sandbox } from './helpers.ts';

const COLLECTOR = fileURLToPath(new URL('../src/collector.mjs', import.meta.url));
const HOUR = 3_600_000;
const NEXT_HOUR = Math.floor(Date.now() / HOUR) * HOUR + HOUR;
const iso = (ms: number) => new Date(ms).toISOString();

type Seen = { path: string; headers: IncomingHttpHeaders };
type Reply = { status: number; body: unknown };
type Stub = { claude: Reply; codex: Reply };

/** Both usage endpoints on one loopback server; each test sets what they answer. */
async function withUsageApi(fn: (api: Stub, seen: Seen[], url: string) => Promise<void>) {
	const api: Stub = { claude: { status: 200, body: {} }, codex: { status: 200, body: {} } };
	const seen: Seen[] = [];
	const server = createServer((req, res) => {
		seen.push({ path: String(req.url), headers: req.headers });
		const reply = req.url?.startsWith('/claude') ? api.claude : api.codex;
		res.writeHead(reply.status, { 'content-type': 'application/json' });
		res.end(JSON.stringify(reply.body));
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	try {
		await fn(api, seen, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
	} finally {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	}
}

const CLAUDE_TOKEN = 'claude-secret-token';

async function writeClaudeLogin(box: Sandbox, oauth: Record<string, unknown> | null) {
	await mkdir(join(box.home, '.claude'), { recursive: true });
	const login = oauth === null ? {} : { claudeAiOauth: oauth };
	await writeFile(join(box.home, '.claude', '.credentials.json'), JSON.stringify(login));
}

const validClaude = (extra: Record<string, unknown> = {}) => ({
	accessToken: CLAUDE_TOKEN,
	refreshToken: 'claude-refresh-secret',
	expiresAt: Date.now() + HOUR,
	...extra
});

async function collect(box: Sandbox, url: string, extra: Record<string, string> = {}) {
	await seedPricing(join(box.env.XDG_CACHE_HOME, 'big-spender'));
	const res = await run(COLLECTOR, ['--dry-run'], {
		...box.env,
		BIG_SPENDER_DEVICE_ID: 'laptop',
		BIG_SPENDER_CLAUDE_USAGE_URL: `${url}/claude`,
		BIG_SPENDER_CODEX_USAGE_URL: `${url}/codex`,
		...extra
	});
	return { ...res, snap: res.code === 0 ? JSON.parse(res.stdout) : null };
}

type Win = {
	provider: string;
	window: string;
	resetsAt: string;
	peakPercent: number;
	hitAt?: string;
};
const windows = (snap: { limits?: Win[] }, provider: string) =>
	(snap.limits ?? [])
		.filter((w) => w.provider === provider)
		.map((w) => [w.window, w.resetsAt, w.peakPercent, w.hitAt !== undefined])
		.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
const warnings = (stderr: string) => stderr.match(/usage not polled/g)?.length ?? 0;

const claudeBody = () => ({
	five_hour: { utilization: 37.4, resets_at: iso(NEXT_HOUR + 2 * HOUR + 200) },
	seven_day: { utilization: 12, resets_at: iso(NEXT_HOUR + 48 * HOUR) },
	seven_day_opus: { utilization: null, resets_at: null },
	seven_day_sonnet: { utilization: 100, resets_at: iso(NEXT_HOUR + 48 * HOUR) },
	seven_day_oauth_apps: null,
	cinder_cove: { utilization: 5, resets_at: iso(NEXT_HOUR + 48 * HOUR) },
	extra_usage: { is_enabled: true, utilization: 50 },
	limits: [
		{
			kind: 'weekly_scoped',
			percent: 4,
			resets_at: iso(NEXT_HOUR + 48 * HOUR),
			scope: { model: { display_name: 'Fable' } }
		},
		{
			kind: 'weekly_scoped',
			percent: 9,
			resets_at: iso(NEXT_HOUR + 48 * HOUR),
			scope: { model: { display_name: 'Fable 5.1' } }
		},
		{ kind: 'session', percent: 50, resets_at: iso(NEXT_HOUR), scope: {} }
	]
});

test('Claude windows are polled, including model weeklies, and a hit is recorded only at 100%', async () => {
	await withSandbox(async (box) => {
		await writeClaudeLogin(box, validClaude());
		await withUsageApi(async (api, seen, url) => {
			api.claude.body = claudeBody();
			const res = await collect(box, url);
			assert.equal(res.code, 0, res.stderr);
			assert.deepEqual(windows(res.snap, 'claude'), [
				['five_hour', iso(NEXT_HOUR + 2 * HOUR), 37.4, false],
				['seven_day', iso(NEXT_HOUR + 48 * HOUR), 12, false],
				['seven_day_fable', iso(NEXT_HOUR + 48 * HOUR), 4, false],
				['seven_day_fable_5_1', iso(NEXT_HOUR + 48 * HOUR), 9, false],
				['seven_day_sonnet', iso(NEXT_HOUR + 48 * HOUR), 100, true]
			]);
			assert.match(res.stderr, /polled claude usage: .*five_hour 37%.*seven_day_fable 4%/);

			assert.equal(seen.length, 1, res.stderr);
			assert.equal(seen[0].path, '/claude');
			assert.equal(seen[0].headers.authorization, `Bearer ${CLAUDE_TOKEN}`);
			assert.equal(seen[0].headers['anthropic-beta'], 'oauth-2025-04-20');
			assert.equal(seen[0].headers['user-agent'], 'big-spender');
			const sentElsewhere = Object.entries(seen[0].headers).filter(
				([name, value]) => name !== 'authorization' && String(value).includes(CLAUDE_TOKEN)
			);
			assert.deepEqual(sentElsewhere, []);
		});
	});
});

test('a polled token never reaches output or the state file', async () => {
	await withSandbox(async (box) => {
		await writeClaudeLogin(box, validClaude());
		await withUsageApi(async (api, _seen, url) => {
			api.claude.body = claudeBody();
			const res = await collect(box, url);
			const state = await readFile(
				join(box.env.XDG_CACHE_HOME, 'big-spender', 'state.json'),
				'utf8'
			);
			for (const secret of [CLAUDE_TOKEN, 'claude-refresh-secret']) {
				assert.ok(!res.stdout.includes(secret) && !res.stderr.includes(secret));
				assert.ok(!state.includes(secret));
			}
		});
	});
});

test('an expired Claude token sends no request and warns once, and the snapshot still comes out', async () => {
	await withSandbox(async (box) => {
		await writeClaudeLogin(box, validClaude({ expiresAt: Date.now() - 1000 }));
		await withUsageApi(async (_api, seen, url) => {
			const res = await collect(box, url);
			assert.equal(res.code, 0, res.stderr);
			assert.deepEqual(seen, []);
			assert.equal(warnings(res.stderr), 1);
			assert.match(res.stderr, /claude usage not polled: the login token expired/);
			assert.equal(res.snap.deviceId, 'laptop');
		});
	});
});

test('a login file without a Claude subscription token is skipped with one warning', async () => {
	await withSandbox(async (box) => {
		await writeClaudeLogin(box, null);
		await withUsageApi(async (_api, seen, url) => {
			const res = await collect(box, url);
			assert.equal(res.code, 0, res.stderr);
			assert.deepEqual(seen, []);
			assert.equal(warnings(res.stderr), 1);
		});
	});
});

test('without login files nothing is requested and nothing is said', async () => {
	await withSandbox(async (box) => {
		await withUsageApi(async (_api, seen, url) => {
			const res = await collect(box, url);
			assert.equal(res.code, 0, res.stderr);
			assert.deepEqual(seen, []);
			assert.doesNotMatch(res.stderr, /polled/);
			assert.equal('limits' in res.snap, false);
		});
	});
});

for (const status of [500, 401]) {
	test(`a ${status} from the usage endpoint warns, exits 0 and keeps the snapshot`, async () => {
		await withSandbox(async (box) => {
			await writeClaudeLogin(box, validClaude());
			await withUsageApi(async (api, seen, url) => {
				api.claude = { status, body: { error: `body-with-${CLAUDE_TOKEN}` } };
				const res = await collect(box, url);
				assert.equal(res.code, 0, res.stderr);
				assert.equal(seen.length, 1, res.stderr);
				assert.equal(warnings(res.stderr), 1);
				assert.match(res.stderr, new RegExp(`claude usage not polled: HTTP ${status}`));
				if (status === 401) assert.match(res.stderr, /run the agent once to refresh/);
				assert.ok(!res.stderr.includes(CLAUDE_TOKEN));
				assert.equal(res.snap.deviceId, 'laptop');
			});
		});
	});
}

test('a body that is not a JSON object warns once', async () => {
	await withSandbox(async (box) => {
		await writeClaudeLogin(box, validClaude());
		await withUsageApi(async (api, seen, url) => {
			api.claude.body = [1, 2];
			const res = await collect(box, url);
			assert.equal(seen.length, 1);
			assert.equal(res.code, 0, res.stderr);
			assert.equal(warnings(res.stderr), 1);
		});
	});
});

test('BIG_SPENDER_POLL_LIMITS=off sends no request', async () => {
	for (const off of ['off', 'OFF', '0', 'false', 'no']) {
		await withSandbox(async (box) => {
			await writeClaudeLogin(box, validClaude());
			await withUsageApi(async (api, seen, url) => {
				api.claude.body = claudeBody();
				const res = await collect(box, url, { BIG_SPENDER_POLL_LIMITS: off });
				assert.equal(res.code, 0, res.stderr);
				assert.deepEqual(seen, [], off);
				assert.equal('limits' in res.snap, false);
			});
		});
	}
});

test('a reset time that jitters across a minute boundary stays one window with the higher peak', async () => {
	await withSandbox(async (box) => {
		await writeClaudeLogin(box, validClaude());
		await withUsageApi(async (api, _seen, url) => {
			const resetsAt = NEXT_HOUR + 3 * HOUR;
			api.claude.body = { five_hour: { utilization: 20, resets_at: iso(resetsAt - 300) } };
			await collect(box, url);
			api.claude.body = { five_hour: { utilization: 30, resets_at: iso(resetsAt + 200) } };
			const res = await collect(box, url);
			assert.deepEqual(windows(res.snap, 'claude'), [['five_hour', iso(resetsAt), 30, false]]);
		});
	});
});

test('a failed poll after a good one still sends the earlier peak', async () => {
	await withSandbox(async (box) => {
		await writeClaudeLogin(box, validClaude());
		await withUsageApi(async (api, _seen, url) => {
			api.claude.body = claudeBody();
			await collect(box, url);
			api.claude = { status: 500, body: {} };
			const res = await collect(box, url);
			assert.equal(windows(res.snap, 'claude').length, 5);
			assert.equal(warnings(res.stderr), 1);
		});
	});
});
