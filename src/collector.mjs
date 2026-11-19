#!/usr/bin/env node
// big-spender collector.
//
// Reads the usage logs of the coding agents listed in SOURCES, works out hourly
// token and cost aggregates (LiteLLM API prices), and POSTs one full snapshot
// to your big-spender server's ingest endpoint. Only numbers, model names, timestamps and the
// device id leave the machine: no paths, prompts, session ids or branches.
// With BIG_SPENDER_CURSOR_API_KEY set it also reads the Cursor account's usage from Cursor's API
// and POSTs it as a second snapshot under the device id "cursor".
//
// Zero dependencies, Node >= 20 (or Bun). `big-spender install` copies this single file to
// ~/.local/share/big-spender/collector.mjs and schedules it. See the package README.
//
// Usage:
//   node collector.mjs              # parse new log bytes, POST the snapshot
//   node collector.mjs --dry-run    # print the snapshot + a 24h summary, no POST
//   node collector.mjs --summary    # print only the 24h summary
//   node collector.mjs --reset      # forget local state and rescan everything
//
// Env: BIG_SPENDER_DEVICE_ID, BIG_SPENDER_INGEST_URL, BIG_SPENDER_INGEST_TOKEN and optionally
// BIG_SPENDER_CURSOR_API_KEY (see templates/env.example).
// The older USAGE_* names are still read when the new one is unset.

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';

const SCHEMA_VERSION = 1;
const STATE_VERSION = 1;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const RETENTION_DAYS = 90;
// Rows older than this are rolled up into daily rows to keep the payload small.
const HOURLY_DAYS = 7;
const PRICING_URL =
	'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const PRICING_TTL_MS = DAY_MS;
const POST_ATTEMPTS = 4;
const CURSOR_DEVICE_ID = 'cursor';
const CURSOR_PAGE_SIZE = 1000;
// The server's date floor (EARLIEST_DATE in schema.ts); the backfill reads from here.
const CURSOR_EARLIEST_MS = Date.parse('2020-01-01T00:00:00Z');

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const SUMMARY_ONLY = args.has('--summary');
const RESET = args.has('--reset');

const HOME = homedir();
const CACHE_DIR = join(process.env.XDG_CACHE_HOME || join(HOME, '.cache'), 'big-spender');
const STATE_PATH = join(CACHE_DIR, 'state.json');
const PRICING_PATH = join(CACHE_DIR, 'litellm-prices.json');
const LOCK_PATH = join(CACHE_DIR, 'run.lock');
const LOCK_STALE_MS = 30 * 60 * 1000;
const ENV_FILE =
	process.env.BIG_SPENDER_ENV_FILE ||
	process.env.USAGE_ENV_FILE ||
	join(process.env.XDG_CONFIG_HOME || join(HOME, '.config'), 'big-spender', 'env');

const log = (...m) => console.error('[big-spender]', ...m);

// The override exists for tests. It only points at this machine, so the Cursor API key and
// access token can't be sent anywhere but Cursor.
function cursorApiUrl(override) {
	if (!override) return 'https://api2.cursor.sh';
	const { hostname } = new URL(override);
	if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) {
		throw new Error('BIG_SPENDER_CURSOR_API_URL may only point at this machine');
	}
	return override.replace(/\/$/, '');
}

// Collectors installed before the rename have USAGE_* in their env file and scheduler units.
const setting = (name) => process.env[`BIG_SPENDER_${name}`] || process.env[`USAGE_${name}`] || '';

// KEY=value lines (optionally quoted). Variables already set in the environment win.
function loadEnvFile() {
	let text;
	try {
		const st = statSync(ENV_FILE);
		if (process.platform !== 'win32' && st.mode & 0o077) {
			log(`warning: ${ENV_FILE} is readable by other users; run: chmod 600 ${ENV_FILE}`);
		}
		text = readFileSync(ENV_FILE, 'utf8');
	} catch {
		return;
	}
	for (const raw of text.split('\n')) {
		const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(raw);
		if (!m || process.env[m[1]] !== undefined) continue;
		process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
	}
}

