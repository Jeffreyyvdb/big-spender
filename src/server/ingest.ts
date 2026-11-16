import { createHash, timingSafeEqual } from 'node:crypto';
import { usageSnapshotSchema } from '../schema.ts';
import type { SnapshotStore } from '../store.ts';

// Collectors POST one device's full snapshot here (optionally gzip-encoded).

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_DECODED_BYTES = 16 * 1024 * 1024;

const digest = (s: string) => createHash('sha256').update(s).digest();

function authorized(header: string | null, expected: string): boolean {
	const match = /^Bearer (.+)$/.exec(header ?? '');
	if (!match) return false;
	// Hash both sides so the comparison is constant-time regardless of length.
	return timingSafeEqual(digest(match[1]), digest(expected));
}

class TooLarge extends Error {}

async function readCapped(stream: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > max) {
			await reader.cancel();
			throw new TooLarge();
		}
		chunks.push(value);
	}
	const out = new Uint8Array(size);
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.byteLength;
	}
	return out;
}

export type IngestOptions = {
	store: SnapshotStore;
	token: string | undefined;
	onStored: () => void;
};

export function createIngest({ store, token, onStored }: IngestOptions) {
	const expected = token?.trim();

	return async function ingest(request: Request): Promise<Response> {
		if (!expected) return Response.json({ error: 'ingest is not configured' }, { status: 503 });
		if (!authorized(request.headers.get('authorization'), expected)) {
			return Response.json({ error: 'unauthorized' }, { status: 401 });
		}

		const declared = Number(request.headers.get('content-length') ?? 0);
		if (declared > MAX_BODY_BYTES)
			return Response.json({ error: 'body too large' }, { status: 413 });
		if (!request.body) return Response.json({ error: 'empty body' }, { status: 400 });

		const encoding = (request.headers.get('content-encoding') ?? '').trim().toLowerCase();
		if (encoding && encoding !== 'gzip' && encoding !== 'identity') {
			return Response.json({ error: 'unsupported content-encoding' }, { status: 415 });
		}

		let text: string;
		try {
			const raw = await readCapped(request.body, MAX_BODY_BYTES);
			const decoded =
				encoding === 'gzip'
					? await readCapped(
							new Blob([raw as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip')),
							MAX_DECODED_BYTES
						)
					: raw;
			text = new TextDecoder().decode(decoded);
		} catch (err) {
			if (err instanceof TooLarge)
				return Response.json({ error: 'body too large' }, { status: 413 });
			return Response.json({ error: 'could not read body' }, { status: 400 });
		}

		let body: unknown;
		try {
			body = JSON.parse(text);
		} catch {
			return Response.json({ error: 'invalid JSON' }, { status: 400 });
		}

		const parsed = usageSnapshotSchema.safeParse(body);
		if (!parsed.success) {
			const issues = parsed.error.issues
				.slice(0, 5)
				.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
			return Response.json({ error: 'invalid snapshot', issues }, { status: 422 });
		}

		const result = await store.save(parsed.data);
		if (result === 'stored') onStored();
		return Response.json({
			ok: true,
			deviceId: parsed.data.deviceId,
			rows: parsed.data.hourly.length,
			result
		});
	};
}
