import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { mergeSnapshots } from './history.ts';
import { DEVICE_ID, usageSnapshotSchema, type UsageSnapshot } from './schema.ts';

export type SaveResult = 'stored' | 'stale';

export type SnapshotStore = {
	list(): Promise<UsageSnapshot[]>;
	save(snapshot: UsageSnapshot): Promise<SaveResult>;
};

async function loadFromDisk(dir: string): Promise<Map<string, UsageSnapshot>> {
	const out = new Map<string, UsageSnapshot>();
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return out;
	}
	for (const name of names) {
		const id = name.replace(/\.json$/, '');
		if (!name.endsWith('.json') || !DEVICE_ID.test(id)) continue;
		try {
			const parsed = usageSnapshotSchema.safeParse(
				JSON.parse(await readFile(join(dir, name), 'utf8'))
			);
			if (parsed.success && parsed.data.deviceId === id) out.set(id, parsed.data);
			else console.warn(`[big-spender] ignoring invalid snapshot file ${name}`);
		} catch (err) {
			console.warn(
				`[big-spender] could not read ${name}:`,
				err instanceof Error ? err.message : err
			);
		}
	}
	return out;
}

export function fileStore(dir: string): SnapshotStore {
	const root = resolve(dir);
	let loading: Promise<Map<string, UsageSnapshot>> | null = null;
	const snapshots = () => (loading ??= loadFromDisk(root));

	return {
		async list() {
			return [...(await snapshots()).values()];
		},
		save
	};

	async function save(snap: UsageSnapshot): Promise<SaveResult> {
		const all = await snapshots();
		const current = all.get(snap.deviceId);
		if (current && Date.parse(current.generatedAt) > Date.parse(snap.generatedAt)) {
			return 'stale';
		}

		const { snapshot, droppedDays } = mergeSnapshots(current, snap);
		if (droppedDays > 0) {
			console.warn(
				`[big-spender] ${snap.deviceId}: history is full, dropped the oldest ${droppedDays} day(s)`
			);
		}

		await mkdir(root, { recursive: true });
		const file = join(root, `${snap.deviceId}.json`);
		const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
		await writeFile(tmp, JSON.stringify(snapshot));
		await rename(tmp, file);

		all.set(snap.deviceId, snapshot);
		return 'stored';
	}
}