// Hourly timers and RunAtLoad can overlap; only one run may touch the state file.
async function acquireLock() {
	await mkdir(CACHE_DIR, { recursive: true });
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fh = await open(LOCK_PATH, 'wx');
			await fh.writeFile(String(process.pid));
			await fh.close();
			return () => rm(LOCK_PATH, { force: true });
		} catch (err) {
			if (err.code !== 'EEXIST') throw err;
			const st = await stat(LOCK_PATH).catch(() => null);
			if (st && Date.now() - st.mtimeMs < LOCK_STALE_MS) return null;
			await rm(LOCK_PATH, { force: true });
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// State

/**
 * @typedef {{ input: number, cacheRead: number, cacheWrite: number, output: number, savings: number }} Cost
 * @typedef {{ input: number, cacheRead: number, cacheWrite5m: number, cacheWrite1h: number, output: number, sessions: string[], cost?: Cost }} Bucket
 * A JSONL file's read position. Readers may keep their own fields on it (Codex: model, sessionId, lastTotal; pi: forkCalls).
 * @typedef {{ size: number, mtimeMs: number, offset: number, model?: string, sessionId?: string, lastTotal?: number, forkCalls?: string[] }} FileState
 * A seen entry is the first timestamp, or for Claude [first timestamp, output tokens counted].
 * A bare number on a Claude key means the counted output is unknown (state from an older version).
 * @typedef {number | [number, number]} Seen
 * One subscription usage window instance; see limitWindowSchema in src/schema.ts.
 * @typedef {{ provider: string, window: string, resetsAt: string, peakPercent: number, hitAt?: string }} Limit
 * @typedef {{ version: number, files: Record<string, FileState>, seen: Record<string, Seen>, buckets: Record<string, Bucket>, limits?: Record<string, Limit>, fixes?: string[], rescan?: string[], cursorBackfills?: string[] }} State
 * cursorBackfills holds a hash of each ingest URL and Cursor API key pair whose server stored the
 * account's full history. Hashed, because an ingest URL can carry a credential.
 */

// One-time fixes to existing state. The state version stays the same so an older installed copy
// can still read the file instead of discarding it.
const FIX_CLAUDE_OUTPUT = 'claude-final-output';
// Limit windows are read from log lines older versions skipped, so those logs are re-read once.
const FIX_LIMITS = 'usage-limits';

/** @returns {Promise<State>} */
async function loadState() {
	const empty = {
		version: STATE_VERSION,
		files: {},
		seen: {},
		buckets: {},
		limits: {},
		fixes: [FIX_CLAUDE_OUTPUT, FIX_LIMITS]
	};
	if (RESET) return empty;
	try {
		const s = JSON.parse(await readFile(STATE_PATH, 'utf8'));
		if (s?.version !== STATE_VERSION) return empty;
		s.fixes ??= [];
		s.limits ??= {};
		if (!s.fixes.includes(FIX_CLAUDE_OUTPUT)) {
			// Older versions kept the first log line of a Claude message, whose output count can be
			// partial. Re-read the Claude logs once so later lines add what was missed.
			s.fixes.push(FIX_CLAUDE_OUTPUT);
			s.rescan = ['claude'];
		}
		if (!s.fixes.includes(FIX_LIMITS)) {
			s.fixes.push(FIX_LIMITS);
			s.rescan = [...new Set([...(s.rescan ?? []), 'claude', 'codex'])];
		}
		return s;
	} catch {
		return empty;
	}
}

/** @param {State} state */
async function saveState(state) {
	await mkdir(CACHE_DIR, { recursive: true });
	const tmp = `${STATE_PATH}.${process.pid}.tmp`;
	await writeFile(tmp, JSON.stringify(state));
	await rename(tmp, STATE_PATH);
}

const shortHash = (s) => createHash('sha256').update(s).digest('base64url').slice(0, 16);

// Bucket key: hour start (ms) | provider | model | pricing tier (prompt-size threshold, 0 = base).
const bucketKey = (hourMs, provider, model, tier) => `${hourMs}|${provider}|${model}|${tier}`;

/**
 * @param {State} state
 * @param {{ ts: number, provider: string, model: string, tier: number, session: string, input: number, cacheRead: number, cacheWrite5m: number, cacheWrite1h: number, output: number }} r
 */
function addRecord(state, r) {
	const hourMs = Math.floor(r.ts / HOUR_MS) * HOUR_MS;
	const key = bucketKey(hourMs, r.provider, r.model, r.tier);
	const b = (state.buckets[key] ??= {
		input: 0,
		cacheRead: 0,
		cacheWrite5m: 0,
		cacheWrite1h: 0,
		output: 0,
		sessions: []
	});
	b.input += r.input;
	b.cacheRead += r.cacheRead;
	b.cacheWrite5m += r.cacheWrite5m;
	b.cacheWrite1h += r.cacheWrite1h;
	b.output += r.output;
	if (!b.sessions.includes(r.session)) b.sessions.push(r.session);
}

/** @param {State} state @param {number} cutoffMs */
function pruneState(state, cutoffMs) {
	for (const key of Object.keys(state.buckets)) {
		if (Number(key.split('|')[0]) < cutoffMs) delete state.buckets[key];
	}
	for (const [key, v] of Object.entries(state.seen)) {
		if ((Array.isArray(v) ? v[0] : v) < cutoffMs) delete state.seen[key];
	}
	for (const [key, w] of Object.entries(state.limits ?? {})) {
		if (Date.parse(w.resetsAt) < cutoffMs) delete state.limits[key];
	}
}

// Same rule as mergeLimits in src/limits.ts (this file ships alone, so it cannot import it): one
// record per window instance, highest peak, earliest hit. Reports of one window can put its reset
// seconds apart, across a minute boundary, so a reset within RESET_SLACK_MS of a known one of the
// same window is that one, and the record keeps the earlier reset.
const MINUTE_MS = 60_000;
const RESET_SLACK_MS = 2 * MINUTE_MS;
// Times outside this range are malformed (milliseconds read as seconds, say) and are skipped,
// never thrown, so a bad limit line cannot stop the usage on the lines after it.
const LIMIT_TIMES_FROM = Date.parse('2020-01-01T00:00:00Z');
const LIMIT_TIMES_TO = Date.parse('2100-01-01T00:00:00Z');
const plausibleTime = (ms) => ms >= LIMIT_TIMES_FROM && ms < LIMIT_TIMES_TO;

/**
 * @param {State} state
 * @param {{ provider: string, window: string, resetsAtMs: number, percent: number, hitMs?: number }} w
 */
function addLimit(state, w) {
	let resetsAtMs = Math.floor(w.resetsAtMs / MINUTE_MS) * MINUTE_MS;
	if (!plausibleTime(resetsAtMs) || !/^[a-z0-9_]{1,40}$/.test(w.window)) return;
	if (w.hitMs !== undefined && !plausibleTime(w.hitMs)) return;
	state.limits ??= {};
	let prev;
	for (const [key, l] of Object.entries(state.limits)) {
		const gap = Math.abs(Date.parse(l.resetsAt) - resetsAtMs);
		if (l.provider !== w.provider || l.window !== w.window || gap > RESET_SLACK_MS) continue;
		if (prev && gap >= Math.abs(Date.parse(prev[1].resetsAt) - resetsAtMs)) continue;
		prev = [key, l];
	}
	if (prev) {
		delete state.limits[prev[0]];
		resetsAtMs = Math.min(resetsAtMs, Date.parse(prev[1].resetsAt));
	}
	const hits = [prev?.[1].hitAt && Date.parse(prev[1].hitAt), w.hitMs].filter(Number.isFinite);
	const percent = Math.min(100, Math.max(0, w.percent));
	state.limits[`${w.provider}|${w.window}|${resetsAtMs}`] = {
		provider: w.provider,
		window: w.window,
		resetsAt: new Date(resetsAtMs).toISOString(),
		peakPercent: Math.max(prev?.[1].peakPercent ?? 0, percent),
		...(hits.length ? { hitAt: new Date(Math.min(...hits)).toISOString() } : {})
	};
}

// Claude Code logs a refused request as a synthetic assistant line carrying quotaLimits.
// One blocked window repeats on every retry; the key makes the repeats one record.
function claudeLimit(state, o) {
	const q = o.quotaLimits;
	if (q?.status !== 'rejected' || typeof q.rateLimitType !== 'string') return;
	const ts = Date.parse(o.timestamp);
	if (!Number.isFinite(ts) || !(q.resetsAt > 0)) return;
	addLimit(state, {
		provider: 'claude',
		window: q.rateLimitType
			.toLowerCase()
			.replace(/[^a-z0-9_]/g, '_')
			.slice(0, 40),
		resetsAtMs: q.resetsAt * 1000,
		percent: 100,
		hitMs: ts
	});
}

const CODEX_WINDOW_NAMES = { 300: 'five_hour', 10080: 'seven_day' };

// Codex token_count lines carry the account's rate limits; a window is null until it is in use.
function codexLimits(state, o, rateLimits) {
	const ts = Date.parse(o.timestamp);
	if (!Number.isFinite(ts) || !rateLimits) return;
	for (const slot of ['primary', 'secondary']) {
		const w = rateLimits[slot];
		if (!w || typeof w.used_percent !== 'number') continue;
		const minutes = Number(w.window_minutes);
		const window = CODEX_WINDOW_NAMES[minutes] ?? `${minutes}m`;
		const resetsAtMs =
			typeof w.resets_at === 'number'
				? w.resets_at * 1000
				: typeof w.resets_in_seconds === 'number'
					? ts + w.resets_in_seconds * 1000
					: NaN;
		const hit = w.used_percent >= 100;
		addLimit(state, {
			provider: 'codex',
			window,
			resetsAtMs,
			percent: hit ? 100 : w.used_percent,
			...(hit ? { hitMs: ts } : {})
		});
	}
}

// ---------------------------------------------------------------------------
// Pricing

async function loadPricing() {
	let cached = null;
	try {
		cached = JSON.parse(await readFile(PRICING_PATH, 'utf8'));
	} catch {
		/* no cache yet */
	}
	if (cached && Date.now() - cached.fetchedAt < PRICING_TTL_MS) return cached;
	try {
		const res = await fetch(PRICING_URL, { signal: AbortSignal.timeout(30_000) });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const models = await res.json();
		const fresh = { fetchedAt: Date.now(), models };
		await mkdir(CACHE_DIR, { recursive: true });
		await writeFile(PRICING_PATH, JSON.stringify(fresh));
		return fresh;
	} catch (err) {
		if (cached) {
			log(`pricing fetch failed (${err.message}); using cached copy`);
			return cached;
		}
		throw new Error(`could not load LiteLLM pricing: ${err.message}`, { cause: err });
	}
}

const litellmKeys = (prefix) => (model) =>
	[model, model.replace(/-\d{8}$/, ''), model.replace(/@.*$/, '')].flatMap((base) => [
		base,
		`${prefix}/${base}`
	]);

function makePriceResolver(models) {
	const memo = new Map();
	const warned = new Set();
	const usable = (e) => e && typeof e.input_cost_per_token === 'number';
	return (provider, model) => {
		const memoKey = `${provider}|${model}`;
		if (memo.has(memoKey)) return memo.get(memoKey);
		const key = SOURCES[provider]?.priceKeys(model).find((k) => usable(models[k]));
		const entry = key ? models[key] : null;
		if (!entry && !warned.has(memoKey)) {
			warned.add(memoKey);
			log(`warning: no LiteLLM price for ${provider} model "${model}"; counting its cost as 0`);
		}
		memo.set(memoKey, entry);
		return entry;
	};
}

/** Prompt-size thresholds (in tokens) at which a model's price changes. */
function tierThresholds(entry) {
	if (!entry) return [];
	const out = [];
	for (const key of Object.keys(entry)) {
		const m = /^input_cost_per_token_above_(\d+)k_tokens$/.exec(key);
		if (m) out.push(Number(m[1]) * 1000);
	}
	return out.sort((a, b) => b - a);
}

function tierFor(entry, promptTokens) {
	for (const t of tierThresholds(entry)) if (promptTokens > t) return t;
	return 0;
}

function price(entry, base, tier) {
	if (!entry) return 0;
	if (tier) {
		const v = entry[`${base}_above_${tier / 1000}k_tokens`];
		if (typeof v === 'number') return v;
	}
	const v = entry[base];
	return typeof v === 'number' ? v : undefined;
}

/** Cost breakdown in USD for a bucket's tokens. @returns {Cost} */
function costOf(entry, tier, t) {
	if (!entry) return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, savings: 0 };
	const inP = price(entry, 'input_cost_per_token', tier) ?? 0;
	const outP = price(entry, 'output_cost_per_token', tier) ?? 0;
	const readP = price(entry, 'cache_read_input_token_cost', tier) ?? inP * 0.1;
	const write5mP = price(entry, 'cache_creation_input_token_cost', tier) ?? inP * 1.25;
	const write1hP = tier
		? (entry[`cache_creation_input_token_cost_above_1hr_above_${tier / 1000}k_tokens`] ??
			entry.cache_creation_input_token_cost_above_1hr ??
			inP * 2)
		: (entry.cache_creation_input_token_cost_above_1hr ?? inP * 2);
	return {
		input: t.input * inP,
		cacheRead: t.cacheRead * readP,
		cacheWrite: t.cacheWrite5m * write5mP + t.cacheWrite1h * write1hP,
		output: t.output * outP,
		savings: t.cacheRead * Math.max(0, inP - readP)
	};
}

