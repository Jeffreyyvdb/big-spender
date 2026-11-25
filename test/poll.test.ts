import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { run, seedPricing, withSandbox, type Sandbox } from './helpers.ts';

const COLLECTOR = fileURLToPath(new URL('../src/collector.mjs', import.meta.url));
const HOUR = 3_600_000;
const NEXT_HOUR = Math.floor(Date.now() / HOUR) * HOUR + HOUR;
const iso = (ms: number) => new Date(ms).toISOString();

type Seen = { path: string; headers: IncomingHttpHeaders };
type Reply = { status: number; body: unknown };
type Stub = { claude: Reply; codex: Reply; agDaily: Reply; agProd: Reply };

/** Both usage endpoints on one loopback server; each test sets what they answer. */
async function withUsageApi(fn: (api: Stub, seen: Seen[], url: string) => Promise<void>) {
	const ok = () => ({ status: 200, body: {} });
	const api: Stub = { claude: ok(), codex: ok(), agDaily: ok(), agProd: ok() };
	const seen: Seen[] = [];
	const server = createServer((req, res) => {
		seen.push({ path: String(req.url), headers: req.headers });
		const route = /^\/(claude|codex|agDaily|agProd)/.exec(String(req.url))?.[1] as keyof Stub;
		const reply = api[route] ?? api.codex;
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

const INGEST_TOKEN = 'ingest-token-for-tests';

async function collect(box: Sandbox, url: string, extra: Record<string, string> = {}) {
	await seedPricing(join(box.env.XDG_CACHE_HOME, 'big-spender'));
	const res = await run(COLLECTOR, ['--dry-run'], {
		...box.env,
		BIG_SPENDER_DEVICE_ID: 'laptop',
		BIG_SPENDER_INGEST_TOKEN: INGEST_TOKEN,
		BIG_SPENDER_CLAUDE_USAGE_URL: `${url}/claude`,
		BIG_SPENDER_CODEX_USAGE_URL: `${url}/codex`,
		BIG_SPENDER_ANTIGRAVITY_DAILY_URL: `${url}/agDaily`,
		BIG_SPENDER_ANTIGRAVITY_USAGE_URL: `${url}/agProd`,
		...extra
	});
	return { ...res, snap: res.code === 0 ? JSON.parse(res.stdout) : null };
}

type Win = {
	provider: string;
	account?: string;
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

const jwt = (payload: unknown) =>
	['e30', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'sig'].join('.');
const CODEX_ACCOUNT = 'acct-123';

async function writeCodexLogin(
	box: Sandbox,
	token: string,
	accountId: string | null = CODEX_ACCOUNT
) {
	await mkdir(join(box.home, '.codex'), { recursive: true });
	await writeFile(
		join(box.home, '.codex', 'auth.json'),
		JSON.stringify({
			OPENAI_API_KEY: null,
			tokens: {
				id_token: 'id-secret',
				access_token: token,
				refresh_token: 'codex-refresh-secret',
				account_id: accountId
			}
		})
	);
}

const liveCodexToken = () => jwt({ exp: Math.floor(Date.now() / 1000) + 3600 });

const codexBody = () => ({
	plan_type: 'pro',
	rate_limit: {
		allowed: true,
		limit_reached: false,
		primary_window: {
			used_percent: 42,
			limit_window_seconds: 18000,
			reset_after_seconds: 0,
			reset_at: (NEXT_HOUR + 2 * HOUR) / 1000
		},
		secondary_window: {
			used_percent: 100,
			limit_window_seconds: 604800,
			reset_after_seconds: 0,
			reset_at: (NEXT_HOUR + 48 * HOUR) / 1000
		}
	},
	additional_rate_limits: [
		{
			limit_name: 'codex_other',
			metered_feature: 'codex_other',
			rate_limit: {
				primary_window: {
					used_percent: 70,
					limit_window_seconds: 18000,
					reset_after_seconds: 0,
					reset_at: (NEXT_HOUR + 2 * HOUR) / 1000
				},
				secondary_window: null
			}
		}
	]
});

test('Codex windows are polled with the account header, additional limits get their own window', async () => {
	await withSandbox(async (box) => {
		const token = liveCodexToken();
		await writeCodexLogin(box, token);
		await withUsageApi(async (api, seen, url) => {
			api.codex.body = codexBody();
			const res = await collect(box, url);
			assert.equal(res.code, 0, res.stderr);
			assert.deepEqual(windows(res.snap, 'codex'), [
				['five_hour', iso(NEXT_HOUR + 2 * HOUR), 42, false],
				['five_hour_codex_other', iso(NEXT_HOUR + 2 * HOUR), 70, false],
				['seven_day', iso(NEXT_HOUR + 48 * HOUR), 100, true]
			]);
			assert.match(res.stderr, /polled codex usage: five_hour 42%/);
			assert.equal(seen.length, 1);
			assert.equal(seen[0].path, '/codex');
			assert.equal(seen[0].headers.authorization, `Bearer ${token}`);
			assert.equal(seen[0].headers['chatgpt-account-id'], CODEX_ACCOUNT);
			assert.equal(seen[0].headers['user-agent'], 'big-spender');

			const state = await readFile(
				join(box.env.XDG_CACHE_HOME, 'big-spender', 'state.json'),
				'utf8'
			);
			for (const secret of [token, 'id-secret', 'codex-refresh-secret']) {
				assert.ok(
					!res.stdout.includes(secret) && !res.stderr.includes(secret) && !state.includes(secret)
				);
			}
		});
	});
});

test('a window without a reset time is dated from now plus its seconds left', async () => {
	await withSandbox(async (box) => {
		await writeCodexLogin(box, liveCodexToken());
		await withUsageApi(async (api, _seen, url) => {
			api.codex.body = {
				rate_limit: {
					primary_window: {
						used_percent: 10,
						limit_window_seconds: 900,
						reset_after_seconds: 7200,
						reset_at: 0
					}
				}
			};
			const before = Date.now();
			const res = await collect(box, url);
			const [[window, resetsAt, percent]] = windows(res.snap, 'codex');
			assert.deepEqual([window, percent], ['15m', 10]);
			const delta = Date.parse(String(resetsAt)) - before - 7200_000;
			assert.ok(delta > -60_000 && delta < 60_000, String(delta));
		});
	});
});

test('an expired Codex token sends no request and warns once', async () => {
	await withSandbox(async (box) => {
		await writeCodexLogin(box, jwt({ exp: Math.floor(Date.now() / 1000) - 10 }));
		await withUsageApi(async (_api, seen, url) => {
			const res = await collect(box, url);
			assert.equal(res.code, 0, res.stderr);
			assert.deepEqual(seen, []);
			assert.equal(warnings(res.stderr), 1);
			assert.match(res.stderr, /codex usage not polled: the login token expired/);
			assert.equal(res.snap.deviceId, 'laptop');
		});
	});
});

test('a token that is not a JWT is still sent, and a missing account id is skipped', async () => {
	await withSandbox(async (box) => {
		await writeCodexLogin(box, 'opaque-token');
		await withUsageApi(async (api, seen, url) => {
			api.codex.body = codexBody();
			const res = await collect(box, url);
			assert.equal(seen.length, 1);
			assert.equal(seen[0].headers.authorization, 'Bearer opaque-token');
			assert.equal(windows(res.snap, 'codex').length, 3);
		});
	});
	await withSandbox(async (box) => {
		await writeCodexLogin(box, liveCodexToken(), null);
		await withUsageApi(async (_api, seen, url) => {
			const res = await collect(box, url);
			assert.deepEqual(seen, []);
			assert.equal(warnings(res.stderr), 1);
		});
	});
});

test('one provider failing leaves the other polled', async () => {
	await withSandbox(async (box) => {
		await writeClaudeLogin(box, validClaude());
		await writeCodexLogin(box, liveCodexToken());
		await withUsageApi(async (api, seen, url) => {
			api.claude = { status: 500, body: {} };
			api.codex.body = codexBody();
			const res = await collect(box, url);
			assert.equal(res.code, 0, res.stderr);
			assert.equal(seen.length, 2);
			assert.equal(warnings(res.stderr), 1);
			assert.equal(windows(res.snap, 'codex').length, 3);
			assert.equal(windows(res.snap, 'claude').length, 0);
		});
	});
});

test('a Codex 401 warns without the token and exits 0', async () => {
	await withSandbox(async (box) => {
		const token = liveCodexToken();
		await writeCodexLogin(box, token);
		await withUsageApi(async (api, _seen, url) => {
			api.codex = { status: 401, body: { echo: token } };
			const res = await collect(box, url);
			assert.equal(res.code, 0, res.stderr);
			assert.match(res.stderr, /codex usage not polled: HTTP 401/);
			assert.ok(!res.stderr.includes(token));
		});
	});
});

const refusedClaudeWeekly = (ms: number, resetsAt: number) =>
	JSON.stringify({
		type: 'assistant',
		timestamp: iso(ms),
		isApiErrorMessage: true,
		error: 'rate_limit',
		apiErrorStatus: 429,
		message: { model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 } },
		quotaLimits: {
			status: 'rejected',
			resetsAt: resetsAt / 1000,
			rateLimitType: 'seven_day_overage_included'
		}
	});

async function writeClaudeLog(box: Sandbox, lines: string[]) {
	await mkdir(join(box.home, '.claude', 'projects', 'p'), { recursive: true });
	await writeFile(join(box.home, '.claude', 'projects', 'p', 's1.jsonl'), lines.join('\n') + '\n');
}

const weeklyResetsAt = NEXT_HOUR + 48 * HOUR;
const fableWeekly = (percent = 4) => ({
	kind: 'weekly_scoped',
	percent,
	resets_at: iso(weeklyResetsAt),
	scope: { model: { display_name: 'Fable' } }
});

test('a refusal logged as seven_day_overage_included joins the polled Fable weekly in one run', async () => {
	await withSandbox(async (box) => {
		await writeClaudeLogin(box, validClaude());
		const hitMs = NEXT_HOUR - 3 * HOUR;
		await writeClaudeLog(box, [refusedClaudeWeekly(hitMs, weeklyResetsAt)]);
		await withUsageApi(async (api, _seen, url) => {
			api.claude.body = { limits: [fableWeekly(100)] };
			const res = await collect(box, url);
			assert.equal(res.code, 0, res.stderr);
			assert.deepEqual(
				res.snap.limits.map((w: Win) => [w.window, w.resetsAt, w.peakPercent, w.hitAt]),
				[['seven_day_fable', iso(weeklyResetsAt), 100, iso(hitMs)]]
			);
		});
	});
});

test('a Fable refusal is named seven_day_fable with polling off', async () => {
	await withSandbox(async (box) => {
		await writeClaudeLogin(box, validClaude());
		const hitMs = NEXT_HOUR - HOUR;
		await writeClaudeLog(box, [refusedClaudeWeekly(hitMs, weeklyResetsAt)]);
		await withUsageApi(async (api, seen, url) => {
			api.claude.body = { limits: [fableWeekly()] };
			const res = await collect(box, url, { BIG_SPENDER_POLL_LIMITS: 'off' });
			assert.deepEqual(seen, []);
			assert.deepEqual(
				res.snap.limits.map((w: Win) => [w.window, w.hitAt]),
				[['seven_day_fable', iso(hitMs)]]
			);
		});
	});
});

test('other model weeklies in the poll do not move a Fable refusal', async () => {
	await withSandbox(async (box) => {
		await writeClaudeLogin(box, validClaude());
		const hitMs = NEXT_HOUR - HOUR;
		await writeClaudeLog(box, [refusedClaudeWeekly(hitMs, weeklyResetsAt)]);
		await withUsageApi(async (api, _seen, url) => {
			api.claude.body = {
				limits: [fableWeekly(), { ...fableWeekly(), scope: { model: { display_name: 'Other' } } }]
			};
			const res = await collect(box, url);
			assert.deepEqual(res.snap.limits.map((w: Win) => [w.window, w.peakPercent, w.hitAt]).sort(), [
				['seven_day_fable', 100, iso(hitMs)],
				['seven_day_other', 4, undefined]
			]);
		});
	});
});

const SHARING_LIMIT =
	'stream disconnected before completion: The ChatGPT user has reached their Subscription Sharing usage limit. Ask the user to try again after their usage limit resets or use an API key instead.';

const codexEvent = (ms: number, payload: Record<string, unknown>) =>
	JSON.stringify({ timestamp: iso(ms), type: 'event_msg', payload });
const sharingRefusal = (ms: number) =>
	codexEvent(ms, {
		type: 'task_complete',
		error: { message: SHARING_LIMIT, codex_error_info: 'other' }
	});
const usageLimitError = (ms: number) =>
	codexEvent(ms, {
		type: 'error',
		message: 'You’ve hit your usage limit.',
		codex_error_info: 'usage_limit_exceeded'
	});

async function writeCodexLog(box: Sandbox, lines: string[]) {
	const dir = join(box.home, '.codex', 'sessions', '2026', '11');
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, 'rollout-a.jsonl'), lines.join('\n') + '\n');
}

const codexFiveHour = (usedPercent: number, resetsAt: number) => ({
	rate_limit: {
		primary_window: {
			used_percent: usedPercent,
			limit_window_seconds: 18000,
			reset_after_seconds: 0,
			reset_at: resetsAt / 1000
		}
	}
});

const fiveHourResetsAt = NEXT_HOUR + 2 * HOUR;

for (const [name, refusal] of [
	['a subscription sharing refusal', sharingRefusal],
	['a usage_limit_exceeded error event', usageLimitError]
] as const) {
	test(`${name} starts the lockout at the refusal, not at the poll`, async () => {
		await withSandbox(async (box) => {
			await writeCodexLogin(box, liveCodexToken());
			const refusedAt = fiveHourResetsAt - 4 * HOUR;
			await writeCodexLog(box, [refusal(refusedAt), refusal(refusedAt + 60_000)]);
			await withUsageApi(async (api, _seen, url) => {
				api.codex.body = codexFiveHour(100, fiveHourResetsAt);
				const res = await collect(box, url);
				assert.equal(res.code, 0, res.stderr);
				assert.deepEqual(
					res.snap.limits.map((w: Win) => [w.window, w.peakPercent, w.hitAt]),
					[['five_hour', 100, iso(refusedAt)]]
				);
			});
		});
	});
}

test('a Codex refusal outside the full window leaves the hit at the poll time', async () => {
	await withSandbox(async (box) => {
		await writeCodexLogin(box, liveCodexToken());
		await writeCodexLog(box, [
			sharingRefusal(fiveHourResetsAt - 6 * HOUR),
			sharingRefusal(fiveHourResetsAt + HOUR)
		]);
		await withUsageApi(async (api, _seen, url) => {
			api.codex.body = codexFiveHour(100, fiveHourResetsAt);
			const before = Date.now();
			const res = await collect(box, url);
			const [[, , , hitAt]] = res.snap.limits.map((w: Win) => [
				w.window,
				w.resetsAt,
				w.peakPercent,
				w.hitAt
			]);
			assert.ok(Date.parse(hitAt) >= before - 1000, hitAt);
		});
	});
});

test('a Codex refusal adds no hit to a window never seen full', async () => {
	await withSandbox(async (box) => {
		await writeCodexLogin(box, liveCodexToken());
		await writeCodexLog(box, [sharingRefusal(fiveHourResetsAt - 4 * HOUR)]);
		await withUsageApi(async (api, _seen, url) => {
			api.codex.body = codexFiveHour(60, fiveHourResetsAt);
			const res = await collect(box, url);
			assert.deepEqual(
				res.snap.limits.map((w: Win) => [w.window, w.peakPercent, w.hitAt]),
				[['five_hour', 60, undefined]]
			);
		});
	});
});

test('a Codex refusal with no window on record changes nothing', async () => {
	await withSandbox(async (box) => {
		await writeCodexLogin(box, liveCodexToken());
		await writeCodexLog(box, [sharingRefusal(fiveHourResetsAt - 4 * HOUR)]);
		await withUsageApi(async (_api, _seen, url) => {
			const res = await collect(box, url);
			assert.equal(res.code, 0, res.stderr);
			assert.equal('limits' in res.snap, false);
		});
	});
});

test('state from before Codex refusals were read is rescanned once to attribute them', async () => {
	await withSandbox(async (box) => {
		await writeCodexLogin(box, liveCodexToken());
		const refusedAt = fiveHourResetsAt - 4 * HOUR;
		await writeCodexLog(box, [sharingRefusal(refusedAt)]);
		await withUsageApi(async (api, _seen, url) => {
			api.codex.body = codexFiveHour(100, fiveHourResetsAt);
			await collect(box, url);
			const statePath = join(box.env.XDG_CACHE_HOME, 'big-spender', 'state.json');
			const state = JSON.parse(await readFile(statePath, 'utf8'));
			for (const l of Object.values<{ hitAt?: string }>(state.limits)) l.hitAt = iso(Date.now());
			state.fixes = state.fixes.filter((f: string) => f !== 'codex-refusals');
			await writeFile(statePath, JSON.stringify(state));

			const res = await collect(box, url, { BIG_SPENDER_POLL_LIMITS: 'off' });
			assert.deepEqual(
				res.snap.limits.map((w: Win) => w.hitAt),
				[iso(refusedAt)]
			);
			assert.ok(JSON.parse(await readFile(statePath, 'utf8')).fixes.includes('codex-refusals'));
		});
	});
});

const REFUSED_AT = NEXT_HOUR - 3 * HOUR;
const OLD_FIVE_HOUR = NEXT_HOUR - 2 * HOUR;
const WEEKLY = NEXT_HOUR + 48 * HOUR;

const codexTokenCount = (ms: number, window_minutes: number, used: number, resetsAt: number) =>
	codexEvent(ms, {
		type: 'token_count',
		rate_limits: {
			primary: { used_percent: used, window_minutes, resets_at: resetsAt / 1000 },
			secondary: null
		}
	});

const polledWindow = (usedPercent: number, windowSeconds: number, resetsAt: number) => ({
	used_percent: usedPercent,
	limit_window_seconds: windowSeconds,
	reset_after_seconds: 0,
	reset_at: resetsAt / 1000
});

// The log saw the old five_hour at 32%, then Codex refused; the poll came after the lockout ended.
const missedLockoutLog = () => [
	codexTokenCount(REFUSED_AT - HOUR, 300, 32, OLD_FIVE_HOUR),
	sharingRefusal(REFUSED_AT)
];
const missedLockoutLogWithWeekly = () => [
	codexTokenCount(REFUSED_AT - HOUR, 300, 32, OLD_FIVE_HOUR),
	codexTokenCount(REFUSED_AT - HOUR, 10080, 50, WEEKLY),
	sharingRefusal(REFUSED_AT)
];
const missedLockoutBody = (extra: Record<string, unknown> = {}) => ({
	rate_limit: {
		primary_window: polledWindow(5, 18000, NEXT_HOUR + 3 * HOUR),
		secondary_window: polledWindow(90, 604800, WEEKLY)
	},
	...extra
});
const hitsOf = (snap: { limits: Win[] }) =>
	snap.limits.map((w) => [w.window, w.resetsAt, w.peakPercent, w.hitAt]);

test('a refusal is blamed on the one open window the poll did not read', async () => {
	await withSandbox(async (box) => {
		await writeCodexLogin(box, liveCodexToken());
		await writeCodexLog(box, missedLockoutLog());
		await withUsageApi(async (api, _seen, url) => {
			api.codex.body = missedLockoutBody();
			const res = await collect(box, url);
			assert.equal(res.code, 0, res.stderr);
			assert.deepEqual(hitsOf(res.snap).sort(), [
				['five_hour', iso(OLD_FIVE_HOUR), 100, iso(REFUSED_AT)],
				['five_hour', iso(NEXT_HOUR + 3 * HOUR), 5, undefined],
				['seven_day', iso(WEEKLY), 90, undefined]
			]);
		});
	});
});

test('with polling off the weekly is not ruled out, so the refusal is not attributed', async () => {
	await withSandbox(async (box) => {
		await writeCodexLogin(box, liveCodexToken());
		await writeCodexLog(box, missedLockoutLogWithWeekly());
		await withUsageApi(async (api, _seen, url) => {
			api.codex.body = missedLockoutBody();
			const res = await collect(box, url, { BIG_SPENDER_POLL_LIMITS: 'off' });
			assert.ok(res.snap.limits.every((w: Win) => w.hitAt === undefined));
		});
	});
});

test('a failed Codex poll leaves the refusal unattributed', async () => {
	await withSandbox(async (box) => {
		await writeCodexLogin(box, liveCodexToken());
		await writeCodexLog(box, missedLockoutLogWithWeekly());
		await withUsageApi(async (api, _seen, url) => {
			api.codex = { status: 500, body: {} };
			const res = await collect(box, url);
			assert.equal(res.code, 0, res.stderr);
			assert.ok(res.snap.limits.every((w: Win) => w.hitAt === undefined));
		});
	});
});

test('a refusal with two open windows the poll did not read is not attributed', async () => {
	await withSandbox(async (box) => {
		await writeCodexLogin(box, liveCodexToken());
		await writeCodexLog(box, [
			codexTokenCount(REFUSED_AT - HOUR, 300, 32, OLD_FIVE_HOUR),
			codexTokenCount(REFUSED_AT - HOUR, 301, 10, OLD_FIVE_HOUR),
			sharingRefusal(REFUSED_AT)
		]);
		await withUsageApi(async (api, _seen, url) => {
			api.codex.body = missedLockoutBody();
			const res = await collect(box, url);
			assert.ok(res.snap.limits.every((w: Win) => w.hitAt === undefined));
		});
	});
});

// The poll reads the weekly too, so elimination runs; only readings below 95% rule a window out.
for (const [fiveHour, weekly, blamed] of [
	[40, 23, undefined],
	[94, 23, undefined],
	[95, 23, 'five_hour'],
	[98, 96, undefined]
] as const) {
	test(`a poll that reads the open five_hour at ${fiveHour}% and the weekly at ${weekly}% blames ${blamed ?? 'neither'}`, async () => {
		await withSandbox(async (box) => {
			await writeCodexLogin(box, liveCodexToken());
			await writeCodexLog(box, missedLockoutLog());
			await withUsageApi(async (api, _seen, url) => {
				api.codex.body = {
					rate_limit: {
						primary_window: polledWindow(fiveHour, 18000, OLD_FIVE_HOUR),
						secondary_window: polledWindow(weekly, 604800, WEEKLY)
					}
				};
				const res = await collect(box, url);
				assert.equal(res.code, 0, res.stderr);
				assert.deepEqual(hitsOf(res.snap).sort(), [
					blamed
						? ['five_hour', iso(OLD_FIVE_HOUR), 100, iso(REFUSED_AT)]
						: ['five_hour', iso(OLD_FIVE_HOUR), fiveHour, undefined],
					['seven_day', iso(WEEKLY), weekly, undefined]
				]);
			});
		});
	});
}

// Seen on 2026-11-25: Codex refused at 13:38 UTC, then the poll read the five_hour at 98% and
// the weekly at 23%. Codex refuses before used_percent reaches 100.
test('a refusal is blamed on the open window the poll reads at 98%', async () => {
	await withSandbox(async (box) => {
		await writeCodexLogin(box, liveCodexToken());
		const refusedAt = fiveHourResetsAt - 4 * HOUR;
		await writeCodexLog(box, [sharingRefusal(refusedAt)]);
		await withUsageApi(async (api, _seen, url) => {
			api.codex.body = {
				rate_limit: {
					primary_window: polledWindow(98, 18000, fiveHourResetsAt),
					secondary_window: polledWindow(23, 604800, WEEKLY)
				}
			};
			const res = await collect(box, url);
			assert.equal(res.code, 0, res.stderr);
			assert.deepEqual(hitsOf(res.snap).sort(), [
				['five_hour', iso(fiveHourResetsAt), 100, iso(refusedAt)],
				['seven_day', iso(WEEKLY), 23, undefined]
			]);
		});
	});
});

test('with polling off a lone open window is not blamed', async () => {
	await withSandbox(async (box) => {
		await writeCodexLogin(box, liveCodexToken());
		await writeCodexLog(box, missedLockoutLog());
		await withUsageApi(async (api, _seen, url) => {
			api.codex.body = missedLockoutBody();
			const res = await collect(box, url, { BIG_SPENDER_POLL_LIMITS: 'off' });
			assert.deepEqual(hitsOf(res.snap), [['five_hour', iso(OLD_FIVE_HOUR), 32, undefined]]);
		});
	});
});

test('a polled limit with no window on file at the refusal leaves it unattributed', async () => {
	await withSandbox(async (box) => {
		await writeCodexLogin(box, liveCodexToken());
		await writeCodexLog(box, missedLockoutLog());
		await withUsageApi(async (api, _seen, url) => {
			api.codex.body = missedLockoutBody({
				additional_rate_limits: [
					{
						limit_name: 'other',
						metered_feature: 'other',
						rate_limit: { primary_window: polledWindow(5, 18000, NEXT_HOUR + 3 * HOUR) }
					}
				]
			});
			const res = await collect(box, url);
			assert.equal(res.code, 0, res.stderr);
			assert.ok(res.snap.limits.some((w: Win) => w.window === 'five_hour_other'));
			assert.ok(res.snap.limits.every((w: Win) => w.hitAt === undefined));
		});
	});
});

test('a push sends at most the 5000 newest limit records the server accepts', async () => {
	await withSandbox(async (box) => {
		const MINUTE = 60_000;
		const first = NEXT_HOUR - 5001 * MINUTE;
		const limits: Record<string, Win> = {};
		for (let i = 0; i < 5001; i++) {
			const resetsAt = first + i * MINUTE;
			limits[`codex|five_hour|${resetsAt}`] = {
				provider: 'codex',
				window: 'five_hour',
				resetsAt: iso(resetsAt),
				peakPercent: 10
			};
		}
		const dir = join(box.env.XDG_CACHE_HOME, 'big-spender');
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, 'state.json'),
			JSON.stringify({
				version: 1,
				files: {},
				seen: {},
				buckets: {},
				limits,
				fixes: ['claude-final-output', 'usage-limits', 'codex-refusals']
			})
		);
		await withUsageApi(async (_api, _seen, url) => {
			const res = await collect(box, url, { BIG_SPENDER_POLL_LIMITS: 'off' });
			assert.equal(res.code, 0, res.stderr);
			assert.equal(res.snap.limits.length, 5000);
			assert.equal(res.snap.limits[0].resetsAt, iso(first + MINUTE));
		});
	});
});

