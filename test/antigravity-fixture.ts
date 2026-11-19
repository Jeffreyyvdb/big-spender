// Builds Antigravity conversation databases: SQLite files whose blobs use the protobuf fields that
// ccusage's antigravity adapter decodes (rust/adapters/antigravity/src/parser.rs, v20.0.51).
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const sqlite: typeof import('node:sqlite') | null = await import('node:sqlite').catch(
	() => null
);

const DAY_MS = 86_400_000;

export type Usage = {
	modelId?: number;
	input?: number;
	totalOutput?: number;
	cacheWrite?: number;
	cacheRead?: number;
	reasoning?: number;
	visible?: number;
	provider?: number;
	messageId?: string;
	responseId?: string;
	providerMessageId?: string;
};

function varint(value: number): number[] {
	const out = [];
	let v = BigInt(value);
	while (v >= 0x80n) {
		out.push(Number((v & 0x7fn) | 0x80n));
		v >>= 7n;
	}
	out.push(Number(v));
	return out;
}
const fVarint = (field: number, value: number) => [...varint(field * 8), ...varint(value)];
const fBytes = (field: number, bytes: string | number[]) => {
	const b = typeof bytes === 'string' ? [...Buffer.from(bytes)] : bytes;
	return [...varint(field * 8 + 2), ...varint(b.length), ...b];
};
const timestamp = (ms: number) => [
	...fVarint(1, Math.floor(ms / 1000)),
	...fVarint(2, (ms % 1000) * 1e6)
];

function usage(u: Usage): number[] {
	const out = [];
	if (u.modelId) out.push(...fVarint(1, u.modelId));
	const counts: [number, number | undefined][] = [
		[2, u.input],
		[3, u.totalOutput],
		[4, u.cacheWrite],
		[5, u.cacheRead],
		[9, u.reasoning],
		[10, u.visible]
	];
	for (const [field, value] of counts) if (value) out.push(...fVarint(field, value));
	if (u.provider) out.push(...fVarint(6, u.provider));
	if (u.messageId) out.push(...fBytes(7, u.messageId));
	if (u.responseId) out.push(...fBytes(11, u.responseId));
	if (u.providerMessageId) out.push(...fBytes(12, u.providerMessageId));
	return out;
}

export function generationBlob({
	model,
	modelField = 19,
	use,
	ts,
	retries = [],
	stepIndices = []
}: {
	model?: string;
	modelField?: 19 | 21;
	use?: Usage;
	ts?: number;
	retries?: Usage[];
	stepIndices?: number[];
}): Uint8Array {
	const chat = [];
	if (use?.modelId) chat.push(...fVarint(3, use.modelId));
	if (use) chat.push(...fBytes(4, usage(use)));
	if (ts !== undefined) chat.push(...fBytes(9, fBytes(4, timestamp(ts))));
	for (const r of retries) chat.push(...fBytes(17, fBytes(2, usage(r))));
	if (model) chat.push(...fBytes(modelField, model));
	const root = fBytes(1, chat);
	for (const s of stepIndices) root.push(...fVarint(2, s));
	return Uint8Array.from(root);
}

export function stepBlob({
	model,
	use,
	ts,
	retries = [],
	provider
}: {
	model?: string;
	use?: Usage;
	ts?: number;
	retries?: Usage[];
	provider?: number;
}): Uint8Array {
	const out = [];
	if (ts !== undefined) out.push(...fBytes(8, timestamp(ts)));
	if (use) out.push(...fBytes(9, usage(use)));
	if (model || provider) {
		const info = [];
		if (use?.modelId) info.push(...fVarint(1, use.modelId));
		if (provider) info.push(...fVarint(7, provider));
		if (model) info.push(...fBytes(12, model));
		out.push(...fBytes(24, info));
	}
	for (const r of retries) out.push(...fBytes(28, fBytes(2, usage(r))));
	return Uint8Array.from(out);
}

export const trajectory = (ts: number) => Uint8Array.from(fBytes(2, timestamp(ts)));

export type Rows = {
	gens?: [number, Uint8Array][];
	steps?: [number, Uint8Array][];
	trajectories?: Uint8Array[];
	withStepsAndTrajectory?: boolean;
};

export function openDatabase(
	path: string,
	{ gens = [], steps = [], trajectories = [], withStepsAndTrajectory = true }: Rows
) {
	mkdirSync(dirname(path), { recursive: true });
	const db = new sqlite!.DatabaseSync(path);
	db.exec('PRAGMA synchronous = OFF');
	db.exec('BEGIN');
	db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB NOT NULL)');
	if (withStepsAndTrajectory) {
		db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, metadata BLOB)');
		db.exec('CREATE TABLE trajectory_metadata_blob (data BLOB)');
	}
	addGenerations(db, gens);
	if (withStepsAndTrajectory) {
		const s = db.prepare('INSERT INTO steps (idx, metadata) VALUES (?, ?)');
		for (const [idx, data] of steps) s.run(idx, data);
		const t = db.prepare('INSERT INTO trajectory_metadata_blob (data) VALUES (?)');
		for (const data of trajectories) t.run(data);
	}
	db.exec('COMMIT');
	return db;
}