// ---------------------------------------------------------------------------
// Log discovery + incremental reading

async function* walk(dir) {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		const p = join(dir, e.name);
		if (e.isDirectory()) yield* walk(p);
		else if (e.isFile() && e.name.endsWith('.jsonl')) yield p;
	}
}

/**
 * Streams complete lines from `offset`. Returns the byte offset just past the
 * last complete line, so a half-written trailing line is re-read next run.
 */
async function readLinesFrom(path, offset, onLine) {
	let pos = offset;
	let pending = Buffer.alloc(0);
	for await (const chunk of createReadStream(path, { start: offset })) {
		let buf = pending.length ? Buffer.concat([pending, chunk]) : chunk;
		let start = 0;
		let nl;
		while ((nl = buf.indexOf(10, start)) !== -1) {
			const line = buf.subarray(start, nl).toString('utf8');
			pos += nl - start + 1;
			start = nl + 1;
			if (line.length > 1) onLine(line);
		}
		pending = buf.subarray(start);
	}
	return pos;
}

function parseJson(line) {
	try {
		return JSON.parse(line);
	} catch {
		return null;
	}
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

// Claude Code: one assistant line per content block; the same API response is
// repeated, so de-duplicate by message.id + requestId (also across files, since
// resumed sessions copy earlier history). Some versions log a message's first
// line with a partial output count and a later line with the final one, so a
// repeat that reports more output adds the difference to the first line's hour.
function claudeLineHandler(state, resolvePrice, cutoffMs) {
	return (line) => {
		if (!line.includes('"assistant"')) return;
		const o = parseJson(line);
		if (!o || o.type !== 'assistant') return;
		if (o.quotaLimits) claudeLimit(state, o);
		const msg = o.message;
		const usage = msg?.usage;
		const model = msg?.model;
		if (!usage || !model || model === '<synthetic>') return;
		const ts = Date.parse(o.timestamp);
		if (!Number.isFinite(ts) || ts < cutoffMs) return;
		const dedupe = `c:${shortHash(`${msg.id ?? ''}:${o.requestId ?? ''}`)}`;
		if (!msg.id && !o.requestId) return;

		const input = num(usage.input_tokens);
		const cacheRead = num(usage.cache_read_input_tokens);
		const cc = usage.cache_creation;
		let cacheWrite5m = num(cc?.ephemeral_5m_input_tokens);
		const cacheWrite1h = num(cc?.ephemeral_1h_input_tokens);
		const ccTotal = num(usage.cache_creation_input_tokens);
		// Older logs only have the total; treat it as 5-minute writes.
		if (cacheWrite5m + cacheWrite1h < ccTotal) cacheWrite5m = ccTotal - cacheWrite1h;
		const output = num(usage.output_tokens);
		const tier = tierFor(
			resolvePrice('claude', model),
			input + cacheRead + cacheWrite5m + cacheWrite1h
		);
		const session = shortHash(`claude:${o.sessionId ?? 'unknown'}`);

		const prev = state.seen[dedupe];
		if (prev !== undefined) {
			const [firstTs, counted] = Array.isArray(prev) ? prev : [prev, undefined];
			// Unknown (counted by an older version, which kept the first line it read): the first line
			// read again is what it counted.
			if (counted === undefined) state.seen[dedupe] = [firstTs, output];
			else if (output > counted) {
				state.seen[dedupe] = [firstTs, output];
				addRecord(state, {
					ts: firstTs,
					provider: 'claude',
					model,
					tier,
					session,
					input: 0,
					cacheRead: 0,
					cacheWrite5m: 0,
					cacheWrite1h: 0,
					output: output - counted
				});
			}
			return;
		}
		state.seen[dedupe] = [ts, output];
		addRecord(state, {
			ts,
			provider: 'claude',
			model,
			tier,
			session,
			input,
			cacheRead,
			cacheWrite5m,
			cacheWrite1h,
			output
		});
	};
}

// Codex: token_count events carry per-request usage in info.last_token_usage.
// input_tokens includes cached_input_tokens. output_tokens includes reasoning.
function codexLineHandler(state, fileState, resolvePrice, cutoffMs, fallbackSession) {
	return (line) => {
		const o = parseJson(line);
		if (!o) return;
		const p = o.payload;
		if (o.type === 'session_meta' && p?.id) {
			fileState.sessionId = String(p.id);
			return;
		}
		if (o.type === 'turn_context' && typeof p?.model === 'string') {
			fileState.model = p.model;
			return;
		}
		if (o.type !== 'event_msg' || p?.type !== 'token_count') return;
		codexLimits(state, o, p.rate_limits);
		if (!p.info) return;
		const total = p.info.total_token_usage?.total_tokens;
		if (typeof total === 'number') {
			if (total === fileState.lastTotal) return;
			fileState.lastTotal = total;
		}
		const last = p.info.last_token_usage;
		if (!last) return;
		const ts = Date.parse(o.timestamp);
		if (!Number.isFinite(ts) || ts < cutoffMs) return;
		const session = fileState.sessionId ?? fallbackSession;
		const dedupe = `x:${shortHash(`${session}:${total}:${o.timestamp}`)}`;
		if (state.seen[dedupe] !== undefined) return;
		state.seen[dedupe] = ts;

		const model = fileState.model ?? 'unknown';
		const inputAll = num(last.input_tokens);
		const cached = Math.min(num(last.cached_input_tokens), inputAll);
		const entry = resolvePrice('codex', model);
		addRecord(state, {
			ts,
			provider: 'codex',
			model,
			tier: tierFor(entry, inputAll),
			session: shortHash(`codex:${session}`),
			input: inputAll - cached,
			cacheRead: cached,
			cacheWrite5m: num(last.cache_write_input_tokens),
			cacheWrite1h: 0,
			output: num(last.output_tokens)
		});
	};
}

const expandHome = (p) => (p === '~' || p.startsWith('~/') ? join(HOME, p.slice(1)) : p);

// pi's own env vars, then ccusage's PI_AGENT_DIR (a comma-separated list of sessions dirs).
const piEnvPaths = () => [
	...(process.env.PI_CODING_AGENT_DIR
		? [join(expandHome(process.env.PI_CODING_AGENT_DIR), 'sessions')]
		: []),
	...(process.env.PI_CODING_AGENT_SESSION_DIR
		? [expandHome(process.env.PI_CODING_AGENT_SESSION_DIR)]
		: []),
	...(process.env.PI_AGENT_DIR ?? '')
		.split(',')
		.map((p) => p.trim())
		.filter(Boolean)
];
const piPaths = () => [join(HOME, '.pi', 'agent', 'sessions'), ...piEnvPaths()];

// The pi-subagents extension writes debug copies of calls that a session file already has.
const isSubagentCopy = (path) => path.split(sep).includes('subagent-artifacts');

// pi's input excludes cached tokens and its output includes reasoning.
function piUsage(o) {
	const msg = o.message;
	if ((o.type !== undefined && o.type !== 'message') || msg?.role !== 'assistant') return null;
	const u = msg.usage;
	if (!u) return null;
	const ts = Date.parse(o.timestamp);
	if (!Number.isFinite(ts)) return null;
	// Token counts are integers; ccusage reads anything else as 0, and the schema rejects it.
	const count = (v) => (Number.isInteger(v) ? num(v) : 0);
	const input = count(u.input);
	const cacheRead = count(u.cacheRead);
	const cacheWrite = count(u.cacheWrite);
	// pi reports the part of cacheWrite written with 1-hour retention (Anthropic only).
	const cacheWrite1h = Math.min(count(u.cacheWrite1h), cacheWrite);
	let output = count(u.output);
	const parts = input + output + cacheRead + cacheWrite;
	const total = Math.max(parts, count(u.totalTokens));
	if (total === 0) return null;
	// When output is 0, tokens the total has beyond the parts count as output, as ccusage does.
	if (output === 0) output = total - parts;
	const model = typeof msg.model === 'string' && msg.model ? msg.model : 'unknown';
	const fingerprint = [
		ts,
		model,
		input,
		output,
		cacheRead,
		cacheWrite,
		total,
		num(u.cost?.total)
	].join('|');
	return { ts, model, input, output, cacheRead, cacheWrite, cacheWrite1h, fingerprint };
}

function piCallsIn(path, untilMs) {
	const calls = [];
	let text;
	try {
		text = readFileSync(path, 'utf8');
	} catch {
		return calls;
	}
	for (const line of text.split('\n')) {
		if (!line.includes('"usage"')) continue;
		const o = parseJson(line);
		const u = o && piUsage(o);
		if (u && u.ts <= untilMs) calls.push(shortHash(u.fingerprint));
	}
	return calls;
}

// LiteLLM's prefixes for the providers pi talks to.
const PI_PRICE_PREFIXES = [
	'anthropic',
	'openai',
	'gemini',
	'openrouter',
	'xai',
	'groq',
	'cerebras',
	'mistral',
	'deepseek',
	'fireworks_ai',
	'together_ai',
	'zai',
	'moonshot',
	'minimax'
];

// Local models can have a file path as their id; only the file name leaves the machine.
const piModel = (model) => {
	const isPath =
		/^([/~.]|[A-Za-z]:)|\\|:\/|\/\//.test(model) ||
		/\.(gguf|ggml|bin|safetensors|pth?|onnx)$/i.test(model);
	const name = isPath ? (model.split(/[/\\]/).filter(Boolean).at(-1) ?? 'unknown') : model;
	return name.replace(/[^A-Za-z0-9._:/@-]/g, '-').slice(0, 100);
};

// A pi fork starts with a copy of its parent's calls up to the fork point. They are matched
// against every call in the parent up to then, not only its current branch, so the result does
// not depend on where the parent's leaf was when the fork was read.
function piLineHandler(state, file, path, resolvePrice, cutoffMs) {
	if (isSubagentCopy(path)) return () => {};
	/** @type {Set<string> | undefined} */
	let parentCalls;
	return (line) => {
		if (!line.includes('"usage"') && !line.includes('"session"')) return;
		const o = parseJson(line);
		if (!o) return;
		if (o.type === 'session') {
			if (typeof o.id === 'string' && o.id) file.sessionId = o.id;
			const forkMs = Date.parse(o.timestamp);
			if (typeof o.parentSession !== 'string' || !o.parentSession || !Number.isFinite(forkMs)) {
				return;
			}
			const parent = resolve(dirname(path), o.parentSession);
			const inStore = piPaths().some((root) => parent.startsWith(resolve(root) + sep));
			if (parent === path || !inStore || isSubagentCopy(parent)) return;
			// Kept in state, so a fork read across runs still matches if the parent changes or goes.
			const calls = piCallsIn(parent, forkMs);
			if (calls.length) file.forkCalls = calls;
			return;
		}
		const u = piUsage(o);
		if (!u) return;
		const session = file.sessionId ?? path;
		// No entry ids in the key: pi rewrites a file in place when it migrates an older version.
		const dedupe = `p:${shortHash(`${session}:${u.fingerprint}`)}`;
		if (file.forkCalls) {
			parentCalls ??= new Set(file.forkCalls);
			if (parentCalls.has(shortHash(u.fingerprint))) {
				// Seen, so a re-read after the fork is rewritten still skips it.
				state.seen[dedupe] = u.ts;
				return;
			}
			delete file.forkCalls;
		}
		if (u.ts < cutoffMs) return;
		if (state.seen[dedupe] !== undefined) return;
		state.seen[dedupe] = u.ts;
		const model = piModel(u.model);
		addRecord(state, {
			ts: u.ts,
			provider: 'pi',
			model,
			tier: tierFor(resolvePrice('pi', model), u.input + u.cacheRead + u.cacheWrite),
			session: shortHash(`pi:${session}`),
			input: u.input,
			cacheRead: u.cacheRead,
			cacheWrite5m: u.cacheWrite - u.cacheWrite1h,
			cacheWrite1h: u.cacheWrite1h,
			output: u.output
		});
	};
}

/**
 * A reader for JSONL logs that only grow: walks `*.jsonl` under each path and parses only the
 * bytes added since the last run. `lines` builds the line handler for one file.
 * @param {(ctx: ReadContext, file: FileState, path: string) => (line: string) => void} lines
 */
const jsonlReader = (lines) => async (paths, ctx, provider) => {
	const { state } = ctx;
	for (const dir of paths) {
		if (!existsSync(dir)) continue;
		for await (const path of walk(dir)) {
			if (ctx.seenPaths.has(path)) continue;
			ctx.seenPaths.add(path);
			let st;
			try {
				st = await stat(path);
			} catch {
				continue;
			}
			// Untouched for longer than the window: nothing in it can count.
			if (st.mtimeMs < ctx.cutoffMs) {
				delete state.files[path];
				continue;
			}
			const prev = state.rescan?.includes(provider) ? undefined : state.files[path];
			if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) continue;
			// File shrank (rewritten/truncated): start over. Dedupe keys stop double counting.
			/** @type {FileState} */
			const fs = prev && st.size >= prev.offset ? { ...prev } : { size: 0, mtimeMs: 0, offset: 0 };
			const start = fs.offset;
			try {
				fs.offset = await readLinesFrom(path, start, lines(ctx, fs, path));
			} catch (err) {
				log(`skipping unreadable file: ${err.message}`);
				continue;
			}
			ctx.parsedBytes += fs.offset - start;
			ctx.filesRead++;
			fs.size = st.size;
			fs.mtimeMs = st.mtimeMs;
			state.files[path] = fs;
		}
	}
};