test('a refusal logged before the full reading of its window still starts the lockout', async () => {
	await withSandbox(async (box) => {
		await writeCodexLog(box, [
			sharingRefusal(REFUSED_AT),
			codexTokenCount(REFUSED_AT + HOUR / 3, 300, 100, OLD_FIVE_HOUR)
		]);
		await withUsageApi(async (_api, _seen, url) => {
			const res = await collect(box, url, { BIG_SPENDER_POLL_LIMITS: 'off' });
			assert.deepEqual(hitsOf(res.snap), [['five_hour', iso(OLD_FIVE_HOUR), 100, iso(REFUSED_AT)]]);
		});
	});
});

test('a weekly the poll reports as null is not ruled out', async () => {
	await withSandbox(async (box) => {
		await writeCodexLogin(box, liveCodexToken());
		await writeCodexLog(box, missedLockoutLog());
		await withUsageApi(async (api, _seen, url) => {
			api.codex.body = {
				rate_limit: {
					primary_window: polledWindow(5, 18000, NEXT_HOUR + 3 * HOUR),
					secondary_window: null
				}
			};
			const res = await collect(box, url);
			assert.equal(res.code, 0, res.stderr);
			assert.ok(res.snap.limits.every((w: Win) => w.hitAt === undefined));
		});
	});
});

