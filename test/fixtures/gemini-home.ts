// Writes a Gemini CLI data dir (the layout under ~/.gemini/tmp) that covers every record shape
// ccusage's gemini adapter parses. The collector tests and scripts/parity-ccusage.mjs both read it.
// Run: node test/fixtures/gemini-home.ts <home> [YYYY-MM-DD]
// The date is the first UTC day of usage; it defaults to three days ago so the collector's
// 90-day window always covers it.
import { mkdir, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SECRETS = ['SECRET-PROMPT', '/home/alice/acme', 'sess-json-a', 'project-hash-a'];

const DAY_MS = 86_400_000;

export function defaultBaseDay(nowMs = Date.now()) {
	return new Date(Math.floor(nowMs / DAY_MS) * DAY_MS - 3 * DAY_MS).toISOString().slice(0, 10);
}

const jsonl = (records: object[]) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';

/** Writes the fixture and returns its tmp dir. `baseDay` is YYYY-MM-DD. */
export async function writeGeminiHome(home: string, baseDay = defaultBaseDay()) {
	const base = Date.parse(`${baseDay}T00:00:00Z`);
	const at = (hours: number, minutes = 0) =>
		new Date(base + hours * 3_600_000 + minutes * 60_000).toISOString();
	const tmp = join(home, '.gemini', 'tmp');
	const files: Record<string, string> = {};

	// Whole-file JSON session, the format Gemini CLI rewrites after every message.
	files['project-hash-a/chats/session-a.json'] = JSON.stringify({
		sessionId: 'sess-json-a',
		projectHash: 'project-hash-a',
		startTime: at(10),
		lastUpdated: at(11, 5),
		messages: [
			{ id: 'a-u1', timestamp: at(10), type: 'user', content: 'SECRET-PROMPT in /home/alice/acme' },
			// total includes the cached prompt tokens, so cached is subtracted from input.
			{
				id: 'a-g1',
				timestamp: at(10, 1),
				type: 'gemini',
				content: 'SECRET-PROMPT echoed',
				model: 'gemini-2.5-pro',
				thoughts: [{ subject: 'plan', description: 'SECRET-PROMPT' }],
				tokens: { input: 12000, output: 300, cached: 8000, thoughts: 150, tool: 0, total: 12450 }
			},
			// No timestamp: the session's startTime is used. total excludes cached, so input stays.
			{
				id: 'a-g2',
				type: 'gemini',
				content: '',
				model: 'gemini-2.5-flash',
				tokens: { input: 5000, output: 100, cached: 1000, thoughts: 0, tool: 20, total: 6120 }
			},
			// No model on a whole-file message: ccusage drops it.
			{
				id: 'a-g3',
				timestamp: at(10, 30),
				type: 'gemini',
				content: '',
				tokens: { input: 900, output: 9, total: 909 }
			},
			// Only a total: it all counts as output.
			{
				id: 'a-g4',
				timestamp: at(10, 40),
				type: 'gemini',
				model: 'gemini-2.5-pro',
				tokens: { total: 900 }
			},
			// Alias keys, a fractional count, a negative count and an unaccounted remainder.
			{
				id: 'a-g5',
				timestamp: at(10, 50),
				type: 'gemini',
				model: 'gemini-2.5-pro',
				tokens: { prompt: 2000.7, candidates: 50, cached: -5, total: 2200 }
			},
			{
				id: 'a-g6',
				timestamp: at(10, 55),
				type: 'gemini',
				model: 'gemini-2.5-pro',
				tokens: { input: 0, output: 0, total: 0 }
			},
			{ id: 'a-i1', timestamp: at(10, 56), type: 'info', content: 'SECRET-PROMPT info' },
			// A prompt over 200k tokens, priced at the long-context rate.
			{
				id: 'a-g7',
				timestamp: at(11),
				type: 'gemini',
				model: 'gemini-2.5-pro',
				tokens: { input: 250000, output: 1000, cached: 0, thoughts: 500, tool: 0, total: 251500 }
			}
		]
	});

	// Append-only JSONL session. A message is appended again with the same id when it is updated;
	// the last copy wins. A message without a model takes the last model seen in the file.
	files['project-hash-b/chats/session-b.jsonl'] = jsonl([
		{ sessionId: 'sess-jsonl-b', projectHash: 'project-hash-b', startTime: at(14), kind: 'main' },
		{ id: 'b-u1', timestamp: at(14), type: 'user', content: [{ text: 'SECRET-PROMPT' }] },
		{
			id: 'b-g1',
			timestamp: at(14, 1),
			type: 'gemini',
			content: '',
			model: 'gemini-3-flash-preview',
			tokens: { input: 15327, output: 23, cached: 11526, thoughts: 919, tool: 7, total: 16276 }
		},
		{
			id: 'b-g1',
			timestamp: at(14, 2),
			type: 'gemini',
			content: 'SECRET-PROMPT answer',
			model: 'gemini-3-flash-preview',
			tokens: { input: 15327, output: 60, cached: 11526, thoughts: 919, tool: 7, total: 16313 }
		},
		{ $set: { lastUpdated: at(14, 2) } },
		{
			id: 'b-g2',
			timestamp: at(15, 10),
			type: 'gemini',
			content: '',
			tokens: { input: 3000, output: 40, cached: 0, thoughts: 0, tool: 0, total: 3040 }
		},
		// Just before and just after UTC midnight.
		{
			id: 'b-g3',
			timestamp: at(23, 59),
			type: 'gemini',
			model: 'gemini-2.5-pro',
			tokens: { input: 4000, output: 80, cached: 2000, thoughts: 20, tool: 0, total: 4100 }
		},
		{
			id: 'b-g4',
			timestamp: at(24, 1),
			type: 'gemini',
			model: 'gemini-2.5-pro',
			tokens: { input: 6000, output: 90, cached: 3000, thoughts: 10, tool: 0, total: 6100 }
		}
	]);

	// Headless `gemini -p --output-format json` output saved under tmp: per-model stats, cached
	// always inside prompt. It has no timestamp, so the file's mtime dates it.
	files['project-hash-c/headless.json'] = JSON.stringify({
		response: 'SECRET-PROMPT answer',
		stats: {
			models: {
				'gemini-2.5-flash': {
					api: { totalRequests: 2 },
					tokens: {
						prompt: 8000,
						candidates: 200,
						total: 8450,
						cached: 3000,
						thoughts: 250,
						tool: 0
					}
				}
			}
		}
	});
	// Headless `--output-format stream-json`: the init event names the model, the result has stats.
	files['project-hash-c/stream.jsonl'] = jsonl([
		{ type: 'init', timestamp: at(34), session_id: 'sess-stream-d', model: 'gemini-2.5-pro' },
		{ type: 'message', timestamp: at(34), role: 'user', content: 'SECRET-PROMPT' },
		{
			type: 'result',
			timestamp: at(34, 5),
			status: 'success',
			stats: {
				total_tokens: 5300,
				input_tokens: 5000,
				output_tokens: 300,
				cached: 1200,
				tool_calls: 0
			}
		}
	]);
	// Stats nested under result, and stats without a model anywhere ("unknown").
	files['project-hash-c/nested.json'] = JSON.stringify({
		timestamp: at(35),
		model: 'gemini-2.5-flash',
		result: { stats: { input_tokens: 700, output_tokens: 70, total_tokens: 770 } }
	});
	files['project-hash-c/no-model.json'] = JSON.stringify({
		timestamp: at(35, 30),
		stats: { input_tokens: 100, output_tokens: 10 }
	});
	// One record as a whole file.
	files['project-hash-c/single.json'] = JSON.stringify({
		type: 'gemini',
		id: 'solo',
		timestamp: at(36),
		model: 'gemini-2.5-flash',
		tokens: { input: 400, output: 40, total: 440 }
	});

	// Files Gemini CLI keeps beside the chats that carry no usage.
	files['project-hash-a/logs.json'] = JSON.stringify([
		{
			sessionId: 'sess-json-a',
			messageId: 0,
			type: 'user',
			message: 'SECRET-PROMPT',
			timestamp: at(10)
		}
	]);
	files['project-hash-a/checkpoint-SECRET-PROMPT.json'] = JSON.stringify([
		{ role: 'user', parts: [{ text: 'SECRET-PROMPT' }] }
	]);
	files['project-hash-a/chats/session-broken.json'] =
		'{"sessionId":"sess-broken","messages":[{"id":"x"';
	files['project-hash-a/notes.txt'] = 'SECRET-PROMPT';

	for (const [rel, content] of Object.entries(files)) {
		const path = join(tmp, rel);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, content);
	}
	const headlessMtime = new Date(at(33)).getTime() / 1000;
	await utimes(join(tmp, 'project-hash-c/headless.json'), headlessMtime, headlessMtime);
	return tmp;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [home, day] = process.argv.slice(2);
	if (!home) throw new Error('usage: node test/fixtures/gemini-home.ts <home> [YYYY-MM-DD]');
	console.log(await writeGeminiHome(home, day));
}