/** @type {Promise<any> | undefined} */
let sqlite;

/**
 * Opens a SQLite file read-only, or returns null when this runtime has no `node:sqlite` (Node
 * 22.13+, or 22.5+ with --experimental-sqlite). Imported on first use, never at the top level,
 * so the other sources still run on Node 20; the warning is logged once per run.
 */
async function openSqlite(path) {
	sqlite ??= import('node:sqlite').catch(() => {
		log('warning: this runtime has no node:sqlite (Node 22.13 or newer); skipping SQLite sources');
		return null;
	});
	const mod = await sqlite;
	return mod && new mod.DatabaseSync(path, { readOnly: true });
}

const fromEnv = (name, ...rest) => (process.env[name] ? [join(process.env[name], ...rest)] : []);

/**
 * @typedef {{ state: State, resolvePrice: (provider: string, model: string) => any, cutoffMs: number, seenPaths: Set<string>, filesRead: number, parsedBytes: number }} ReadContext
 * @typedef {{
 *   paths: string[],
 *   envPaths: () => string[],
 *   read: (paths: string[], ctx: ReadContext, provider: string) => Promise<void>,
 *   priceKeys: (model: string) => string[]
 * }} Source
 */

/**
 * Every agent the collector reads, keyed by the provider id its rows carry. Each id must also be
 * in PROVIDERS in src/schema.ts, or the server rejects the snapshot.
 *
 * - `paths`: where its data lives by default.
 * - `envPaths`: where env-var overrides point. Called after the env file is loaded.
 * - `read`: adds the usage under the paths it is given with addRecord. scan calls it with
 *   `paths`, and once every source has read those, with `envPaths`, so a file two sources reach
 *   goes to the one it is a default of. `jsonlReader` reads append-only JSONL by byte offset.
 *   Any other reader (a SQLite file through openSqlite, a JSON file rewritten in place) reads its
 *   data whole on every run and skips what it counted before through `state.seen`, keyed with a
 *   provider prefix and valued with the record's timestamp so pruneState can drop it.
 * - `priceKeys`: the LiteLLM keys to try for a model, in order.
 *
 * @type {Record<string, Source>}
 */
