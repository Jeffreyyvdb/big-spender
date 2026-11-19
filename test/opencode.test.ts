import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { mergeSnapshots } from '../src/history.ts';
import { usageSnapshotSchema, type UsageSnapshot } from '../src/schema.ts';
import { summarize } from '../src/summary.ts';
import { run, withSandbox } from './helpers.ts';

const COLLECTOR = fileURLToPath(new URL('../src/collector.mjs', import.meta.url));
const HOUR_MS = 3_600_000;
const PROMPT = 'please refactor the secret billing module';

const SCHEMA = `
	CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL,
		time_updated integer NOT NULL, data text NOT NULL);
	CREATE TABLE session_v2 (id text PRIMARY KEY, version text NOT NULL, directory text NOT NULL,
		fork_session_id text, fork_boundary text, time_created integer NOT NULL DEFAULT 0);
	CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL,
		seq integer NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);`;

type Tokens = {
	input: number;
	output: number;
	reasoning: number;
	cache: { read: number; write: number };
	total?: number;
};
const tokens = (input: number, output: number, reasoning = 0, read = 0, write = 0): Tokens => ({
	input,
	output,
	reasoning,
	cache: { read, write }
});

async function setup(home: string, models: Record<string, unknown>) {
	const cache = join(home, '.cache', 'big-spender');
	await mkdir(cache, { recursive: true });
	await writeFile(
		join(cache, 'litellm-prices.json'),
		JSON.stringify({ fetchedAt: Date.now(), models })
	);
	const dir = join(home, '.local', 'share', 'opencode');
	await mkdir(dir, { recursive: true });
	const db = new DatabaseSync(join(dir, 'opencode.db'));
	db.exec(SCHEMA);
	return { dir, db };
}

function v1(
	db: DatabaseSync,
	id: string,
	session: string,
	ts: number,
	model: string,
	upstream: string,
	t: Tokens
) {
	const data = {
		role: 'assistant',
		time: { created: ts },
		modelID: model,
		providerID: upstream,
		cost: 0,
		tokens: t,
		path: { cwd: '/home/someone/secret-project' }
	};
	db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run(
		id,
		session,
		ts,
		ts,
		JSON.stringify(data)
	);
}

function v2(
	db: DatabaseSync,
	id: string,
	session: string,
	seq: number,
	ts: number,
	type: string,
	extra: Record<string, unknown>,
	rowTime = ts
) {
	const data = { time: { created: ts }, content: [{ type: 'text', text: PROMPT }], ...extra };
	db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)').run(
		id,
		session,
		type,
		seq,
		rowTime,
		rowTime,
		JSON.stringify(data)
	);
}

/** A 2.x fork: OpenCode stamps it with the fork's time, and its copies keep their parent rows' times. */
function fork(db: DatabaseSync, id: string, parent: string, boundary: unknown, created: number) {
	db.prepare('INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?)').run(
		id,
		'2.3.2',
		'/home/someone',
		parent,
		JSON.stringify(boundary),
		created
	);
}

async function collect(env: Record<string, string>) {
	const res = await run(COLLECTOR, ['--dry-run'], { ...env, BIG_SPENDER_DEVICE_ID: 'laptop' });
	assert.equal(res.code, 0, res.stderr);
	return {
		snapshot: usageSnapshotSchema.parse(JSON.parse(res.stdout)),
		stdout: res.stdout,
		stderr: res.stderr
	};
}

function byModel(snapshot: UsageSnapshot) {
	const out = new Map<string, number[]>();
	for (const r of snapshot.hourly) {
		assert.equal(r.provider, 'opencode');
		const m = out.get(r.model) ?? [0, 0, 0, 0, 0];
		out.set(r.model, m);
		m[0] += r.inputTokens;
		m[1] += r.cacheReadTokens;
		m[2] += r.cacheWrite5mTokens + r.cacheWrite1hTokens;
		m[3] += r.outputTokens;
		m[4] =
			Math.round(
				(m[4] + r.costUsd.input + r.costUsd.cacheRead + r.costUsd.cacheWrite + r.costUsd.output) *
					1e6
			) / 1e6;
	}
	return Object.fromEntries(out);
}