export function addGenerations(
	db: InstanceType<typeof import('node:sqlite').DatabaseSync>,
	gens: [number, Uint8Array][]
) {
	const g = db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)');
	for (const [idx, data] of gens) g.run(idx, data);
}

export function createDatabase(path: string, rows: Rows) {
	openDatabase(path, rows).close();
}

export const conversation = (home: string, name: string, root = '.gemini/antigravity') =>
	join(home, root, 'conversations', name);

export function buildAntigravityHome(home: string, nowMs = Date.now()) {
	const day0 = Math.floor(nowMs / DAY_MS) * DAY_MS - 3 * DAY_MS;
	const at = (d: number, h: number, m = 0, s = 0, ms = 0) =>
		day0 + d * DAY_MS + ((h * 60 + m) * 60 + s) * 1000 + ms;

	const shared: Usage = {
		input: 100,
		totalOutput: 50,
		cacheWrite: 5,
		cacheRead: 7,
		reasoning: 10,
		visible: 40,
		messageId: 'message-1',
		responseId: 'response-1',
		providerMessageId: 'provider-1'
	};
	const unkeyedMirror: Usage = { input: 15_027, totalOutput: 49, visible: 49, cacheRead: 500_131 };
	const success: Usage = { input: 100, totalOutput: 50, visible: 50 };
	const failed: Usage = { input: 100, totalOutput: 10, visible: 10 };

	createDatabase(conversation(home, 'main.db'), {
		gens: [
			[
				2,
				generationBlob({
					use: {
						input: 300,
						totalOutput: 100,
						reasoning: 25,
						visible: 75,
						messageId: 'message-2',
						responseId: 'response-2'
					},
					ts: at(0, 10, 5)
				})
			],
			[
				1,
				generationBlob({
					model: 'Gemini 3 Pro',
					use: {
						input: 400,
						totalOutput: 200,
						cacheWrite: 30,
						cacheRead: 500,
						reasoning: 50,
						visible: 150,
						messageId: 'message-0',
						responseId: 'response-0',
						providerMessageId: 'provider-0'
					},
					ts: at(0, 10, 0, 0, 123)
				})
			],
			[
				3,
				generationBlob({
					model: 'gemini-3-pro',
					use: shared,
					ts: at(0, 12, 0, 1),
					retries: [
						{
							input: 80,
							totalOutput: 30,
							reasoning: 5,
							visible: 25,
							messageId: 'message-1',
							responseId: 'retry-response',
							providerMessageId: 'provider-1'
						}
					]
				})
			],
			[
				4,
				generationBlob({
					model: 'Gemini 3.6 Flash (High)',
					use: { input: 1000, totalOutput: 300, visible: 300, responseId: 'flash-high' },
					ts: at(0, 23, 59, 59, 900)
				})
			],
			[
				5,
				generationBlob({
					use: {
						modelId: 246,
						input: 4,
						totalOutput: 6,
						visible: 6,
						responseId: 'model-id-response'
					},
					ts: at(1, 0)
				})
			],
			[
				6,
				generationBlob({
					model: 'gemini-4-argon',
					use: unkeyedMirror,
					ts: at(1, 3, 0, 1),
					retries: [unkeyedMirror],
					stepIndices: [10]
				})
			],
			[
				7,
				generationBlob({
					model: 'gemini-3-pro',
					use: success,
					ts: at(1, 4, 0, 1),
					retries: [failed, success],
					stepIndices: [11]
				})
			],
			[
				8,
				generationBlob({
					model: 'model_placeholder_m402',
					use: { input: 400, totalOutput: 80, visible: 80, responseId: 'opus-placeholder' },
					ts: at(1, 5)
				})
			],
			[
				9,
				generationBlob({
					use: { modelId: 1402, input: 300, totalOutput: 60, visible: 60, responseId: 'opus-id' },
					ts: at(1, 5, 1)
				})
			],
			[
				10,
				generationBlob({
					model: 'claude-opus-5-5-medium',
					use: {
						modelId: 1401,
						input: 60,
						totalOutput: 10,
						cacheRead: 40,
						visible: 10,
						responseId: 'unknown-opus'
					},
					ts: at(1, 6),
					retries: [
						{ modelId: 1499, input: 5, totalOutput: 1, visible: 1, responseId: 'unknown-retry' }
					]
				})
			],
			[
				11,
				generationBlob({ model: 'gemini-3-pro', use: { input: 2, totalOutput: 3, visible: 3 } })
			],
			[
				12,
				generationBlob({
					model: 'gemini-3-pro',
					use: {
						input: 20,
						totalOutput: 40,
						visible: 35,
						reasoning: 5,
						messageId: 'shared-message',
						responseId: 'shared-response',
						providerMessageId: 'shared-provider'
					},
					ts: at(2, 8)
				})
			],
			[13, generationBlob({ model: 'gemini-3-pro', use: { responseId: 'empty' }, ts: at(2, 9) })]
		],
		steps: [
			[1, stepBlob({ use: shared, ts: at(0, 12), provider: 7 })],
			[
				2,
				stepBlob({
					model: 'gemini-3-flash-agent',
					ts: at(0, 12, 0, 2),
					retries: [
						{
							input: 11,
							totalOutput: 22,
							reasoning: 2,
							visible: 20,
							messageId: 'step-retry-message',
							responseId: 'step-retry-response',
							providerMessageId: 'step-retry-provider'
						}
					],
					provider: 7
				})
			],
			[10, stepBlob({ model: 'gemini-4-argon-medium', use: unkeyedMirror, ts: at(1, 3) })],
			[11, stepBlob({ model: 'gemini-3-pro', use: success, ts: at(1, 4) })],
			[
				12,
				stepBlob({
					use: { modelId: 246, input: 10, totalOutput: 5, visible: 5, responseId: 'step-pro' },
					ts: at(1, 7),
					retries: [
						{ modelId: 290, input: 20, totalOutput: 4, visible: 4, responseId: 'retry-opus' }
					]
				})
			],
			[
				13,
				stepBlob({
					model: 'gemini-2.5-flash',
					use: {
						input: 700,
						totalOutput: 90,
						visible: 70,
						reasoning: 20,
						cacheRead: 300,
						responseId: 'vertex-step'
					},
					ts: at(1, 8),
					provider: 24
				})
			]
		],
		trajectories: [trajectory(at(2, 4, 13, 20, 456)), trajectory(at(0, 1))]
	});

	createDatabase(conversation(home, 'cli.db', '.gemini/antigravity-cli'), {
		gens: [
			[
				1,
				generationBlob({
					model: 'gemini-3-pro',
					use: {
						input: 200,
						totalOutput: 400,
						visible: 350,
						reasoning: 50,
						messageId: 'shared-message',
						responseId: 'retry-response-cli',
						providerMessageId: 'shared-provider'
					},
					ts: at(2, 8, 0, 1)
				})
			],
			[
				2,
				generationBlob({
					model: 'Claude 3.7 Sonnet Thinking',
					use: {
						input: 1200,
						totalOutput: 640,
						visible: 512,
						reasoning: 128,
						cacheWrite: 2048,
						cacheRead: 4096,
						responseId: 'cli-sonnet'
					},
					ts: at(2, 13, 30)
				})
			],
			[
				3,
				generationBlob({
					model: 'Experimental Model (Preview 2)',
					use: { input: 70, totalOutput: 7, visible: 7, responseId: 'odd-name' },
					ts: at(2, 14)
				})
			]
		]
	});

	createDatabase(conversation(home, 'sub/nested.db', '.config/antigravity'), {
		gens: [
			[
				1,
				generationBlob({
					model: 'gemini-3-flash-agent',
					modelField: 21,
					use: {
						input: 900,
						totalOutput: 120,
						visible: 120,
						cacheRead: 2000,
						responseId: 'nested-flash'
					},
					ts: at(2, 15)
				})
			],
			[
				2,
				generationBlob({
					use: {
						modelId: 246,
						input: 250_000,
						totalOutput: 1000,
						visible: 1000,
						responseId: 'long-context'
					},
					ts: at(2, 16)
				})
			]
		],
		withStepsAndTrajectory: false
	});

	const noModel = conversation(home, 'nomodel.db', '.gemini/antigravity-acp');
	createDatabase(noModel, {
		gens: [[1, generationBlob({ use: { input: 33, totalOutput: 11, visible: 11 } })]]
	});
	utimesSync(noModel, new Date(at(2, 18)), new Date(at(2, 18)));

	createDatabase(conversation(home, 'partial.db', '.gemini/antigravity-backup'), {
		gens: [
			[
				1,
				generationBlob({
					model: 'gemini-3-pro',
					use: { input: 100, totalOutput: 5, visible: 5, responseId: 'must-not-count' },
					ts: at(2, 20)
				})
			],
			[2, Uint8Array.from([0x0a, 0x01, 0x80])]
		]
	});
	writeFileSync(conversation(home, 'not-a-database.db'), 'not sqlite');
	writeFileSync(conversation(home, 'empty.db'), '');
	mkdirSync(join(home, '.gemini/antigravity-ide'), { recursive: true });
	writeFileSync(join(home, '.gemini/antigravity-ide/conversation_summaries.db'), 'not sqlite');
	return { day0, at };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const home = process.argv[2];
	if (!home || !sqlite) {
		console.error('usage: node test/antigravity-fixture.ts <home>   (needs node:sqlite)');
		process.exit(2);
	}
	buildAntigravityHome(home);
}