const SOURCES = {
	claude: {
		paths: [join(HOME, '.claude', 'projects'), join(HOME, '.config', 'claude', 'projects')],
		envPaths: () => fromEnv('CLAUDE_CONFIG_DIR', 'projects'),
		read: jsonlReader((ctx) => claudeLineHandler(ctx.state, ctx.resolvePrice, ctx.cutoffMs)),
		priceKeys: litellmKeys('anthropic')
	},
	codex: {
		paths: [join(HOME, '.codex', 'sessions')],
		envPaths: () => fromEnv('CODEX_HOME', 'sessions'),
		read: jsonlReader((ctx, file, path) =>
			codexLineHandler(
				ctx.state,
				file,
				ctx.resolvePrice,
				ctx.cutoffMs,
				path.match(/([0-9a-f-]{36})\.jsonl$/)?.[1] ?? path
			)
		),
		priceKeys: litellmKeys('openai')
	},
	pi: {
		paths: [join(HOME, '.pi', 'agent', 'sessions')],
		envPaths: piEnvPaths,
		read: jsonlReader((ctx, file, path) =>
			piLineHandler(ctx.state, file, path, ctx.resolvePrice, ctx.cutoffMs)
		),
		// pi logs each backend's own model id. OpenRouter's carry a vendor and dotted versions
		// (`anthropic/claude-sonnet-4.5`) that LiteLLM may only know as `claude-sonnet-4-5`.
		priceKeys: (model) => {
			const bare = model.replace(/^[^/]+\//, '');
			return [
				...new Set(
					[model, bare, bare.replace(/(\d)\.(\d)/g, '$1-$2')].flatMap((m) =>
						PI_PRICE_PREFIXES.flatMap((p) => litellmKeys(p)(m))
					)
				)
			];
		}
	}
};

async function scan(state, resolvePrice, cutoffMs) {
	/** @type {ReadContext} */
	const ctx = { state, resolvePrice, cutoffMs, seenPaths: new Set(), filesRead: 0, parsedBytes: 0 };
	const sources = Object.entries(SOURCES);
	for (const [provider, source] of sources) await source.read(source.paths, ctx, provider);
	for (const [provider, source] of sources) await source.read(source.envPaths(), ctx, provider);
	for (const path of Object.keys(state.files)) {
		if (!ctx.seenPaths.has(path)) delete state.files[path];
	}
	delete state.rescan;
	log(
		`read ${ctx.filesRead} changed file(s), ${(ctx.parsedBytes / 1e6).toFixed(1)} MB of new log data`
	);
}

// ---------------------------------------------------------------------------
// Snapshot

const round = (n, d = 6) => Math.round(n * 10 ** d) / 10 ** d;

/**
 * @param {Record<string, Bucket>} buckets
 * @param {(b: Bucket, provider: string, model: string, tier: number) => Cost} costFor
 * @param {{ deviceId: string, pricingSource: string, providers: string[], nowMs: number, coverageStartMs: number, limits?: Record<string, Limit> }} meta
 *   `providers` names the session counts the snapshot carries.
 */
function buildSnapshot(
	buckets,
	costFor,
	{ deviceId, pricingSource, providers, nowMs, coverageStartMs, limits: windows = {} }
) {
	const hourlyCutoff = Math.floor((nowMs - HOURLY_DAYS * DAY_MS) / DAY_MS) * DAY_MS;
	/** @type {Map<string, any>} */
	const rows = new Map();
	for (const [key, b] of Object.entries(buckets)) {
		const [hourStr, provider, model, tierStr] = key.split('|');
		const hourMs = Number(hourStr);
		if (hourMs < coverageStartMs) continue;
		const daily = hourMs < hourlyCutoff;
		const start = daily ? Math.floor(hourMs / DAY_MS) * DAY_MS : hourMs;
		const rowKey = `${start}|${daily ? 'd' : 'h'}|${provider}|${model}`;
		const c = costFor(b, provider, model, Number(tierStr));
		let row = rows.get(rowKey);
		if (!row) {
			row = {
				hour: new Date(start).toISOString(),
				...(daily ? { granularity: 'day' } : {}),
				provider,
				model,
				sessionSet: new Set(),
				inputTokens: 0,
				cacheReadTokens: 0,
				cacheWrite5mTokens: 0,
				cacheWrite1hTokens: 0,
				outputTokens: 0,
				costUsd: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
				cacheSavingsUsd: 0
			};
			rows.set(rowKey, row);
		}
		for (const s of b.sessions) row.sessionSet.add(s);
		row.inputTokens += b.input;
		row.cacheReadTokens += b.cacheRead;
		row.cacheWrite5mTokens += b.cacheWrite5m;
		row.cacheWrite1hTokens += b.cacheWrite1h;
		row.outputTokens += b.output;
		row.costUsd.input += c.input;
		row.costUsd.cacheRead += c.cacheRead;
		row.costUsd.cacheWrite += c.cacheWrite;
		row.costUsd.output += c.output;
		row.cacheSavingsUsd += c.savings;
	}

	const hourly = [...rows.values()]
		.sort((a, b) => a.hour.localeCompare(b.hour) || a.model.localeCompare(b.model))
		.map(({ sessionSet, costUsd, cacheSavingsUsd, ...row }) => ({
			hour: row.hour,
			...(row.granularity ? { granularity: row.granularity } : {}),
			provider: row.provider,
			model: row.model,
			sessions: sessionSet.size,
			inputTokens: row.inputTokens,
			cacheReadTokens: row.cacheReadTokens,
			cacheWrite5mTokens: row.cacheWrite5mTokens,
			cacheWrite1hTokens: row.cacheWrite1hTokens,
			outputTokens: row.outputTokens,
			costUsd: {
				input: round(costUsd.input),
				cacheRead: round(costUsd.cacheRead),
				cacheWrite: round(costUsd.cacheWrite),
				output: round(costUsd.output)
			},
			cacheSavingsUsd: round(cacheSavingsUsd)
		}));

	// Distinct sessions per range, per provider. Session ids never leave the machine.
	const ranges = { '24h': DAY_MS, '7d': 7 * DAY_MS, '30d': 30 * DAY_MS, '90d': 90 * DAY_MS };
	const currentHour = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
	const sessionCounts = {};
	const all = new Set();
	for (const [name, span] of Object.entries(ranges)) {
		const from = currentHour + HOUR_MS - span;
		const sets = Object.fromEntries(providers.map((p) => [p, new Set()]));
		for (const [key, b] of Object.entries(buckets)) {
			const [hourStr, provider] = key.split('|');
			const h = Number(hourStr);
			if (h < from || h < coverageStartMs) continue;
			for (const s of b.sessions) sets[provider]?.add(s);
		}
		const counts = Object.fromEntries(providers.map((p) => [p, sets[p].size]));
		sessionCounts[name] = { ...counts, all: Object.values(counts).reduce((a, n) => a + n, 0) };
	}
	for (const [key, b] of Object.entries(buckets)) {
		if (Number(key.split('|')[0]) >= coverageStartMs) for (const s of b.sessions) all.add(s);
	}

	// The 24h count is only for the local --summary; published ranges are day-granular.
	const { '24h': sessions24h, ...publicCounts } = sessionCounts;
	const snapshot = {
		schemaVersion: SCHEMA_VERSION,
		deviceId,
		generatedAt: new Date(nowMs).toISOString(),
		coverageStart: new Date(coverageStartMs).toISOString(),
		pricingSource,
		hourly,
		sessionsTotal: all.size,
		sessionCounts: publicCounts
	};
	const limits = Object.values(windows)
		.filter((w) => Date.parse(w.resetsAt) >= coverageStartMs)
		.sort(
			(a, b) =>
				a.resetsAt.localeCompare(b.resetsAt) ||
				a.provider.localeCompare(b.provider) ||
				a.window.localeCompare(b.window)
		);
	if (limits.length) snapshot.limits = limits;
	return { snapshot, sessions24h };
}

// Local only (never posted), so hit times may be shown to the minute.
function limitLines(snapshot, nowMs) {
	const from = nowMs - 7 * DAY_MS;
	const hits = new Map();
	for (const w of snapshot.limits ?? []) {
		if (!w.hitAt || Date.parse(w.hitAt) < from) continue;
		const key = `${w.provider} ${w.window}`;
		hits.set(key, [...(hits.get(key) ?? []), w.hitAt.slice(0, 16).replace('T', ' ')]);
	}
	if (!hits.size) return [];
	return [
		'Limits hit, last 7 days (UTC)',
		...[...hits].map(([key, times]) => `  ${key.padEnd(24)} ${times.length}x  last ${times.at(-1)}`)
	];
}

function printSummary(snapshot, sessions24h, nowMs) {
	const from = Math.floor(nowMs / HOUR_MS) * HOUR_MS + HOUR_MS - DAY_MS;
	const byModel = new Map();
	let total = 0;
	let tokens = 0;
	let savings = 0;
	const byType = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
	for (const r of snapshot.hourly) {
		if (r.granularity === 'day' || Date.parse(r.hour) < from) continue;
		const c = r.costUsd.input + r.costUsd.cacheRead + r.costUsd.cacheWrite + r.costUsd.output;
		const t =
			r.inputTokens +
			r.cacheReadTokens +
			r.cacheWrite5mTokens +
			r.cacheWrite1hTokens +
			r.outputTokens;
		total += c;
		tokens += t;
		savings += r.cacheSavingsUsd;
		for (const k of Object.keys(byType)) byType[k] += r.costUsd[k];
		const m = byModel.get(r.model) ?? { cost: 0, tokens: 0 };
		m.cost += c;
		m.tokens += t;
		byModel.set(r.model, m);
	}
	const usd = (n) => `$${n.toFixed(2)}`;
	const lines = [
		`Past 24h on "${snapshot.deviceId || '(no device id)'}" (API-price estimate, ${snapshot.pricingSource})`,
		`  total cost      ${usd(total)}`,
		`  sessions        ${sessions24h.all}`,
		`  tokens          ${(tokens / 1e6).toFixed(2)}M`,
		`  cache savings   ${usd(savings)}`,
		`  by type         input ${usd(byType.input)} · cache read ${usd(byType.cacheRead)} · cache write ${usd(byType.cacheWrite)} · output ${usd(byType.output)}`,
		...[...byModel.entries()]
			.sort((a, b) => b[1].cost - a[1].cost)
			.map(
				([m, v]) =>
					`  ${m.padEnd(28)} ${usd(v.cost).padStart(10)}  ${(v.tokens / 1e6).toFixed(1)}M tok`
			),
		...limitLines(snapshot, nowMs),
		...(snapshot.pricingSource === 'cursor'
			? []
			: [`Compare with \`bunx ccusage claude daily\` (Claude Code only) for this device.`])
	];
	console.error(lines.join('\n'));
}

// ---------------------------------------------------------------------------
// Cursor
//
// Cursor keeps usage on its servers, per account, so it is read from Cursor's API instead of
// local logs and sent under its own device id: the same account on two machines is one history.

async function cursorRequest(path, bearer, body, headers = {}) {
	const res = await fetch(`${cursorApiUrl(process.env.BIG_SPENDER_CURSOR_API_URL)}${path}`, {
		method: 'POST',
		headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', ...headers },
		body: JSON.stringify(body),
		// Never forward the key or token to another host.
		redirect: 'error',
		signal: AbortSignal.timeout(30_000)
	});
	if (!res.ok) {
		const hint =
			res.status === 401 || res.status === 403 ? '; check BIG_SPENDER_CURSOR_API_KEY' : '';
		throw new Error(`Cursor ${path} answered HTTP ${res.status}${hint}`);
	}
	const json = await res.json().catch(() => null);
	if (!json || typeof json !== 'object' || Array.isArray(json)) {
		throw new Error(`Cursor ${path} answered with something other than a JSON object`);
	}
	return json;
}

/** Trades a Cursor user API key for the short-lived access token its dashboard RPCs accept. */
async function cursorAccessToken(apiKey) {
	const { accessToken } = await cursorRequest('/auth/exchange_user_api_key', apiKey, {});
	if (typeof accessToken !== 'string' || !accessToken) {
		throw new Error('Cursor did not return an access token for BIG_SPENDER_CURSOR_API_KEY');
	}
	assertHeaderSafe(accessToken, "Cursor's access token");
	return accessToken;
}

/**
 * Raw usage events with fromMs <= timestamp < toMs. Cursor gives events no unique id and its pages
 * can overlap, so instead of paging, a window holding more than one page is split in two.
 */
async function cursorEvents(token, fromMs, toMs) {
	const body = await cursorRequest(
		'/aiserver.v1.DashboardService/GetFilteredUsageEvents',
		token,
		{
			page: 1,
			pageSize: CURSOR_PAGE_SIZE,
			startDate: String(fromMs),
			endDate: String(toMs - 1)
		},
		{ 'connect-protocol-version': '1' }
	);
	// A failed call can still answer 200, with an error body that would read as an empty window.
	if ('error' in body || 'code' in body || 'message' in body) {
		throw new Error('Cursor answered with an error instead of usage events');
	}
	// Connect leaves out empty fields, so a window without events answers {}.
	const total = Number(body.totalUsageEventsCount ?? 0);
	const events = body.usageEventsDisplay ?? [];
	if (!Number.isSafeInteger(total) || total < 0 || !Array.isArray(events)) {
		throw new Error('Cursor answered with a usage page in an unexpected shape');
	}
	let inside;
	if (total > CURSOR_PAGE_SIZE) {
		if (toMs - fromMs < 2)
			throw new Error(`Cursor listed ${total} usage events in one millisecond`);
		const mid = fromMs + Math.floor((toMs - fromMs) / 2);
		inside = [
			...(await cursorEvents(token, fromMs, mid)),
			...(await cursorEvents(token, mid, toMs))
		];
	} else {
		inside = events.filter((e) => {
			const ts = Number(e?.timestamp);
			return ts >= fromMs && ts < toMs;
		});
	}
	// Posting a short window would replace complete days on the server with partial ones. Events
	// that arrive while the halves are read can make a split window longer, never shorter.
	if (inside.length < total || (total <= CURSOR_PAGE_SIZE && inside.length !== total)) {
		throw new Error(
			`Cursor counted ${total} usage events in a window but returned ${inside.length} inside it`
		);
	}
	return inside;
}

const cursorCount = (v) => num(typeof v === 'string' ? Number(v) : v);

/** Cursor model names are free text ("Premium (Codex 5.3)"); the server accepts only slugs. */
const cursorModel = (name) =>
	String(name ?? '')
		.toLowerCase()
		.replace(/[^a-z0-9._:@-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 100) || 'unknown';

/**
 * One usage event as tokens and Cursor's own price, or null for events without token counts:
 * Cursor billed per request before mid-2025, and some free-credit events report no tokens.
 */
function parseCursorEvent(raw) {
	const u = raw?.tokenUsage;
	if (!u || typeof u !== 'object') return null;
	const ts = Number(raw.timestamp);
	const t = {
		input: cursorCount(u.inputTokens),
		cacheRead: cursorCount(u.cacheReadTokens),
		cacheWrite: cursorCount(u.cacheWriteTokens),
		output: cursorCount(u.outputTokens)
	};
	if (!Number.isFinite(ts) || t.input + t.cacheRead + t.cacheWrite + t.output === 0) return null;
	const conversation = typeof raw.conversationId === 'string' ? raw.conversationId : '';
	return {
		ts,
		model: cursorModel(raw.model),
		session: conversation && conversation !== 'null' ? shortHash(`cursor:${conversation}`) : null,
		...t,
		usd: cursorCount(u.totalCents) / 100
	};
}

// Cursor reports one price per event. It is split over the token types in these proportions
// (typical API price ratios) so the cost-by-type breakdown has something to show; the total is
// always Cursor's.
const CURSOR_PRICE_RATIO = { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 5 };

/** @returns {Record<string, Bucket>} */
function cursorBuckets(events) {
	/** @type {Record<string, Bucket>} */
	const buckets = {};
	const w = CURSOR_PRICE_RATIO;
	for (const e of events) {
		const key = bucketKey(Math.floor(e.ts / HOUR_MS) * HOUR_MS, 'cursor', e.model, 0);
		const b = (buckets[key] ??= {
			input: 0,
			cacheRead: 0,
			cacheWrite5m: 0,
			cacheWrite1h: 0,
			output: 0,
			sessions: [],
			cost: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, savings: 0 }
		});
		b.input += e.input;
		b.cacheRead += e.cacheRead;
		b.cacheWrite5m += e.cacheWrite;
		b.output += e.output;
		if (e.session && !b.sessions.includes(e.session)) b.sessions.push(e.session);
		const unit =
			e.usd /
			(e.input * w.input +
				e.cacheRead * w.cacheRead +
				e.cacheWrite * w.cacheWrite +
				e.output * w.output);
		b.cost.input += e.input * w.input * unit;
		b.cost.cacheRead += e.cacheRead * w.cacheRead * unit;
		b.cost.cacheWrite += e.cacheWrite * w.cacheWrite * unit;
		b.cost.output += e.output * w.output * unit;
		b.cost.savings += e.cacheRead * (w.input - w.cacheRead) * unit;
	}
	return buckets;
}

/**
 * The Cursor account's snapshot. Until a backfill has been posted it covers all history;
 * after that the same 90 days as the device snapshot, since the server keeps older days.
 */
async function cursorSnapshot(apiKey, backfill, nowMs, coverageStartMs) {
	const token = await cursorAccessToken(apiKey);
	const raw = await cursorEvents(token, backfill ? CURSOR_EARLIEST_MS : coverageStartMs, nowMs + 1);
	const events = raw.map(parseCursorEvent).filter((e) => e !== null);
	let firstMs = coverageStartMs;
	for (const e of events) firstMs = Math.min(firstMs, Math.floor(e.ts / DAY_MS) * DAY_MS);
	return buildSnapshot(cursorBuckets(events), (b) => b.cost, {
		deviceId: CURSOR_DEVICE_ID,
		pricingSource: 'cursor',
		providers: ['claude', 'codex', 'cursor'],
		nowMs,
		coverageStartMs: firstMs
	});
}

// ---------------------------------------------------------------------------
// Upload

// fetch quotes the whole header in its error for some of these, which would print the secret.
function assertHeaderSafe(secret, name) {
	if (!/^[\x21-\x7e]+$/.test(secret)) {
		throw new Error(
			`${name} contains characters that are not allowed in an HTTP header; check it for spaces or a stray newline`
		);
	}
}

// The 422 a server without limit support sends: its strict schema names the key it doesn't know.
// Any other limits error is a real bug and must not silently drop the windows.
const OLD_SERVER_422 = /Unrecognized key.{0,20}limits/;

async function post(snapshot) {
	try {
		return await postOnce(snapshot);
	} catch (err) {
		if (err.status !== 422 || !snapshot.limits || !OLD_SERVER_422.test(err.message)) throw err;
		log('warning: the server is too old to store limit data; sending usage without it');
		const { limits, ...usageOnly } = snapshot;
		return await postOnce(usageOnly);
	}
}

async function postOnce(snapshot) {
	const url = setting('INGEST_URL');
	const token = setting('INGEST_TOKEN').trim();
	if (!url || !token) {
		throw new Error('BIG_SPENDER_INGEST_URL and BIG_SPENDER_INGEST_TOKEN must be set');
	}
	assertHeaderSafe(token, 'the ingest token');
	const body = gzipSync(JSON.stringify(snapshot));
	let lastErr;
	for (let attempt = 1; attempt <= POST_ATTEMPTS; attempt++) {
		try {
			const res = await fetch(url, {
				method: 'POST',
				headers: {
					authorization: `Bearer ${token}`,
					'content-type': 'application/json',
					'content-encoding': 'gzip'
				},
				body,
				signal: AbortSignal.timeout(30_000)
			});
			const reply = await res.text();
			const text = reply.slice(0, 300);
			if (res.ok) {
				log(
					`posted ${snapshot.hourly.length} rows for "${snapshot.deviceId}" (${body.length} bytes gzipped): ${text}`
				);
				return parseJson(reply)?.result;
			}
			lastErr = Object.assign(new Error(`HTTP ${res.status}: ${text}`), { status: res.status });
			// Client errors other than rate limiting won't fix themselves.
			if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
		} catch (err) {
			lastErr = err;
		}
		if (attempt < POST_ATTEMPTS) {
			const wait = 2 ** attempt * 1000;
			log(`POST failed (${lastErr.message}); retrying in ${wait / 1000}s`);
			await new Promise((r) => setTimeout(r, wait));
		}
	}
	throw lastErr;
}

// ---------------------------------------------------------------------------

async function main() {
	loadEnvFile();
	const deviceId = setting('DEVICE_ID');
	if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(deviceId)) {
		if (!(DRY_RUN || SUMMARY_ONLY)) {
			throw new Error('BIG_SPENDER_DEVICE_ID must be a lowercase slug like "laptop" or "desktop"');
		}
	}
	if (deviceId === CURSOR_DEVICE_ID) {
		throw new Error(
			`the device id "${CURSOR_DEVICE_ID}" is reserved for Cursor usage; rename this machine with big-spender install --device <id> --rename`
		);
	}
	const release = await acquireLock();
	if (!release) {
		log('another run is in progress; skipping');
		return;
	}
	try {
		const nowMs = Date.now();
		const coverageStartMs = Math.floor((nowMs - RETENTION_DAYS * DAY_MS) / DAY_MS) * DAY_MS;

		const pricing = await loadPricing();
		const resolvePrice = makePriceResolver(pricing.models);
		const state = await loadState();
		pruneState(state, coverageStartMs);
		await scan(state, resolvePrice, coverageStartMs);
		await saveState(state);

		const used = new Set(Object.keys(state.buckets).map((k) => k.split('|')[1]));
		const device = buildSnapshot(
			state.buckets,
			(b, provider, model, tier) => costOf(resolvePrice(provider, model), tier, b),
			{
				deviceId: setting('DEVICE_ID'),
				pricingSource: `litellm@${new Date(pricing.fetchedAt).toISOString().slice(0, 10)}`,
				// Older servers require the claude and codex counts and reject any other key, so another
				// provider's count is sent only once this device has used it.
				providers: Object.keys(SOURCES).filter(
					(p) => p === 'claude' || p === 'codex' || used.has(p)
				),
				nowMs,
				coverageStartMs,
				limits: state.limits
			}
		);
		if (SUMMARY_ONLY) {
			printSummary(device.snapshot, device.sessions24h, nowMs);
			return;
		}

		// A Cursor failure is held until this device's snapshot is posted, so it never blocks it.
		const cursorKey = (process.env.BIG_SPENDER_CURSOR_API_KEY ?? '').trim();
		const backfillId = shortHash(`${setting('INGEST_URL')}\n${cursorKey}`);
		const backfill = !(state.cursorBackfills ?? []).includes(backfillId);
		let cursor = null;
		let cursorError = null;
		if (cursorKey) {
			try {
				assertHeaderSafe(cursorKey, 'BIG_SPENDER_CURSOR_API_KEY');
				cursor = await cursorSnapshot(cursorKey, backfill, nowMs, coverageStartMs);
			} catch (err) {
				cursorError = new Error(`Cursor: ${err?.message ?? err}`);
			}
		}

		if (DRY_RUN) {
			for (const built of [device, cursor]) {
				if (!built) continue;
				console.log(JSON.stringify(built.snapshot, null, 2));
				printSummary(built.snapshot, built.sessions24h, nowMs);
			}
			if (cursorError) throw cursorError;
			return;
		}
		await post(device.snapshot);
		if (cursorError) throw cursorError;
		if (cursor) {
			const result = await post(cursor.snapshot);
			if (backfill && result === 'stored') {
				(state.cursorBackfills ??= []).push(backfillId);
				await saveState(state);
			} else if (result !== 'stored') {
				log(
					`warning: the server kept a newer "${CURSOR_DEVICE_ID}" snapshot (${result}); is Cursor set up on two machines?`
				);
			}
		}
	} finally {
		await release();
	}
}

main().catch((err) => {
	log(`error: ${err?.message ?? err}`);
	process.exit(1);
});