test('OpenCode messages count once across the 1.x table, the 2.x table and legacy files', async () => {
	await withSandbox(async ({ env, home }) => {
		const { dir, db } = await setup(home, {
			'zai/glm-4.7': {
				input_cost_per_token: 1e-6,
				output_cost_per_token: 2e-6,
				cache_read_input_token_cost: 1e-7
			}
		});
		const ts = Math.floor(Date.now() / HOUR_MS) * HOUR_MS - 2 * HOUR_MS;

		// 1.2: reasoning is inside `output`, and `total` says so.
		v1(db, 'msg_a', 'ses_old', ts, 'glm-4.7', 'zai-coding-plan', {
			...tokens(100, 50, 20, 1000),
			total: 1150
		});
		v1(db, 'msg_user', 'ses_old', ts, 'glm-4.7', 'zai-coding-plan', tokens(0, 0));
		v1(
			db,
			'msg_stale',
			'ses_old',
			ts - 100 * 24 * HOUR_MS,
			'glm-4.7',
			'zai-coding-plan',
			tokens(9, 9)
		);
		// 2.x keeps a copy of every 1.x row under the same id, without `total`.
		db.prepare('INSERT INTO session_v2 (id, version, directory) VALUES (?, ?, ?)').run(
			'ses_old',
			'1.2.15',
			'/home/someone'
		);
		v2(db, 'msg_a', 'ses_old', 1, ts, 'assistant', {
			model: { id: 'glm-4.7', providerID: 'zai-coding-plan' },
			tokens: tokens(100, 50, 20, 1000)
		});
		// The same session continued in 2.x, whose `output` leaves reasoning out.
		v2(db, 'msg_c', 'ses_old', 2, ts, 'assistant', {
			model: { id: 'glm-4.7', providerID: 'zai-coding-plan' },
			tokens: tokens(10, 5, 4)
		});

		// 2.x: `output` leaves reasoning out.
		db.prepare('INSERT INTO session_v2 (id, version, directory) VALUES (?, ?, ?)').run(
			'ses_new',
			'2.3.2',
			'/home/someone'
		);
		v2(db, 'msg_b', 'ses_new', 1, ts, 'assistant', {
			model: { id: 'claude-sonnet-4.5', providerID: 'anthropic' },
			tokens: tokens(200, 100, 30, 0, 500)
		});
		v2(db, 'msg_compact', 'ses_new', 2, ts, 'compaction', {
			status: 'completed',
			model: { id: 'claude-sonnet-4.5', providerID: 'anthropic' },
			tokens: tokens(1, 2)
		});
		v2(db, 'msg_compacting', 'ses_new', 3, ts, 'compaction', {
			status: 'running',
			model: { id: 'claude-sonnet-4.5', providerID: 'anthropic' },
			tokens: tokens(7, 7)
		});
		v2(db, 'msg_agent', 'ses_new', 4, ts, 'assistant', {
			model: { id: 'opus', providerID: 'claude-agent' },
			tokens: tokens(7, 7)
		});
		v2(db, 'msg_user2', 'ses_new', 5, ts, 'user', {});
		v2(db, 'msg_local', 'ses_new', 7, ts, 'assistant', {
			model: { id: '/home/someone/models/qwen3.gguf', providerID: 'llama-cpp' },
			tokens: tokens(5, 5)
		});
		v2(db, 'msg_url', 'ses_new', 9, ts, 'assistant', {
			model: {
				id: 'file:///home/someone/models/llama.gguf?auth=sekrit#work',
				providerID: 'llama-cpp'
			},
			tokens: tokens(4, 4)
		});
		v2(db, 'msg_url1', 'ses_new', 12, ts, 'assistant', {
			model: {
				id: 'file:tiny.gguf?account=private-account#private-project',
				providerID: 'llama-cpp'
			},
			tokens: tokens(1, 1)
		});
		v2(db, 'msg_login', 'ses_new', 13, ts, 'assistant', {
			model: { id: 'https://private-login:private-key@models.example', providerID: 'remote' },
			tokens: tokens(1, 2)
		});
		v2(db, 'msg_userinfo', 'ses_new', 14, ts, 'assistant', {
			model: { id: 'private-user:private-pass@private-host', providerID: 'remote' },
			tokens: tokens(1, 0)
		});
		v2(db, 'msg_netpath', 'ses_new', 15, ts, 'assistant', {
			model: { id: '//private-net-host', providerID: 'remote' },
			tokens: tokens(1, 0)
		});
		v2(db, 'msg_netfile', 'ses_new', 16, ts, 'assistant', {
			model: {
				id: '//private-net-host/models/tiny.gguf?token=private-token',
				providerID: 'remote'
			},
			tokens: tokens(1, 0)
		});
		v2(db, 'msg_rel', 'ses_new', 10, ts, 'assistant', {
			model: { id: 'models/private-client/mistral.gguf', providerID: 'llama-cpp' },
			tokens: tokens(3, 3)
		});
		v2(db, 'msg_hash', 'ses_new', 11, ts, 'assistant', {
			model: { id: 'models/case#2026/phi.gguf', providerID: 'llama-cpp' },
			tokens: tokens(2, 2)
		});
		v2(db, 'msg_odd', 'ses_new', 8, ts, 'assistant', {
			model: { id: 'constructor', providerID: 'custom' },
			tokens: tokens(6, 6)
		});
		db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run(
			'msg_broken',
			'ses_old',
			ts,
			ts,
			'{"role":'
		);
		// A fork copies its parent's rows through msg_b under new ids, then adds its own.
		fork(db, 'ses_fork', 'ses_new', { type: 'through', messageID: 'msg_b' }, ts + 1);
		v2(db, 'msg_b_copy', 'ses_fork', 1, ts, 'assistant', {
			model: { id: 'claude-sonnet-4.5', providerID: 'anthropic' },
			tokens: tokens(200, 100, 30, 0, 500)
		});
		v2(
			db,
			'msg_f',
			'ses_fork',
			6,
			ts,
			'assistant',
			{ model: { id: 'claude-sonnet-4.5', providerID: 'anthropic' }, tokens: tokens(3, 4) },
			ts + 1
		);
		db.close();

		// Before SQLite: one JSON file per message.
		const files = join(dir, 'storage', 'message', 'ses_legacy');
		await mkdir(files, { recursive: true });
		const legacy = (id: string, t: Tokens) =>
			writeFile(
				join(files, `${id}.json`),
				JSON.stringify({
					id,
					sessionID: 'ses_legacy',
					role: 'assistant',
					modelID: 'big pickle',
					providerID: 'opencode',
					time: { created: ts },
					tokens: t
				})
			);
		await legacy('msg_a', tokens(999, 999));
		await legacy('msg_d', tokens(40, 60));

		const { snapshot, stdout } = await collect(env);
		assert.deepEqual(byModel(snapshot), {
			'glm-4.7': [110, 1000, 0, 59, 0.000328],
			'claude-sonnet-4.5': [204, 0, 500, 136, 0],
			'big-pickle': [40, 0, 0, 60, 0],
			'qwen3.gguf': [5, 0, 0, 5, 0],
			'llama.gguf': [4, 0, 0, 4, 0],
			'tiny.gguf': [2, 0, 0, 1, 0],
			local: [3, 0, 0, 2, 0],
			'mistral.gguf': [3, 0, 0, 3, 0],
			'phi.gguf': [2, 0, 0, 2, 0],
			constructor: [6, 0, 0, 6, 0]
		});
		assert.deepEqual(snapshot.sessionCounts?.['7d'], { claude: 0, codex: 0, opencode: 4, all: 4 });

		for (const secret of [
			PROMPT,
			'secret-project',
			'private-client',
			'sekrit',
			'private-account',
			'private-project',
			'private-login',
			'private-key',
			'models.example',
			'private-user',
			'private-net',
			'private-token',
			'private-pass',
			'private-host',
			'case-2026',
			'ses_old',
			'ses_new',
			'ses_legacy',
			'msg_a',
			home
		]) {
			assert.ok(!stdout.includes(secret), `snapshot leaks ${secret}`);
		}
	});
});

