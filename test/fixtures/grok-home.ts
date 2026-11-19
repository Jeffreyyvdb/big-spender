// A Grok Build data dir covering the cases the ccusage grok adapter handles. Timestamps are
// relative to today (UTC), so the collector's 90-day window always includes them.
// Usage: node test/fixtures/grok-home.ts <home>   (writes <home>/.grok)
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DAY = 86_400_000;

export const PROMPT_TEXT = 'refactor the secret-sauce module';
export const PROJECT_DIR = '/home/dev/secret-project';

type Turn = {
	ts: number;
	session: string;
	event?: string;
	usage: object;
	agentMs?: boolean;
	sessionField?: boolean;
};

export async function writeGrokHome(root: string, nowMs = Date.now()) {
	const today = Math.floor(nowMs / DAY) * DAY;
	const at = (daysAgo: number, h: number, m = 0, s = 0) =>
		today - daysAgo * DAY + ((h * 60 + m) * 60 + s) * 1000;

	const turn = ({ ts, session, event, usage, agentMs = true, sessionField = true }: Turn) =>
		JSON.stringify({
			timestamp: Math.floor(ts / 1000),
			method: '_x.ai/session/update',
			params: {
				...(sessionField ? { sessionId: session } : {}),
				update: { sessionUpdate: 'turn_completed', usage },
				_meta: {
					...(event ? { eventId: event } : {}),
					...(agentMs ? { agentTimestampMs: ts } : {})
				}
			}
		});
	const model = (name: string, u: Record<string, number>) => ({ ...u, modelUsage: { [name]: u } });

	const s1 = '019fa1b1-0000-7000-8000-000000000001';
	const s2 = '019fa1b1-0000-7000-8000-000000000002';
	const enc = (p: string) => encodeURIComponent(p);
	const files: Record<string, string> = {};

	files[`sessions/${enc(PROJECT_DIR)}/${s1}/summary.json`] = JSON.stringify({
		info: { id: s1, cwd: PROJECT_DIR },
		current_model_id: 'grok-4.5-build',
		title: PROMPT_TEXT
	});
	const realTurn = turn({
		ts: at(3, 10, 15, 30),
		session: s1,
		event: 'evt-real',
		// A real Grok CLI 1.0.0 record (ccusage parser test reads_the_recorded_cost_usd_ticks):
		// costUsdTicks / 1e10 is the xAI list price for these tokens.
		usage: model('grok-4.5-build', {
			inputTokens: 18444,
			outputTokens: 130,
			cachedReadTokens: 11264,
			reasoningTokens: 73,
			totalTokens: 18574,
			costUsdTicks: 185192000
		})
	});
	files[`sessions/${enc(PROJECT_DIR)}/${s1}/updates.jsonl`] = [
		JSON.stringify({
			timestamp: Math.floor(at(3, 10, 15) / 1000),
			params: {
				sessionId: s1,
				update: { sessionUpdate: 'user_message', content: { text: PROMPT_TEXT } }
			}
		}),
		realTurn,
		realTurn,
		turn({
			ts: at(3, 11, 2),
			session: s1,
			event: 'evt-multi',
			usage: {
				modelUsage: {
					'grok-4.5-build': {
						inputTokens: 5000,
						outputTokens: 300,
						cachedReadTokens: 1000,
						reasoningTokens: 100
					},
					'grok-code-fast-1': { inputTokens: 2000, outputTokens: 50, cachedReadTokens: 0 }
				}
			}
		}),
		turn({
			ts: at(3, 11, 40),
			session: s1,
			event: 'evt-top-level',
			usage: { inputTokens: 900, outputTokens: 40, cachedReadTokens: 100, reasoningTokens: 12 }
		}),
		JSON.stringify({
			timestamp: Math.floor(at(3, 11, 41) / 1000),
			params: {
				sessionId: s1,
				update: { sessionUpdate: 'turn_completed' },
				_meta: { eventId: 'evt-no-usage' }
			}
		}),
		turn({
			ts: at(3, 11, 42),
			session: s1,
			event: 'evt-zero',
			usage: model('grok-4.5-build', {
				inputTokens: 0,
				outputTokens: 0,
				cachedReadTokens: 0,
				reasoningTokens: 0
			})
		}),
		'{"this is not json',
		turn({
			ts: at(3, 12, 5),
			session: s1,
			event: 'evt-cache-write',
			usage: model('grok-4.5-build', {
				inputTokens: 100,
				outputTokens: 20,
				cachedReadTokens: 40,
				cacheCreationTokens: 25,
				reasoningTokens: 10
			})
		}),
		turn({
			ts: at(3, 12, 6),
			session: s1,
			event: 'evt-clamp',
			usage: model('grok-4.5-build', { inputTokens: 50, outputTokens: 5, cachedReadTokens: 80 })
		}),
		// Envelope seconds only, either side of UTC midnight.
		turn({
			ts: at(2, 23, 59, 59),
			session: s1,
			event: 'evt-before-midnight',
			agentMs: false,
			usage: model('grok-4.5-build', {
				inputTokens: 3000,
				outputTokens: 70,
				cachedReadTokens: 2000
			})
		}),
		turn({
			ts: at(1, 0, 0, 1),
			session: s1,
			event: 'evt-after-midnight',
			agentMs: false,
			usage: model('grok-4.5-build', {
				inputTokens: 4000,
				outputTokens: 80,
				cachedReadTokens: 3000
			})
		}),
		// A long turn: many requests, each under 200K, whose sum is past it. The ticks are the
		// base-rate price, which is what xAI bills per request.
		turn({
			ts: at(1, 9, 30),
			session: s1,
			event: 'evt-long-ticks',
			usage: model('grok-4.5-build', {
				inputTokens: 450000,
				outputTokens: 2000,
				cachedReadTokens: 400000,
				reasoningTokens: 600,
				costUsdTicks: 50000 * 20000 + 400000 * 3000 + 2000 * 60000
			})
		}),
		''
	].join('\n');

	const other = '/home/dev/other';
	const eventless = (reasoningTokens: number, ts = at(2, 14, 0)) =>
		turn({
			ts,
			session: s2,
			usage: model('grok-4.5-build', {
				inputTokens: 1000,
				outputTokens: 20,
				cachedReadTokens: 400,
				reasoningTokens
			})
		});
	files[`sessions/${enc(other)}/${s2}/updates.jsonl`] = [
		realTurn,
		turn({
			ts: at(2, 13, 0),
			session: s2,
			event: 'evt-b1',
			sessionField: false,
			usage: model('grok-code-fast-1', {
				inputTokens: 12000,
				outputTokens: 400,
				cachedReadTokens: 8000
			})
		}),
		eventless(5),
		eventless(5),
		eventless(10),
		turn({
			ts: at(2, 15, 0),
			session: s2,
			event: 'evt-unknown-model',
			usage: { inputTokens: 10, outputTokens: 1 }
		}),
		''
	].join('\n');

	files[`sessions/${enc(other)}/${s2}/events.jsonl`] =
		realTurn.replace('evt-real', 'evt-events') + '\n';
	files['sessions/proj/sess-bad/updates.jsonl'] = '\0\0\0not-jsonl\n{broken';
	files['logs/unified.jsonl'] =
		JSON.stringify({ prompt_tokens: 999999, cached_prompt_tokens: 0 }) + '\n';

	for (const [rel, content] of Object.entries(files)) {
		const path = join(root, rel);
		await mkdir(join(path, '..'), { recursive: true });
		await writeFile(path, content);
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	await writeGrokHome(join(process.argv[2], '.grok'));
}
