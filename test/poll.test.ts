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
		secondary_window: polledWindow(95, 604800, WEEKLY)
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
				['seven_day', iso(WEEKLY), 95, undefined]
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

test('a poll that reads the open window below 100% rules it out', async () => {
	await withSandbox(async (box) => {
		await writeCodexLogin(box, liveCodexToken());
		await writeCodexLog(box, missedLockoutLog());
		await withUsageApi(async (api, _seen, url) => {
			api.codex.body = {
				rate_limit: { primary_window: polledWindow(40, 18000, OLD_FIVE_HOUR) }
			};
			const res = await collect(box, url);
			assert.deepEqual(hitsOf(res.snap), [['five_hour', iso(OLD_FIVE_HOUR), 40, undefined]]);
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
