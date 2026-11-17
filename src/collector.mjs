#!/usr/bin/env node
// big-spender collector.
//
// Reads this machine's Claude Code and Codex session logs, works out hourly
// token and cost aggregates (LiteLLM API prices), and POSTs one full snapshot
// to your big-spender server's ingest endpoint. Only numbers, model names, timestamps and the
// device id leave the machine: no paths, prompts, session ids or branches.
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
// Env: BIG_SPENDER_DEVICE_ID, BIG_SPENDER_INGEST_URL, BIG_SPENDER_INGEST_TOKEN (see templates/env.example).
// The older USAGE_* names are still read when the new one is unset.

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
 * @typedef {{ input: number, cacheRead: number, cacheWrite5m: number, cacheWrite1h: number, output: number, sessions: string[] }} Bucket
 * @typedef {{ size: number, mtimeMs: number, offset: number, model?: string, sessionId?: string, lastTotal?: number }} FileState
 * A seen entry is the first timestamp, or for Claude [first timestamp, output tokens counted].
 * A bare number on a Claude key means the counted output is unknown (state from an older version).
 * @typedef {number | [number, number]} Seen
 * @typedef {{ version: number, files: Record<string, FileState>, seen: Record<string, Seen>, buckets: Record<string, Bucket>, fixes?: string[], rescanClaude?: boolean }} State
 */

// One-time fixes to existing state. The state version stays the same so an older installed copy
// can still read the file instead of discarding it.
const FIX_CLAUDE_OUTPUT = 'claude-final-output';