// Accounts: each login is polled once per account, wherever it is kept.

async function writeClaudeAccount(dir: string, file: string, accountUuid: string) {
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, file),
		JSON.stringify({ oauthAccount: { accountUuid, organizationUuid: 'org-1', emailAddress: 'x' } })
	);
}

async function writeT3Settings(box: Sandbox, instances: Record<string, unknown>) {
	await mkdir(join(box.home, '.t3', 'userdata'), { recursive: true });
	await writeFile(
		join(box.home, '.t3', 'userdata', 'settings.json'),
		JSON.stringify({ providerInstances: instances })
	);
}

async function writeClaudeHome(dir: string, token: string, expiresAt = Date.now() + HOUR) {
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, '.credentials.json'),
		JSON.stringify({ claudeAiOauth: validClaude({ accessToken: token, expiresAt }) })
	);
}

const accountsOf = (snap: { limits?: Win[] }, provider: string) =>
	new Set((snap.limits ?? []).filter((w) => w.provider === provider).map((w) => w.account));

test('a T3 Code Claude home signed in to another account is polled too, and its windows stay apart', async () => {
	await withSandbox(async (box) => {
		await writeClaudeHome(join(box.home, '.claude'), 'token-a');
		await writeClaudeAccount(box.home, '.claude.json', 'account-a');
		const work = join(box.home, 'claude-work');
		await writeClaudeHome(work, 'token-b');
		await writeClaudeAccount(work, '.claude.json', 'account-b');
		await writeT3Settings(box, {
			claudeWork: { driver: 'claudeAgent', config: { homePath: '~/claude-work' } }
		});
		await withUsageApi(async (api, seen, url) => {
			api.claude.body = { five_hour: { utilization: 40, resets_at: iso(NEXT_HOUR) } };
			const res = await collect(box, url);
			assert.equal(res.code, 0, res.stderr);
			assert.deepEqual(seen.map((s) => s.headers.authorization).sort(), [
				'Bearer token-a',
				'Bearer token-b'
			]);
			const fiveHours = res.snap.limits.filter((w: Win) => w.window === 'five_hour');
			assert.equal(fiveHours.length, 2);
			assert.equal(accountsOf(res.snap, 'claude').size, 2);
			for (const w of fiveHours) assert.match(w.account, /^[A-Za-z0-9_-]{16}$/);
			assert.ok(!JSON.stringify(res.snap).includes('account-a'));
		});
	});
});