test('a second OpenCode run adds nothing, and a message rewritten since counts its final numbers', async () => {
	await withSandbox(async ({ env, home }) => {
		const { db } = await setup(home, {});
		const ts = Math.floor(Date.now() / HOUR_MS) * HOUR_MS - HOUR_MS;
		v1(db, 'msg_a', 'ses_1', ts, 'glm-5', 'zai', { ...tokens(100, 10, 0, 500), total: 610 });

		const first = byModel((await collect(env)).snapshot);
		assert.deepEqual(first, { 'glm-5': [100, 500, 0, 10, 0] });
		assert.deepEqual(byModel((await collect(env)).snapshot), first, 'second run');

		// OpenCode rewrites a running message with each step's usage.
		const data = {
			role: 'assistant',
			time: { created: ts },
			modelID: 'glm-5.1',
			providerID: 'zai',
			tokens: { ...tokens(80, 40, 0, 900), total: 1020 }
		};
		db.prepare('UPDATE message SET data = ? WHERE id = ?').run(JSON.stringify(data), 'msg_a');
		v1(db, 'msg_b', 'ses_1', ts, 'glm-5', 'zai', tokens(1, 1));
		db.close();
		const after = byModel((await collect(env)).snapshot);
		assert.deepEqual(after, { 'glm-5': [1, 0, 0, 1, 0], 'glm-5.1': [80, 900, 0, 40, 0] });
		assert.deepEqual(byModel((await collect(env)).snapshot), after, 'run after the rewrite');
	});
});

