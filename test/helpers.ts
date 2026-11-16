import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UsageRow, UsageSnapshot } from '../src/schema.ts';

export function row(hour: string, model: string, cost: number): UsageRow {
	return {
		hour,
		provider: 'claude',
		model,
		sessions: 1,
		inputTokens: 10,
		cacheReadTokens: 1000,
		cacheWrite5mTokens: 0,
		cacheWrite1hTokens: 100,
		outputTokens: 50,
		costUsd: { input: 0, cacheRead: cost / 2, cacheWrite: cost / 4, output: cost / 4 },
		cacheSavingsUsd: 1
	};
}

export function snapshot(
	deviceId: string,
	generatedAt = '2026-11-14T22:00:00Z',
	cost = 4
): UsageSnapshot {
	const c = { claude: 1, codex: 0, all: 1 };
	return {
		schemaVersion: 1,
		deviceId,
		generatedAt,
		coverageStart: '2026-08-16T00:00:00Z',
		pricingSource: 'litellm@2026-11-14',
		hourly: [row('2026-11-14T21:00:00Z', 'claude-opus-5-5', cost)],
		sessionsTotal: 1,
		sessionCounts: { '7d': c, '30d': c, '90d': c }
	};
}

export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), 'big-spender-test-'));
	try {
		return await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