test('one account in two homes is polled once, through the login that has a live token', async () => {
	await withSandbox(async (box) => {
		await writeClaudeHome(join(box.home, '.claude'), 'live');
		await writeClaudeAccount(box.home, '.claude.json', 'account-a');
		const other = join(box.home, 'claude-other');
		await writeClaudeHome(other, 'stale', Date.now() - 1000);
		await writeClaudeAccount(other, '.claude.json', 'account-a');
		await withUsageApi(async (api, seen, url) => {
			api.claude.body = { five_hour: { utilization: 40, resets_at: iso(NEXT_HOUR) } };
			const res = await collect(box, url, { CLAUDE_CONFIG_DIR: other });
			assert.equal(res.code, 0, res.stderr);
			assert.deepEqual(
				seen.map((s) => s.headers.authorization),
				['Bearer live']
			);
			assert.equal(warnings(res.stderr), 0, res.stderr);
			assert.equal(res.snap.limits.length, 1);
		});
	});
});

test('CLAUDE_CONFIG_DIR naming the default home reads its login once', async () => {
	await withSandbox(async (box) => {
		await writeClaudeLogin(box, validClaude());
		await withUsageApi(async (api, seen, url) => {
			api.claude.body = claudeBody();
			const res = await collect(box, url, { CLAUDE_CONFIG_DIR: join(box.home, '.claude') });
			assert.equal(res.code, 0, res.stderr);
			assert.equal(seen.length, 1);
		});
	});
});

test('a T3 Code Codex shadow home with another ChatGPT seat is polled as its own account', async () => {
	await withSandbox(async (box) => {
		const seat = (user: string) =>
			jwt({
				exp: Math.floor(Date.now() / 1000) + 3600,
				'https://api.openai.com/auth': { chatgpt_account_user_id: `${user}__acct-123` }
			});
		const tokenA = seat('user-a');
		const tokenB = seat('user-b');
		await writeCodexLogin(box, tokenA);
		const shadow = join(box.home, '.codex-t3', 'work');
		await mkdir(shadow, { recursive: true });
		await writeFile(
			join(shadow, 'auth.json'),
			JSON.stringify({ tokens: { access_token: tokenB, account_id: CODEX_ACCOUNT } })
		);
		await writeT3Settings(box, {
			codexWork: { driver: 'codex', config: { shadowHomePath: '~/.codex-t3/work' } }
		});
		await withUsageApi(async (api, seen, url) => {
			api.codex.body = codexFiveHour(30, NEXT_HOUR + 2 * HOUR);
			const res = await collect(box, url);
			assert.equal(res.code, 0, res.stderr);
			assert.equal(seen.length, 2);
			assert.equal(res.snap.limits.length, 2);
			assert.equal(accountsOf(res.snap, 'codex').size, 2);
			assert.match(res.stderr, /polled codex usage \(account [A-Za-z0-9_-]{6}\): five_hour 30%/);
		});
	});
});

test('a Claude refusal in the logs joins the polled window of its account', async () => {
	await withSandbox(async (box) => {
		await writeClaudeLogin(box, validClaude());
		await writeClaudeAccount(box.home, '.claude.json', 'account-a');
		const hitMs = NEXT_HOUR - 3 * HOUR;
		await writeClaudeLog(box, [refusedClaudeWeekly(hitMs, weeklyResetsAt)]);
		await withUsageApi(async (api, _seen, url) => {
			api.claude.body = { limits: [fableWeekly(100)] };
			const res = await collect(box, url);
			assert.equal(res.code, 0, res.stderr);
			assert.equal(res.snap.limits.length, 1);
			assert.equal(res.snap.limits[0].hitAt, iso(hitMs));
			assert.match(res.snap.limits[0].account, /^[A-Za-z0-9_-]{16}$/);
		});
	});
});

test('a Codex refusal with two accounts open is not blamed on either', async () => {
	await withSandbox(async (box) => {
		const seat = (user: string) =>
			jwt({
				exp: Math.floor(Date.now() / 1000) + 3600,
				'https://api.openai.com/auth': { chatgpt_account_user_id: user }
			});
		await writeCodexLogin(box, seat('user-a'));
		const other = join(box.home, 'codex-b');
		await mkdir(other, { recursive: true });
		await writeFile(
			join(other, 'auth.json'),
			JSON.stringify({ tokens: { access_token: seat('user-b'), account_id: CODEX_ACCOUNT } })
		);
		await writeT3Settings(box, {
			b: { driver: 'codex', environment: [{ name: 'CODEX_HOME', value: other, sensitive: false }] }
		});
		await writeCodexLog(box, [sharingRefusal(fiveHourResetsAt - 4 * HOUR)]);
		await withUsageApi(async (api, _seen, url) => {
			api.codex.body = codexFiveHour(100, fiveHourResetsAt);
			const before = Date.now();
			const res = await collect(box, url);
			assert.equal(res.snap.limits.length, 2);
			for (const w of res.snap.limits) assert.ok(Date.parse(w.hitAt) >= before, w.hitAt);
		});
	});
});

// Antigravity

const AG_TOKEN = 'ya29.antigravity-secret';

const agLogin = (extra: Record<string, unknown> = {}) =>
	JSON.stringify({
		token: {
			access_token: AG_TOKEN,
			token_type: 'Bearer',
			refresh_token: 'ag-refresh-secret',
			expiry: iso(Date.now() + HOUR),
			...extra
		},
		auth_method: 'consumer',
		id_token_email: 'Someone@Example.com'
	});