/** @returns {Promise<State>} */
async function loadState() {
	const empty = {
		version: STATE_VERSION,
		files: {},
		seen: {},
		buckets: {},
		fixes: [FIX_CLAUDE_OUTPUT]
	};
	if (RESET) return empty;
	try {
		const s = JSON.parse(await readFile(STATE_PATH, 'utf8'));
		if (s?.version !== STATE_VERSION) return empty;
		s.fixes ??= [];
		if (!s.fixes.includes(FIX_CLAUDE_OUTPUT)) {
			// Older versions kept the first log line of a Claude message, whose output count can be
			// partial. Re-read the Claude logs once so later lines add what was missed.
			s.fixes.push(FIX_CLAUDE_OUTPUT);
			s.rescanClaude = true;
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

/** Builds a model -> price entry resolver over the LiteLLM document. */
function makePriceResolver(models) {
	const memo = new Map();
	const warned = new Set();
	const usable = (e) => e && typeof e.input_cost_per_token === 'number';
	return (provider, model) => {
		const memoKey = `${provider}|${model}`;
		if (memo.has(memoKey)) return memo.get(memoKey);
		const prefix = provider === 'claude' ? 'anthropic' : 'openai';
		const bases = [model, model.replace(/-\d{8}$/, ''), model.replace(/@.*$/, '')];
		let entry = null;
		for (const base of bases) {
			for (const key of [base, `${prefix}/${base}`]) {
				if (usable(models[key])) {
					entry = models[key];
					break;
				}
			}
			if (entry) break;
		}
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

/** Cost breakdown in USD for a bucket's tokens. */
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
		if (o.type !== 'event_msg' || p?.type !== 'token_count' || !p.info) return;
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

async function scan(state, resolvePrice, cutoffMs) {
	const sources = [
		{ provider: 'claude', dir: join(HOME, '.claude', 'projects') },
		{ provider: 'claude', dir: join(HOME, '.config', 'claude', 'projects') },
		{ provider: 'codex', dir: join(HOME, '.codex', 'sessions') }
	];
	if (process.env.CLAUDE_CONFIG_DIR) {
		sources.push({ provider: 'claude', dir: join(process.env.CLAUDE_CONFIG_DIR, 'projects') });
	}
	if (process.env.CODEX_HOME) {
		sources.push({ provider: 'codex', dir: join(process.env.CODEX_HOME, 'sessions') });
	}

	const seenPaths = new Set();
	let parsedBytes = 0;
	let filesRead = 0;
	for (const { provider, dir } of sources) {
		if (!existsSync(dir)) continue;
		for await (const path of walk(dir)) {
			if (seenPaths.has(path)) continue;
			seenPaths.add(path);
			let st;
			try {
				st = await stat(path);
			} catch {
				continue;
			}
			// Untouched for longer than the window: nothing in it can count.
			if (st.mtimeMs < cutoffMs) {
				delete state.files[path];
				continue;
			}
			const prev = provider === 'claude' && state.rescanClaude ? undefined : state.files[path];
			if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) continue;
			// File shrank (rewritten/truncated): start over. Dedupe keys stop double counting.
			/** @type {FileState} */
			const fs = prev && st.size >= prev.offset ? { ...prev } : { size: 0, mtimeMs: 0, offset: 0 };
			const handler =
				provider === 'claude'
					? claudeLineHandler(state, resolvePrice, cutoffMs)
					: codexLineHandler(
							state,
							fs,
							resolvePrice,
							cutoffMs,
							path.match(/([0-9a-f-]{36})\.jsonl$/)?.[1] ?? path
						);
			const start = fs.offset;
			try {
				fs.offset = await readLinesFrom(path, start, handler);
			} catch (err) {
				log(`skipping unreadable file: ${err.message}`);
				continue;
			}
			parsedBytes += fs.offset - start;
			filesRead++;
			fs.size = st.size;
			fs.mtimeMs = st.mtimeMs;
			state.files[path] = fs;
		}
	}
	for (const path of Object.keys(state.files)) {
		if (!seenPaths.has(path)) delete state.files[path];
	}
	delete state.rescanClaude;
	log(`read ${filesRead} changed file(s), ${(parsedBytes / 1e6).toFixed(1)} MB of new log data`);
}

// ---------------------------------------------------------------------------
// Snapshot

const round = (n, d = 6) => Math.round(n * 10 ** d) / 10 ** d;

function buildSnapshot(state, resolvePrice, pricing, nowMs, coverageStartMs) {
	const hourlyCutoff = Math.floor((nowMs - HOURLY_DAYS * DAY_MS) / DAY_MS) * DAY_MS;
	/** @type {Map<string, any>} */
	const rows = new Map();
	for (const [key, b] of Object.entries(state.buckets)) {
		const [hourStr, provider, model, tierStr] = key.split('|');
		const hourMs = Number(hourStr);
		if (hourMs < coverageStartMs) continue;
		const daily = hourMs < hourlyCutoff;
		const start = daily ? Math.floor(hourMs / DAY_MS) * DAY_MS : hourMs;
		const rowKey = `${start}|${daily ? 'd' : 'h'}|${provider}|${model}`;
		const c = costOf(resolvePrice(provider, model), Number(tierStr), b);
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
		const sets = { claude: new Set(), codex: new Set() };
		for (const [key, b] of Object.entries(state.buckets)) {
			const [hourStr, provider] = key.split('|');
			const h = Number(hourStr);
			if (h < from || h < coverageStartMs) continue;
			for (const s of b.sessions) sets[provider]?.add(s);
		}
		sessionCounts[name] = {
			claude: sets.claude.size,
			codex: sets.codex.size,
			all: sets.claude.size + sets.codex.size
		};
	}
	for (const [key, b] of Object.entries(state.buckets)) {
		if (Number(key.split('|')[0]) >= coverageStartMs) for (const s of b.sessions) all.add(s);
	}

	// The 24h count is only for the local --summary; published ranges are day-granular.
	const { '24h': sessions24h, ...publicCounts } = sessionCounts;
	const snapshot = {
		schemaVersion: SCHEMA_VERSION,
		deviceId: setting('DEVICE_ID'),
		generatedAt: new Date(nowMs).toISOString(),
		coverageStart: new Date(coverageStartMs).toISOString(),
		pricingSource: `litellm@${new Date(pricing.fetchedAt).toISOString().slice(0, 10)}`,
		hourly,
		sessionsTotal: all.size,
		sessionCounts: publicCounts
	};
	return { snapshot, sessions24h };
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
		`Compare with \`bunx ccusage claude daily\` (Claude Code only) for this device.`
	];
	console.error(lines.join('\n'));
}

// ---------------------------------------------------------------------------
// Upload

async function post(snapshot) {
	const url = setting('INGEST_URL');
	const token = setting('INGEST_TOKEN').trim();
	if (!url || !token) {
		throw new Error('BIG_SPENDER_INGEST_URL and BIG_SPENDER_INGEST_TOKEN must be set');
	}
	// fetch quotes the whole header in its error for some of these, which would print the token.
	if (!/^[\x21-\x7e]+$/.test(token)) {
		throw new Error(
			'the ingest token contains characters that are not allowed in an HTTP header; check it for spaces or a stray newline'
		);
	}
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
			const text = (await res.text()).slice(0, 300);
			if (res.ok) {
				log(`posted ${snapshot.hourly.length} rows (${body.length} bytes gzipped): ${text}`);
				return;
			}
			lastErr = new Error(`HTTP ${res.status}: ${text}`);
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

		const { snapshot, sessions24h } = buildSnapshot(
			state,
			resolvePrice,
			pricing,
			nowMs,
			coverageStartMs
		);
		if (DRY_RUN) console.log(JSON.stringify(snapshot, null, 2));
		if (DRY_RUN || SUMMARY_ONLY) {
			printSummary(snapshot, sessions24h, nowMs);
			return;
		}
		await post(snapshot);
	} finally {
		await release();
	}
}

main().catch((err) => {
	log(`error: ${err?.message ?? err}`);
	process.exit(1);
});