test('OPENCODE_DATA_DIR replaces the default OpenCode dir', async () => {
	await withSandbox(async ({ env, home }) => {
		const { db } = await setup(home, {});
		const ts = Math.floor(Date.now() / HOUR_MS) * HOUR_MS - HOUR_MS;
		v1(db, 'msg_a', 'ses_1', ts, 'glm-5', 'zai', tokens(1, 1));
		db.close();
		const other = join(home, 'other');
		await mkdir(other, { recursive: true });
		const db2 = new DatabaseSync(join(other, 'opencode-beta.db'));
		db2.exec(SCHEMA);
		v1(db2, 'msg_a', 'ses_1', ts, 'glm-5', 'zai', tokens(9, 9));
		db2.close();
		const { snapshot } = await collect({ ...env, OPENCODE_DATA_DIR: ` ${other} ,${other}/.` });
		assert.deepEqual(byModel(snapshot), { 'glm-5': [9, 0, 0, 9, 0] });
		const fresh = join(home, 'fresh');
		await mkdir(join(fresh, 'big-spender'), { recursive: true });
		await writeFile(
			join(fresh, 'big-spender', 'litellm-prices.json'),
			JSON.stringify({ fetchedAt: Date.now(), models: {} })
		);
		const blank = await collect({
			...env,
			OPENCODE_DATA_DIR: ' , ',
			XDG_CACHE_HOME: join(home, 'fresh')
		});
		assert.deepEqual(byModel(blank.snapshot), {});
	});
});

test('usage of a deleted OpenCode message keeps its price, and one rewritten to zero drops out', async () => {
	await withSandbox(async ({ env, home }) => {
		const { db } = await setup(home, {
			'zai/priced': { input_cost_per_token: 1e-4, output_cost_per_token: 0 }
		});
		const ts = Math.floor(Date.now() / HOUR_MS) * HOUR_MS - HOUR_MS;
		v1(db, 'msg_a', 'ses_1', ts, 'priced', 'zai', tokens(100, 0));
		v1(db, 'msg_b', 'ses_2', ts, 'priced', 'zai', tokens(20, 7));
		assert.deepEqual(byModel((await collect(env)).snapshot), { priced: [120, 0, 0, 7, 0.012] });

		db.prepare('DELETE FROM message WHERE id = ?').run('msg_a');
		const zero = {
			role: 'assistant',
			time: { created: ts },
			modelID: 'priced',
			providerID: 'zai',
			tokens: tokens(0, 0)
		};
		db.prepare('UPDATE message SET data = ? WHERE id = ?').run(JSON.stringify(zero), 'msg_b');
		db.close();
		for (const pass of ['first run', 'second run']) {
			assert.deepEqual(
				byModel((await collect(env)).snapshot),
				{ priced: [100, 0, 0, 0, 0.01] },
				pass
			);
		}
		const blank = await collect({ ...env, OPENCODE_DATA_DIR: ' , ' });
		assert.deepEqual(byModel(blank.snapshot), { priced: [100, 0, 0, 0, 0.01] }, 'blank override');
	});
});

test('an OpenCode database without seq, fork or time columns is still read', async () => {
	await withSandbox(async ({ env, home }) => {
		const { db } = await setup(home, {});
		db.exec(`DROP TABLE session_message; DROP TABLE session_v2; DROP TABLE message;
			CREATE TABLE session_v2 (id text PRIMARY KEY, version text NOT NULL);
			CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, data text NOT NULL);`);
		const ts = Date.now() - HOUR_MS;
		const data = {
			time: { created: ts },
			model: { id: 'gpt-4o', providerID: 'openai' },
			tokens: tokens(11, 13)
		};
		db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?)').run(
			'msg_a',
			'ses_1',
			'assistant',
			JSON.stringify(data)
		);
		db.close();
		assert.deepEqual(byModel((await collect(env)).snapshot), { 'gpt-4o': [11, 0, 0, 13, 0] });
	});
});

