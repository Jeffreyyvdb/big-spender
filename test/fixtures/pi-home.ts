import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DAY_MS = 86_400_000;

type UsdPerToken = { input: number; output: number; cacheRead: number; cacheWrite: number };
type Entry = Record<string, unknown>;

const PRICES: Record<string, UsdPerToken> = {
	'claude-sonnet-4-5': { input: 3e-6, output: 15e-6, cacheRead: 0.3e-6, cacheWrite: 3.75e-6 },
	'gpt-5': { input: 1.25e-6, output: 10e-6, cacheRead: 0.125e-6, cacheWrite: 0 },
	'anthropic/claude-sonnet-4.5': {
		input: 3e-6,
		output: 15e-6,
		cacheRead: 0.3e-6,
		cacheWrite: 3.75e-6
	},
	'qwen3:32b': { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
};
const PROVIDER: Record<string, string> = {
	'claude-sonnet-4-5': 'anthropic',
	'gpt-5': 'openai',
	'anthropic/claude-sonnet-4.5': 'openrouter',
	'qwen3:32b': 'ollama'
};

export const SECRETS = ['SECRET-PROMPT', 'acme-api', 'side-project', '/home/dev', 'billing.ts'];

function usage(model: string, [input, output, cacheRead, cacheWrite, cacheWrite1h = 0]: number[]) {
	const p = PRICES[model];
	const cost = {
		input: input * p.input,
		output: output * p.output,
		cacheRead: cacheRead * p.cacheRead,
		cacheWrite: (cacheWrite - cacheWrite1h) * p.cacheWrite + cacheWrite1h * p.input * 2
	};
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		...(cacheWrite1h ? { cacheWrite1h } : {}),
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { ...cost, total: cost.input + cost.output + cost.cacheRead + cost.cacheWrite }
	};
}