async function writeT3AntigravityLogin(box: Sandbox, text: string, profile = 'p1') {
	const dir = join(
		box.home,
		'.t3',
		'userdata',
		'providers',
		'antigravity',
		profile,
		'antigravity-acp'
	);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, 'antigravity-oauth-token'), text);
}

const agBucket = (id: string, window: string, remaining: number | undefined, resetMs: number) => ({
	bucketId: id,
	window,
	resetTime: iso(resetMs),
	...(remaining === undefined ? {} : { remainingFraction: remaining })
});

const nowWindow = (minutes: number) => Date.now() + minutes * 60_000;

test('Antigravity quota buckets are polled from both endpoints, the live reading winning', async () => {
	await withSandbox(async (box) => {
		await writeT3AntigravityLogin(box, agLogin());
		await withUsageApi(async (api, seen, url) => {
			api.agDaily.body = {
				groups: [
					{
						buckets: [
							agBucket('gemini-weekly', 'weekly', 0.75, NEXT_HOUR + 48 * HOUR),
							agBucket('gemini-5h', '5h', undefined, NEXT_HOUR + 2 * HOUR)
						]
					}
				]
			};
			api.agProd.body = {
				groups: [
					{
						buckets: [
							agBucket('gemini-5h', '5h', 1, nowWindow(300)),
							agBucket('3p-weekly', 'weekly', 1, nowWindow(10080)),
							agBucket('3p-5h', '5h', 0.9, NEXT_HOUR + 3 * HOUR)
						]
					}
				]
			};
			const res = await collect(box, url);
			assert.equal(res.code, 0, res.stderr);
			assert.deepEqual(windows(res.snap, 'antigravity'), [
				['five_hour_3p', iso(NEXT_HOUR + 3 * HOUR), 10, false],
				['five_hour_gemini', iso(NEXT_HOUR + 2 * HOUR), 100, true],
				['seven_day_gemini', iso(NEXT_HOUR + 48 * HOUR), 25, false]
			]);
			assert.equal(accountsOf(res.snap, 'antigravity').size, 1);
			assert.deepEqual(seen.map((s) => s.path).sort(), ['/agDaily', '/agProd']);
			for (const s of seen) {
				assert.equal(s.headers.authorization, `Bearer ${AG_TOKEN}`);
				assert.match(String(s.headers['user-agent']), /^antigravity\/hub\/[\d.]+ \(aidev_client;/);
			}
			const state = await readFile(
				join(box.env.XDG_CACHE_HOME, 'big-spender', 'state.json'),
				'utf8'
			);
			for (const secret of [AG_TOKEN, 'ag-refresh-secret', 'someone@example.com']) {
				assert.ok(
					!res.stdout.includes(secret) && !res.stderr.includes(secret) && !state.includes(secret)
				);
			}
		});
	});
});

test('two T3 profiles signed in to one Google account are polled once', async () => {
	await withSandbox(async (box) => {
		await writeT3AntigravityLogin(box, agLogin(), 'p1');
		await writeT3AntigravityLogin(box, agLogin(), 'p2');
		await withUsageApi(async (api, seen, url) => {
			api.agDaily.body = { groups: [{ buckets: [agBucket('gemini-5h', '5h', 0.5, NEXT_HOUR)] }] };
			const res = await collect(box, url);
			assert.equal(res.code, 0, res.stderr);
			assert.equal(seen.length, 2, 'one request per endpoint');
			assert.equal(res.snap.limits.length, 1);
		});
	});
});

test('an expired Antigravity login sends nothing and warns once', async () => {
	await withSandbox(async (box) => {
		await writeT3AntigravityLogin(box, agLogin({ expiry: iso(Date.now() - 1000) }));
		await withUsageApi(async (_api, seen, url) => {
			const res = await collect(box, url);
			assert.equal(res.code, 0, res.stderr);
			assert.deepEqual(seen, []);
			assert.match(res.stderr, /antigravity usage not polled: the login token expired/);
		});
	});
});

// Antigravity's server logs a refused request in glog format, in local time, with how long until
// the quota resets. The collector runs these tests with TZ=Etc/GMT-1 (UTC+1, no DST).
const AG_TZ = { TZ: 'Etc/GMT-1' };
const AG_UTC_OFFSET = HOUR;
const pad = (n: number, width = 2) => String(n).padStart(width, '0');
const agLocal = (ms: number) => new Date(ms + AG_UTC_OFFSET);
const agLogTime = (ms: number) => {
	const d = agLocal(ms);
	return `${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}000`;
};
const AG_QUOTA =
	'Individual quota reached. Please upgrade your subscription to increase your limits.';
// `logTime` is the glog time after the level letter: `MMDD hh:mm:ss.micros`.
const agRefusalLine = (logTime: string, resetsIn: string, prefix = 'agent executor error: ') =>
	`E${logTime}     404 errorreport.go:282] ${prefix}generating and executing: transport error (ResourceExhausted, HTTP 429): ${AG_QUOTA} Resets in ${resetsIn}.: RESOURCE_EXHAUSTED (code 429): ${AG_QUOTA} Resets in ${resetsIn}.`;
const agRefusalLines = (ms: number, resetsIn: string) => [
	agRefusalLine(agLogTime(ms), resetsIn),
	agRefusalLine(agLogTime(ms + 2), resetsIn, '')
];

const agProfileDir = (box: Sandbox, profile = 'p1') =>
	join(box.home, '.t3', 'userdata', 'providers', 'antigravity', profile, 'antigravity-acp');
const agStamp = (ms: number) => {
	const d = agLocal(ms);
	return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
};

// Writes (or appends to) an Antigravity server log; returns its path.
async function writeAgLog(dir: string, name: string, lines: string[], flag = 'w') {
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, name), lines.join('\n') + '\n', { flag });
	return join(dir, name);
}

async function writeAgServerLog(box: Sandbox, startedMs: number, lines: string[], profile = 'p1') {
	const startup = `I${agLogTime(startedMs)}     101 server_oauth.go:221] applyAuthResult: authMethod=consumer`;
	return writeAgLog(
		join(agProfileDir(box, profile), 'log'),
		`acp-server-${agStamp(startedMs)}-2753018.log`,
		[startup, ...lines]
	);
}

// State from an earlier run that polled the window; polling is then off.
async function seedAgWindow(box: Sandbox, window: string, resetsAtMs: number, peakPercent: number) {
	const dir = join(box.env.XDG_CACHE_HOME, 'big-spender');
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, 'state.json'),
		JSON.stringify({
			version: 1,
			files: {},
			seen: {},
			buckets: {},
			limits: {
				[`antigravity|${window}|${resetsAtMs}`]: {
					provider: 'antigravity',
					window,
					resetsAt: iso(resetsAtMs),
					peakPercent
				}
			},
			fixes: ['claude-final-output', 'usage-limits', 'codex-refusals']
		})
	);
}

const agHits = (snap: { limits?: Win[] }) =>
	(snap.limits ?? [])
		.filter((w) => w.provider === 'antigravity')
		.map((w) => [w.window, w.resetsAt, w.peakPercent, w.hitAt])
		.sort();

// Seen on 2026-11-25: the poll read gemini-5h at 99.37% at 15:01:20 UTC, Antigravity refused at
// 15:01:35 with "Resets in 1h24m24s", and the next poll could not run before the 16:26 reset.
test('an Antigravity refusal in the server log starts the lockout at the refusal', async () => {
	await withSandbox(async (box) => {
		await writeT3AntigravityLogin(box, agLogin());
		const resetsAt = NEXT_HOUR;
		const refusedAt = resetsAt - (HOUR + 24 * 60_000 + 24_000) - 360;
		await writeAgServerLog(box, refusedAt - 60_000, agRefusalLines(refusedAt, '1h24m24s'));
		await withUsageApi(async (api, _seen, url) => {
			api.agDaily.body = {
				groups: [
					{
						buckets: [
							agBucket('gemini-5h', '5h', 0.0063116, resetsAt),
							agBucket('gemini-weekly', 'weekly', 0.34, NEXT_HOUR + 48 * HOUR)
						]
					}
				]
			};
			const res = await collect(box, url, AG_TZ);
			assert.equal(res.code, 0, res.stderr);
			assert.deepEqual(
				res.snap.limits
					.filter((w: Win) => w.provider === 'antigravity')
					.map((w: Win) => [w.window, w.resetsAt, w.peakPercent, w.hitAt])
					.sort(),
				[
					['five_hour_gemini', iso(resetsAt), 100, iso(refusedAt)],
					['seven_day_gemini', iso(NEXT_HOUR + 48 * HOUR), 66, undefined]
				]
			);
		});
	});
});