test('the server drops usage and sessions of an OpenCode message rewritten to another model or to zero', async () => {
	await withSandbox(async ({ env, home }) => {
		const { db } = await setup(home, {});
		const ts = Math.floor(Date.now() / HOUR_MS) * HOUR_MS - HOUR_MS;
		v1(db, 'msg_a', 'ses_1', ts, 'glm-5', 'zai', tokens(100, 0));
		v1(db, 'msg_b', 'ses_2', ts, 'gpt-4o', 'openai', tokens(30, 0));
		v1(db, 'msg_c', 'ses_3', ts, 'gpt-4o', 'openai', tokens(200, 0));
		let stored = mergeSnapshots(undefined, (await collect(env)).snapshot).snapshot;

		const rewrite = (id: string, model: string, upstream: string, t: Tokens) =>
			db.prepare('UPDATE message SET data = ? WHERE id = ?').run(
				JSON.stringify({
					role: 'assistant',
					time: { created: ts },
					modelID: model,
					providerID: upstream,
					tokens: t
				}),
				id
			);
		rewrite('msg_a', 'glm-5.1', 'zai', tokens(80, 0));
		rewrite('msg_b', 'gpt-4o', 'openai', tokens(0, 0));
		db.close();
		for (const pass of ['first run', 'second run']) {
			const { snapshot } = await collect(env);
			const zero = snapshot.hourly.filter((r) => r.model !== 'glm-5.1');
			assert.deepEqual(
				zero.map((r) => [r.model, r.granularity, r.sessions, r.inputTokens, r.outputTokens]),
				[
					['glm-5', undefined, 0, 0, 0],
					['gpt-4o', undefined, 1, 200, 0]
				],
				pass
			);
			assert.equal(snapshot.sessionCounts?.['7d'].opencode, 2, pass);
			stored = mergeSnapshots(stored, snapshot).snapshot;
			assert.deepEqual(
				stored.hourly.map((r) => [r.model, r.inputTokens]),
				[
					['glm-5.1', 80],
					['gpt-4o', 200]
				],
				`${pass}: the zero row is not stored`
			);
			const config = { devices: {}, unknownDevices: 'by-id' as const };
			const models = summarize([stored], Date.now(), config).ranges['7d'].models;
			assert.deepEqual(
				models.map((m) => [m.model, m.tokens]),
				[
					['gpt-4o', 200],
					['glm-5.1', 80]
				],
				pass
			);
		}
	});
});

test('an OpenCode fork counts only its own rows, whatever happens to its parent', async () => {
	await withSandbox(async ({ env, home }) => {
		const { db } = await setup(home, {});
		const ts = Math.floor(Date.now() / HOUR_MS) * HOUR_MS - HOUR_MS;
		const row = (id: string, session: string, seq: number, n: number, rowTime = ts) =>
			v2(
				db,
				id,
				session,
				seq,
				ts,
				'assistant',
				{ model: { id: 'gpt-4o', providerID: 'openai' }, tokens: tokens(n, 0) },
				rowTime
			);
		const run = async () => byModel((await collect(env)).snapshot)['gpt-4o']?.[0];
		db.prepare('INSERT INTO session_v2 (id, version, directory) VALUES (?, ?, ?)').run(
			'ses_parent',
			'2.3.2',
			'/x'
		);
		row('msg_a1', 'ses_parent', 1, 1);
		row('msg_a2', 'ses_parent', 2, 10);
		row('msg_b', 'ses_parent', 3, 100);
		assert.equal(await run(), 111);

		// Forked, then a copied parent row and the boundary deleted, all before the next run.
		fork(db, 'ses_before', 'ses_parent', { type: 'before', messageID: 'msg_b' }, ts + 5);
		row('msg_a1_copy', 'ses_before', 1, 1);
		row('msg_a2_copy', 'ses_before', 2, 10);
		row('msg_own', 'ses_before', 4, 1000, ts + 5);
		db.exec("DELETE FROM session_message WHERE id IN ('msg_a2', 'msg_b')");
		assert.equal(await run(), 1111);

		// The original is rewritten after its copy was made: the copy still does not count.
		db.prepare('UPDATE session_message SET data = ? WHERE id = ?').run(
			JSON.stringify({
				time: { created: ts },
				model: { id: 'gpt-4o', providerID: 'openai' },
				tokens: tokens(5, 0)
			}),
			'msg_a1'
		);
		for (const pass of ['first run', 'second run']) assert.equal(await run(), 1115, pass);

		// The whole parent session deleted.
		db.exec("DELETE FROM session_message WHERE session_id = 'ses_parent'");
		db.exec("DELETE FROM session_v2 WHERE id = 'ses_parent'");
		for (const pass of ['first run', 'second run']) assert.equal(await run(), 1115, pass);

		// A fork's own call that matches another session's call in time, model and tokens.
		fork(db, 'ses_empty', 'ses_gone', { type: 'through', messageID: 'msg_x' }, ts + 9);
		row('msg_twin1', 'ses_empty', 1, 13, ts + 9);
		row('msg_twin2', 'ses_other', 1, 13, ts + 9);
		db.close();
		const { snapshot } = await collect(env);
		assert.equal(byModel(snapshot)['gpt-4o'][0], 1141);
		assert.equal(snapshot.sessionCounts?.['7d'].opencode, 4);
	});
});