export function writePiHome(home: string, nowMs = Date.now()) {
	const day0 = Math.floor(nowMs / DAY_MS) * DAY_MS - 4 * DAY_MS;
	const at = (day: number, hh: number, mm: number, ss = 0) =>
		new Date(day0 + day * DAY_MS + ((hh * 60 + mm) * 60 + ss) * 1000).toISOString();
	const stamp = (iso: string) => iso.replace(/[:.]/g, '-');

	const sessions = join(home, '.pi', 'agent', 'sessions');
	const api = join(sessions, '--home-dev-acme-api--');
	const side = join(sessions, '--home-dev-side-project--');
	const files: Record<string, string> = {};
	const write = (path: string, lines: Entry[]) => {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
		files[path.slice(sessions.length + 1)] = path;
	};
	const header = (id: string, ts: string, cwd: string, extra: Entry = {}) => ({
		type: 'session',
		version: 3,
		id,
		timestamp: ts,
		cwd,
		...extra
	});
	const user = (id: string, parentId: string | null, ts: string, text: string) => ({
		type: 'message',
		id,
		parentId,
		timestamp: ts,
		message: { role: 'user', content: [{ type: 'text', text }], timestamp: Date.parse(ts) }
	});
	const assistant = (
		id: string,
		parentId: string,
		ts: string,
		model: string,
		tokens: number[],
		extra: Entry = {}
	) => ({
		type: 'message',
		id,
		parentId,
		timestamp: ts,
		message: {
			role: 'assistant',
			content: [{ type: 'text', text: 'SECRET-PROMPT answer' }],
			api: 'messages',
			provider: PROVIDER[model],
			model,
			usage: usage(model, tokens),
			stopReason: 'stop',
			timestamp: Date.parse(ts),
			...extra
		}
	});

	const rootId = '0b6f3c1e-7d2a-4c55-9a41-3e8f2d1c0a01';
	const rootStart = at(0, 9, 0);
	const rootPath = join(api, `${stamp(rootStart)}_${rootId}.jsonl`);
	const S = 'claude-sonnet-4-5';
	const e4 = assistant('e4', 'e3', at(0, 9, 0, 5), S, [3, 420, 0, 11800]);
	const e6 = assistant('e6', 'e5', at(0, 9, 0, 40), S, [5, 980, 11800, 1450]);
	const e15 = assistant('e15', 'e14', at(1, 8, 0, 15), S, [6, 310, 13250, 900]);
	const rootEntries: Entry[] = [
		header(rootId, rootStart, '/home/dev/acme-api'),
		{
			type: 'model_change',
			id: 'e1',
			parentId: null,
			timestamp: rootStart,
			provider: 'anthropic',
			modelId: S
		},
		{
			type: 'thinking_level_change',
			id: 'e2',
			parentId: 'e1',
			timestamp: rootStart,
			thinkingLevel: 'medium'
		},
		user('e3', 'e2', at(0, 9, 0, 1), 'SECRET-PROMPT refactor /home/dev/acme-api/billing.ts'),
		e4,
		{
			type: 'message',
			id: 'e5',
			parentId: 'e4',
			timestamp: at(0, 9, 0, 6),
			message: {
				role: 'toolResult',
				toolCallId: 'call_1',
				toolName: 'read',
				content: [{ type: 'text', text: 'SECRET-PROMPT file body of billing.ts' }],
				isError: false,
				timestamp: Date.parse(at(0, 9, 0, 6))
			}
		},
		e6,
		assistant('e7', 'e6', at(0, 9, 1), S, [0, 0, 0, 0], { stopReason: 'aborted' }),
		user('e8', 'e7', at(0, 23, 59, 0), 'SECRET-PROMPT keep going'),
		assistant('e9', 'e8', at(0, 23, 59, 10), S, [0, 0, 0, 0], {
			stopReason: 'error',
			errorMessage: 'overloaded_error'
		}),
		assistant('e10', 'e9', at(0, 23, 59, 30), S, [4, 760, 13250, 600]),
		{
			type: 'compaction',
			id: 'e11',
			parentId: 'e10',
			timestamp: at(1, 0, 0, 0),
			summary: 'SECRET-PROMPT summary of the billing refactor',
			firstKeptEntryId: 'e10',
			tokensBefore: 14610
		},
		user('e12', 'e11', at(1, 0, 0, 10), 'SECRET-PROMPT continue after compaction'),
		assistant('e13', 'e12', at(1, 0, 0, 20), S, [2200, 540, 0, 3100, 1000]),
		user('e14', 'e6', at(1, 8, 0, 0), 'SECRET-PROMPT try another approach'),
		e15,
		assistant('e16', 'e15', at(1, 8, 1, 0), S, [3, 120, 14150, 200])
	];
	write(rootPath, rootEntries);

	const forkId = '5c2d9e70-1b3f-4f8a-8d6e-7a9b0c1d2e02';
	const forkStart = at(1, 9, 0);
	const pathToE15 = new Set(['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e14', 'e15']);
	write(join(api, `${stamp(forkStart)}_${forkId}.jsonl`), [
		header(forkId, forkStart, '/home/dev/acme-api', { parentSession: rootPath }),
		...rootEntries.filter((e) => pathToE15.has(e.id as string)),
		user('e17', 'e15', at(1, 9, 0, 30), 'SECRET-PROMPT forked question'),
		assistant('e18', 'e17', at(1, 9, 1, 0), S, [8, 640, 14150, 1200])
	]);

	const orphanId = '9e8d7c6b-5a49-4382-a1b0-c9d8e7f6a503';
	const orphanStart = at(2, 7, 0);
	write(join(api, `${stamp(orphanStart)}_${orphanId}.jsonl`), [
		header(orphanId, orphanStart, '/home/dev/acme-api', {
			parentSession: join(api, 'deleted_0000.jsonl')
		}),
		user('o1', null, at(2, 6, 30), 'SECRET-PROMPT old question'),
		assistant('o2', 'o1', at(2, 6, 30, 9), S, [12, 300, 0, 5000]),
		user('o3', 'o2', at(2, 7, 0, 5), 'SECRET-PROMPT new question'),
		assistant('o4', 'o3', at(2, 7, 0, 20), S, [10, 220, 5000, 400])
	]);

	const sideId = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c04';
	const sideStart = at(2, 13, 0);
	write(join(side, `${stamp(sideStart)}_${sideId}.jsonl`), [
		header(sideId, sideStart, '/home/dev/side-project'),
		user('s1', null, at(2, 13, 0, 1), 'SECRET-PROMPT side question'),
		assistant('s2', 's1', at(2, 13, 0, 9), 'gpt-5', [5400, 2210, 0, 0]),
		assistant('s3', 's2', at(2, 13, 2, 0), 'gpt-5', [800, 1530, 5120, 0]),
		assistant('s4', 's3', at(2, 14, 0, 0), 'anthropic/claude-sonnet-4.5', [40, 380, 0, 7600]),
		assistant('s5', 's4', at(2, 15, 0, 0), 'qwen3:32b', [9000, 700, 0, 0])
	]);

	const legacyId = '7f6e5d4c-3b2a-4190-8f7e-6d5c4b3a2905';
	const legacyStart = at(3, 10, 0);
	const legacyCall = {
		type: 'message',
		timestamp: at(3, 10, 0, 12),
		message: {
			role: 'assistant',
			provider: 'anthropic',
			model: S,
			usage: usage(S, [30, 410, 0, 6100])
		}
	};
	write(join(side, `${stamp(legacyStart)}_${legacyId}.jsonl`), [
		{ type: 'session', id: legacyId, timestamp: legacyStart, cwd: '/home/dev/side-project' },
		{ type: 'message', timestamp: at(3, 10, 0, 1), message: { role: 'user', content: 'SECRET' } },
		legacyCall,
		legacyCall,
		{
			type: 'message',
			timestamp: at(3, 10, 5, 0),
			message: {
				role: 'assistant',
				provider: 'openai',
				model: 'gpt-5',
				usage: { totalTokens: 333 }
			}
		}
	]);

	const subDir = join(api, `${stamp(rootStart)}_${rootId}`);
	write(join(subDir, 'subagent-artifacts', 'run1_agent_0_transcript.jsonl'), [e4, e6]);
	const childId = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e06';
	write(join(subDir, 'run-abc', 'run-0', 'session.jsonl'), [
		header(childId, at(0, 9, 2), '/home/dev/acme-api'),
		user('c1', null, at(0, 9, 2, 1), 'SECRET-PROMPT subagent task'),
		assistant('c2', 'c1', at(0, 9, 2, 30), S, [1500, 820, 0, 4200])
	]);

	return { sessions, files };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const home = process.argv[2];
	if (!home) throw new Error('usage: node test/fixtures/pi-home.ts <home> [--now <ISO time>]');
	const i = process.argv.indexOf('--now');
	const nowMs = i > 0 ? Date.parse(process.argv[i + 1]) : Date.now();
	const { sessions, files } = writePiHome(home, nowMs);
	console.log(`wrote ${Object.keys(files).length} files under ${sessions}`);
}