test('an Antigravity refusal whose reset matches no window on file records nothing', async () => {
	await withSandbox(async (box) => {
		await writeT3AntigravityLogin(box, agLogin());
		const resetsAt = NEXT_HOUR;
		const refusedAt = resetsAt - 2 * HOUR;
		// Resets an hour away from the only polled window: not that window.
		await writeAgServerLog(box, refusedAt - 60_000, agRefusalLines(refusedAt, '1h0m0s'));
		await withUsageApi(async (api, _seen, url) => {
			api.agDaily.body = { groups: [{ buckets: [agBucket('gemini-5h', '5h', 0.4, resetsAt)] }] };
			const res = await collect(box, url, AG_TZ);
			assert.equal(res.code, 0, res.stderr);
			assert.deepEqual(windows(res.snap, 'antigravity'), [
				['five_hour_gemini', iso(resetsAt), 60, false]
			]);
		});
	});
});

test('an Antigravity refusal goes to the window it falls in, not one with the same reset', async () => {
	await withSandbox(async (box) => {
		await writeT3AntigravityLogin(box, agLogin());
		const resetsAt = NEXT_HOUR;
		const refusedAt = resetsAt - 48 * HOUR;
		await writeAgServerLog(box, refusedAt - 60_000, agRefusalLines(refusedAt, '2d0h0m0s'));
		await withUsageApi(async (api, _seen, url) => {
			api.agDaily.body = {
				groups: [
					{
						buckets: [
							agBucket('gemini-5h', '5h', 0.5, resetsAt),
							agBucket('gemini-weekly', 'weekly', 0.01, resetsAt)
						]
					}
				]
			};
			const res = await collect(box, url, AG_TZ);
			assert.equal(res.code, 0, res.stderr);
			assert.deepEqual(agHits(res.snap), [
				['five_hour_gemini', iso(resetsAt), 50, undefined],
				['seven_day_gemini', iso(resetsAt), 100, iso(refusedAt)]
			]);
		});
	});
});

test("an Antigravity refusal in one Google account's log is not blamed on another's window", async () => {
	await withSandbox(async (box) => {
		await writeT3AntigravityLogin(box, agLogin(), 'p1');
		const other = JSON.parse(agLogin({ expiry: iso(Date.now() - HOUR) }));
		other.id_token_email = 'other@example.com';
		await writeT3AntigravityLogin(box, JSON.stringify(other), 'p2');
		const resetsAt = NEXT_HOUR;
		const refusedAt = resetsAt - HOUR;
		await writeAgServerLog(box, refusedAt - 60_000, agRefusalLines(refusedAt, '1h0m0s'), 'p2');
		await withUsageApi(async (api, _seen, url) => {
			api.agDaily.body = { groups: [{ buckets: [agBucket('gemini-5h', '5h', 0.6, resetsAt)] }] };
			const res = await collect(box, url, AG_TZ);
			assert.equal(res.code, 0, res.stderr);
			assert.deepEqual(agHits(res.snap), [['five_hour_gemini', iso(resetsAt), 40, undefined]]);
		});
	});
});

test('an Antigravity refusal whose reset two windows share records nothing', async () => {
	await withSandbox(async (box) => {
		await writeT3AntigravityLogin(box, agLogin());
		const resetsAt = NEXT_HOUR;
		const refusedAt = resetsAt - HOUR;
		await writeAgServerLog(box, refusedAt - 60_000, agRefusalLines(refusedAt, '1h0m0s'));
		await withUsageApi(async (api, _seen, url) => {
			api.agDaily.body = {
				groups: [
					{
						buckets: [
							agBucket('gemini-5h', '5h', 0.02, resetsAt),
							agBucket('3p-5h', '5h', 0.5, resetsAt)
						]
					}
				]
			};
			const res = await collect(box, url, AG_TZ);
			assert.equal(res.code, 0, res.stderr);
			assert.deepEqual(agHits(res.snap), [
				['five_hour_3p', iso(resetsAt), 50, undefined],
				['five_hour_gemini', iso(resetsAt), 98, undefined]
			]);
		});
	});
});

test('an Antigravity refusal logged after the last poll counts while the login is expired', async () => {
	await withSandbox(async (box) => {
		await writeT3AntigravityLogin(box, agLogin());
		const resetsAt = NEXT_HOUR;
		const refusedAt = resetsAt - (HOUR + 24 * 60_000 + 24_000) - 360;
		const log = await writeAgServerLog(box, refusedAt - 60 * 60_000, []);
		await withUsageApi(async (api, _seen, url) => {
			api.agDaily.body = {
				groups: [{ buckets: [agBucket('gemini-5h', '5h', 0.0063116, resetsAt)] }]
			};
			const first = await collect(box, url, AG_TZ);
			assert.deepEqual(agHits(first.snap), [
				['five_hour_gemini', iso(resetsAt), 99.3688, undefined]
			]);

			await writeT3AntigravityLogin(box, agLogin({ expiry: iso(Date.now() - 60_000) }));
			await writeFile(log, agRefusalLines(refusedAt, '1h24m24s').join('\n') + '\n', {
				flag: 'a'
			});
			const res = await collect(box, url, AG_TZ);
			assert.equal(res.code, 0, res.stderr);
			assert.match(res.stderr, /antigravity usage not polled/);
			assert.deepEqual(agHits(res.snap), [
				['five_hour_gemini', iso(resetsAt), 100, iso(refusedAt)]
			]);
		});
	});
});

test('an Antigravity CLI refusal is blamed when one account is on file', async () => {
	await withSandbox(async (box) => {
		await writeT3AntigravityLogin(box, agLogin());
		const resetsAt = NEXT_HOUR;
		const refusedAt = resetsAt - HOUR;
		await writeAgLog(
			join(box.home, '.gemini', 'antigravity-cli', 'log'),
			`cli-${agStamp(refusedAt - 60_000)}.log`,
			agRefusalLines(refusedAt, '1h0m0s')
		);
		await withUsageApi(async (api, _seen, url) => {
			api.agDaily.body = { groups: [{ buckets: [agBucket('gemini-5h', '5h', 0.03, resetsAt)] }] };
			const res = await collect(box, url, AG_TZ);
			assert.equal(res.code, 0, res.stderr);
			assert.deepEqual(agHits(res.snap), [
				['five_hour_gemini', iso(resetsAt), 100, iso(refusedAt)]
			]);
		});
	});
});

test('an Antigravity refusal on 1 January in a log started on 31 December is in the new year', async () => {
	await withSandbox(async (box) => {
		const year = new Date().getUTCFullYear();
		// UTC+1: 00:30 local on 1 January is 23:30 UTC on 31 December.
		const refusedAt = Date.UTC(year, 11, 31, 23, 30);
		const resetsAt = Date.UTC(year + 1, 0, 1, 1, 0);
		await seedAgWindow(box, 'five_hour_gemini', resetsAt, 98);
		await writeAgLog(
			join(box.home, '.gemini', 'antigravity-cli', 'log'),
			`cli-${year}1231_230000.log`,
			[agRefusalLine('0101 00:30:00.000000', '1h30m0s')]
		);
		await withUsageApi(async (_api, _seen, url) => {
			const res = await collect(box, url, { ...AG_TZ, BIG_SPENDER_POLL_LIMITS: 'off' });
			assert.equal(res.code, 0, res.stderr);
			assert.deepEqual(agHits(res.snap), [
				['five_hour_gemini', iso(resetsAt), 100, iso(refusedAt)]
			]);
		});
	});
});

test('an Antigravity refusal in the hour repeated when summer time ends is placed', async () => {
	await withSandbox(async (box) => {
		// Europe/Amsterdam goes from 03:00 CEST back to 02:00 CET at 01:00 UTC on the last Sunday
		// of October, so 02:30 local happens at 00:30 and again at 01:30 UTC.
		const year = new Date().getUTCFullYear() + 1;
		const day = 31 - new Date(Date.UTC(year, 9, 31)).getUTCDay();
		const refusedAt = Date.UTC(year, 9, day, 1, 30);
		const resetsAt = Date.UTC(year, 9, day, 3, 0);
		await seedAgWindow(box, 'five_hour_gemini', resetsAt, 98);
		await writeAgLog(
			join(box.home, '.gemini', 'antigravity-cli', 'log'),
			`cli-${year}10${pad(day)}_020000.log`,
			[agRefusalLine(`10${pad(day)} 02:30:00.000000`, '1h30m0s')]
		);
		await withUsageApi(async (_api, _seen, url) => {
			const res = await collect(box, url, {
				TZ: 'Europe/Amsterdam',
				BIG_SPENDER_POLL_LIMITS: 'off'
			});
			assert.equal(res.code, 0, res.stderr);
			assert.deepEqual(agHits(res.snap), [
				['five_hour_gemini', iso(resetsAt), 100, iso(refusedAt)]
			]);
		});
	});
});

test('Antigravity server logs reached through a linked ANTIGRAVITY_DATA_DIR are read once', async () => {
	await withSandbox(async (box) => {
		const root = join(box.home, '.gemini', 'antigravity');
		await writeAgLog(join(root, 'log'), `cli-${agStamp(Date.now() - HOUR)}.log`, ['I1125 x']);
		const linked = join(box.home, 'linked-ag');
		await symlink(root, linked);
		await withUsageApi(async (_api, _seen, url) => {
			const res = await collect(box, url, {
				...AG_TZ,
				ANTIGRAVITY_DATA_DIR: linked,
				BIG_SPENDER_POLL_LIMITS: 'off'
			});
			assert.equal(res.code, 0, res.stderr);
			const state = JSON.parse(
				await readFile(join(box.env.XDG_CACHE_HOME, 'big-spender', 'state.json'), 'utf8')
			);
			assert.equal(Object.keys(state.files).filter((f) => f.endsWith('.log')).length, 1);
		});
	});
});

test('one Antigravity endpoint failing still records the other', async () => {
	await withSandbox(async (box) => {
		await writeT3AntigravityLogin(box, agLogin());
		await withUsageApi(async (api, _seen, url) => {
			api.agDaily = { status: 503, body: {} };
			api.agProd.body = { groups: [{ buckets: [agBucket('gemini-5h', '5h', 0.5, NEXT_HOUR)] }] };
			const res = await collect(box, url);
			assert.equal(warnings(res.stderr), 0, res.stderr);
			assert.deepEqual(windows(res.snap, 'antigravity'), [
				['five_hour_gemini', iso(NEXT_HOUR), 50, false]
			]);
		});
	});
});

test(
	'on Linux the Antigravity CLI login is read from the keyring',
	{ skip: process.platform !== 'linux' },
	async () => {
		await withSandbox(async (box) => {
			const bin = join(box.home, 'bin');
			await mkdir(bin, { recursive: true });
			const login = join(box.home, 'keyring-login.json');
			await writeFile(login, agLogin());
			await writeFile(
				join(bin, 'secret-tool'),
				`#!/bin/sh\n[ "$*" = "lookup service gemini username antigravity" ] && exec cat '${login}'\nexit 1\n`,
				{ mode: 0o755 }
			);
			await withUsageApi(async (api, seen, url) => {
				api.agDaily.body = { groups: [{ buckets: [agBucket('3p-5h', '5h', 0.8, NEXT_HOUR)] }] };
				const res = await collect(box, url, { PATH: `${bin}:/usr/bin:/bin` });
				assert.equal(res.code, 0, res.stderr);
				assert.equal(seen.length, 2);
				assert.deepEqual(windows(res.snap, 'antigravity'), [
					['five_hour_3p', iso(NEXT_HOUR), 20, false]
				]);
			});
		});
	}
);

test('a server too old for accounts gets the limits again without them', async () => {
	await withSandbox(async (box) => {
		await seedPricing(join(box.env.XDG_CACHE_HOME, 'big-spender'));
		await writeT3AntigravityLogin(box, agLogin());
		const bodies: { limits?: Win[] }[] = [];
		const ingest = createServer(async (req, res) => {
			const chunks: Buffer[] = [];
			for await (const c of req) chunks.push(c as Buffer);
			const body = JSON.parse(gunzipSync(Buffer.concat(chunks)).toString());
			bodies.push(body);
			res.setHeader('content-type', 'application/json');
			if (body.limits?.some((w: Win) => 'account' in w)) {
				res.statusCode = 422;
				res.end(
					JSON.stringify({
						error: 'invalid snapshot',
						issues: ['limits.0: Unrecognized key: "account"']
					})
				);
			} else res.end('{"ok":true}');
		});
		await new Promise<void>((resolve) => ingest.listen(0, '127.0.0.1', resolve));
		try {
			await withUsageApi(async (api, _seen, url) => {
				api.agDaily.body = { groups: [{ buckets: [agBucket('3p-5h', '5h', 0.5, NEXT_HOUR)] }] };
				const res = await run(COLLECTOR, [], {
					...box.env,
					BIG_SPENDER_DEVICE_ID: 'laptop',
					BIG_SPENDER_INGEST_URL: `http://127.0.0.1:${(ingest.address() as AddressInfo).port}/`,
					BIG_SPENDER_INGEST_TOKEN: 'tok',
					BIG_SPENDER_ANTIGRAVITY_DAILY_URL: `${url}/agDaily`,
					BIG_SPENDER_ANTIGRAVITY_USAGE_URL: `${url}/agProd`
				});
				assert.equal(res.code, 0, res.stderr);
				assert.match(res.stderr, /too old to tell accounts apart/);
				assert.equal(bodies.length, 2);
				assert.deepEqual(
					bodies[1].limits?.map((w) => [w.provider, w.window, 'account' in w]),
					[['antigravity', 'five_hour_3p', false]]
				);
			});
		} finally {
			ingest.closeAllConnections();
			await new Promise((resolve) => ingest.close(resolve));
		}
	});
});

// An idle window: the endpoint reports 0% and a reset one window length from now, on every poll.
const idleCodexBody = (nowMs: number) => ({
	rate_limit: {
		primary_window: {
			used_percent: 0,
			limit_window_seconds: 18000,
			reset_after_seconds: 18000,
			reset_at: Math.floor(nowMs / 1000) + 18000
		},
		secondary_window: {
			used_percent: 100,
			limit_window_seconds: 604800,
			reset_after_seconds: 51976,
			reset_at: (NEXT_HOUR + 14 * HOUR) / 1000
		}
	}
});

test('an idle Codex window polled every hour records no window instances', async () => {
	await withSandbox(async (box) => {
		await writeCodexLogin(box, liveCodexToken());
		await withUsageApi(async (api, _seen, url) => {
			for (let run = 0; run < 3; run++) {
				api.codex.body = idleCodexBody(Date.now());
				const res = await collect(box, url);
				assert.equal(res.code, 0, res.stderr);
				assert.deepEqual(windows(res.snap, 'codex'), [
					['seven_day', iso(NEXT_HOUR + 14 * HOUR), 100, true]
				]);
			}
		});
	});
});

test('a Codex window opened ten minutes ago at 0% is read as in use, not idle', async () => {
	await withSandbox(async (box) => {
		await writeCodexLogin(box, liveCodexToken());
		await withUsageApi(async (api, _seen, url) => {
			api.codex.body = codexFiveHour(0, Date.now() + 5 * HOUR - 10 * 60_000);
			const res = await collect(box, url);
			assert.match(res.stderr, /polled codex usage: five_hour 0%/);
		});
	});
});

test('idle placeholders an older version stored are not sent', async () => {
	await withSandbox(async (box) => {
		await writeCodexLogin(box, liveCodexToken());
		await withUsageApi(async (api, _seen, url) => {
			api.codex.body = codexFiveHour(40, NEXT_HOUR + 2 * HOUR);
			assert.equal((await collect(box, url)).code, 0);
			const statePath = join(box.env.XDG_CACHE_HOME, 'big-spender', 'state.json');
			const state = JSON.parse(await readFile(statePath, 'utf8'));
			for (const hours of [1, 2, 3]) {
				const resetsAt = iso(NEXT_HOUR - hours * HOUR + 60_000);
				state.limits[`codex|five_hour|${Date.parse(resetsAt)}`] = {
					provider: 'codex',
					window: 'five_hour',
					resetsAt,
					peakPercent: 0
				};
			}
			await writeFile(statePath, JSON.stringify(state));
			const res = await collect(box, url);
			assert.deepEqual(windows(res.snap, 'codex'), [
				['five_hour', iso(NEXT_HOUR + 2 * HOUR), 40, false]
			]);
		});
	});
});

test('a lockout missed between runs is still placed when the poll finds the five-hour window idle', async () => {
	await withSandbox(async (box) => {
		await writeCodexLogin(box, liveCodexToken());
		await writeCodexLog(box, missedLockoutLogWithWeekly());
		await withUsageApi(async (api, _seen, url) => {
			api.codex.body = {
				rate_limit: {
					primary_window: {
						used_percent: 0,
						limit_window_seconds: 18000,
						reset_after_seconds: 18000,
						reset_at: Math.floor(Date.now() / 1000) + 18000
					},
					secondary_window: polledWindow(50, 604800, WEEKLY)
				}
			};
			const res = await collect(box, url);
			assert.equal(res.code, 0, res.stderr);
			assert.deepEqual(hitsOf(res.snap).sort(), [
				['five_hour', iso(OLD_FIVE_HOUR), 100, iso(REFUSED_AT)],
				['seven_day', iso(WEEKLY), 50, undefined]
			]);
		});
	});
});

test('a second Codex account whose windows are idle still blocks blaming a refusal', async () => {
	await withSandbox(async (box) => {
		const seat = (user: string) =>
			jwt({
				exp: Math.floor(Date.now() / 1000) + 3600,
				'https://api.openai.com/auth': { chatgpt_account_user_id: user }
			});
		await writeCodexLogin(box, seat('user-a'));
		const other = join(box.home, 'codex-b');
		await mkdir(other, { recursive: true });
		await writeFile(
			join(other, 'auth.json'),
			JSON.stringify({ tokens: { access_token: seat('user-b'), account_id: CODEX_ACCOUNT } })
		);
		await writeT3Settings(box, { b: { driver: 'codex', config: { homePath: other } } });
		const fullAt = REFUSED_AT + 30 * 60_000;
		await writeCodexLog(box, [
			sharingRefusal(REFUSED_AT),
			codexTokenCount(fullAt, 300, 100, OLD_FIVE_HOUR)
		]);
		const idle = (seconds: number) => ({
			used_percent: 0,
			limit_window_seconds: seconds,
			reset_after_seconds: seconds,
			reset_at: Math.floor(Date.now() / 1000) + seconds
		});
		await withUsageApi(async (api, seen, url) => {
			api.codex.body = {
				rate_limit: { primary_window: idle(18000), secondary_window: idle(604800) }
			};
			const res = await collect(box, url);
			assert.equal(seen.length, 2);
			assert.deepEqual(hitsOf(res.snap), [['five_hour', iso(OLD_FIVE_HOUR), 100, iso(fullAt)]]);
		});
	});
});

test('CLAUDE_CONFIG_DIR with a trailing slash still finds the account beside ~/.claude', async () => {
	await withSandbox(async (box) => {
		await writeClaudeLogin(box, validClaude());
		await writeClaudeAccount(box.home, '.claude.json', 'account-a');
		await withUsageApi(async (api, seen, url) => {
			api.claude.body = claudeBody();
			const res = await collect(box, url, { CLAUDE_CONFIG_DIR: `${join(box.home, '.claude')}/` });
			assert.equal(seen.length, 1);
			assert.ok(
				res.snap.limits.every((w: Win) => w.account),
				JSON.stringify(res.snap.limits)
			);
		});
	});
});

test('a server that keeps refusing accounts is asked once more, then the push fails', async () => {
	await withSandbox(async (box) => {
		await seedPricing(join(box.env.XDG_CACHE_HOME, 'big-spender'));
		await writeT3AntigravityLogin(box, agLogin());
		let requests = 0;
		const ingest = createServer(async (req, res) => {
			for await (const _ of req);
			requests++;
			res.statusCode = 422;
			res.setHeader('content-type', 'application/json');
			res.end(
				JSON.stringify({
					error: 'invalid snapshot',
					issues: ['limits.0: Unrecognized key: "account"']
				})
			);
		});
		await new Promise<void>((resolve) => ingest.listen(0, '127.0.0.1', resolve));
		try {
			await withUsageApi(async (api, _seen, url) => {
				api.agDaily.body = { groups: [{ buckets: [agBucket('3p-5h', '5h', 0.5, NEXT_HOUR)] }] };
				const res = await run(COLLECTOR, [], {
					...box.env,
					BIG_SPENDER_DEVICE_ID: 'laptop',
					BIG_SPENDER_INGEST_URL: `http://127.0.0.1:${(ingest.address() as AddressInfo).port}/`,
					BIG_SPENDER_INGEST_TOKEN: 'tok',
					BIG_SPENDER_ANTIGRAVITY_DAILY_URL: `${url}/agDaily`,
					BIG_SPENDER_ANTIGRAVITY_USAGE_URL: `${url}/agProd`
				});
				assert.notEqual(res.code, 0);
				assert.equal(requests, 2);
			});
		} finally {
			ingest.closeAllConnections();
			await new Promise((resolve) => ingest.close(resolve));
		}
	});
});

test("a refusal in the logs joins its account's polled window without moving its reset", async () => {
	await withSandbox(async (box) => {
		await writeClaudeLogin(box, validClaude());
		await writeClaudeAccount(box.home, '.claude.json', 'account-a');
		const hitMs = NEXT_HOUR - 3 * HOUR;
		await writeClaudeLog(box, [refusedClaudeWeekly(hitMs, weeklyResetsAt - 60_000)]);
		await withUsageApi(async (api, _seen, url) => {
			api.claude.body = { limits: [fableWeekly(100)] };
			const res = await collect(box, url);
			assert.deepEqual(hitsOf(res.snap), [
				['seven_day_fable', iso(weeklyResetsAt), 100, iso(hitMs)]
			]);
		});
	});
});

// Seeds state with limit records, then reads one logged Fable refusal with the given reset.
async function refusalAgainst(box: Sandbox, url: string, records: Win[], refusalReset: number) {
	const off = { BIG_SPENDER_POLL_LIMITS: 'off' };
	assert.equal((await collect(box, url, off)).code, 0);
	const statePath = join(box.env.XDG_CACHE_HOME, 'big-spender', 'state.json');
	const state = JSON.parse(await readFile(statePath, 'utf8'));
	state.limits = Object.fromEntries(records.map((r, i) => [`seed-${i}`, r]));
	await writeFile(statePath, JSON.stringify(state));
	await writeClaudeLog(box, [refusedClaudeWeekly(NEXT_HOUR - 3 * HOUR, refusalReset)]);
	const res = await collect(box, url, off);
	assert.equal(res.code, 0, res.stderr);
	return (res.snap.limits as Win[])
		.map((w) => [w.account ?? null, w.resetsAt, w.peakPercent, w.hitAt ?? null])
		.sort((x, y) => String(x[1]).localeCompare(String(y[1])));
}

const ACCT = 'accountAAAAAAAAA';
const fable = (resetMs: number, extra: Partial<Win> = {}): Win => ({
	provider: 'claude',
	window: 'seven_day_fable',
	resetsAt: iso(resetMs),
	peakPercent: 40,
	...extra
});

test('a logged refusal joins only the nearest accounted window, not a loose one beside it', async () => {
	await withSandbox(async (box) => {
		await withUsageApi(async (_api, _seen, url) => {
			const looseHit = iso(NEXT_HOUR - 10 * HOUR);
			const limits = await refusalAgainst(
				box,
				url,
				[
					fable(weeklyResetsAt, { account: ACCT }),
					fable(weeklyResetsAt + 4 * 60_000, { peakPercent: 90, hitAt: looseHit })
				],
				weeklyResetsAt + 2 * 60_000
			);
			assert.deepEqual(limits, [
				[ACCT, iso(weeklyResetsAt), 100, iso(NEXT_HOUR - 3 * HOUR)],
				[null, iso(weeklyResetsAt + 4 * 60_000), 90, looseHit]
			]);
		});
	});
});

test("a logged refusal between two of one account's windows joins the nearer one only", async () => {
	await withSandbox(async (box) => {
		await withUsageApi(async (_api, _seen, url) => {
			const limits = await refusalAgainst(
				box,
				url,
				[
					fable(weeklyResetsAt, { account: ACCT }),
					fable(weeklyResetsAt + 3 * 60_000, { account: ACCT, peakPercent: 50 })
				],
				weeklyResetsAt + 2 * 60_000
			);
			assert.deepEqual(limits, [
				[ACCT, iso(weeklyResetsAt), 40, null],
				[ACCT, iso(weeklyResetsAt + 3 * 60_000), 100, iso(NEXT_HOUR - 3 * HOUR)]
			]);
		});
	});
});

// The account hash is keyed with the ingest token, so a leaked data file can't be matched
// against known account ids or emails, nor against another tool's plain hash of the same id.

const keyedHash = (token: string, id: string) =>
	createHmac('sha256', token).update(id).digest('base64url').slice(0, 16);
const plainHash = (id: string) => createHash('sha256').update(id).digest('base64url').slice(0, 16);

test('the account hash is an HMAC of the account id keyed with the ingest token', async () => {
	const accounts: (string | undefined)[][] = [];
	for (const token of ['token-one', 'token-two']) {
		await withSandbox(async (box) => {
			await writeT3AntigravityLogin(box, agLogin());
			await withUsageApi(async (api, _seen, url) => {
				api.agDaily.body = { groups: [{ buckets: [agBucket('3p-5h', '5h', 0.5, NEXT_HOUR)] }] };
				const res = await collect(box, url, { BIG_SPENDER_INGEST_TOKEN: token });
				assert.equal(res.code, 0, res.stderr);
				accounts.push(res.snap.limits.map((w: Win) => w.account));
			});
		});
	}
	const id = 'antigravity-account\0someone@example.com';
	assert.deepEqual(accounts, [[keyedHash('token-one', id)], [keyedHash('token-two', id)]]);
	assert.notEqual(accounts[0][0], plainHash(id));
});

test('without an ingest token no usage endpoint is asked and nothing is stored from a poll', async () => {
	await withSandbox(async (box) => {
		await writeClaudeLogin(box, validClaude());
		await writeClaudeAccount(box.home, '.claude.json', 'account-a');
		await withUsageApi(async (api, seen, url) => {
			api.claude.body = claudeBody();
			const res = await collect(box, url, { BIG_SPENDER_INGEST_TOKEN: '' });
			assert.equal(res.code, 0, res.stderr);
			assert.equal(seen.length, 0);
			assert.deepEqual(res.snap.limits ?? [], []);
			assert.match(res.stderr, /limits not polled: BIG_SPENDER_INGEST_TOKEN is not set/);
		});
	});
});
