import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDERS, usageSnapshotSchema } from '../src/schema.ts';
import { snapshot } from './helpers.ts';

const withCounts = (counts: Record<string, number>) => {
	const { sessionCounts, ...rest } = snapshot('mac');
	return { ...rest, sessionCounts: { '7d': counts, '30d': counts, '90d': counts } };
};
const parses = (s: unknown) => usageSnapshotSchema.safeParse(s).success;

test('session counts need claude and codex, and accept any other listed provider', () => {
	assert.equal(parses(withCounts({ claude: 1, codex: 0, all: 1 })), true);
	assert.equal(parses(withCounts({ claude: 1, all: 1 })), false);
	assert.equal(parses(withCounts({ codex: 1, all: 1 })), false);
	assert.equal(parses(withCounts({ claude: 0, codex: 0, 'not-a-provider': 1, all: 1 })), false);
	for (const p of PROVIDERS.filter((p) => p !== 'claude' && p !== 'codex')) {
		assert.equal(parses(withCounts({ claude: 0, codex: 0, [p]: 2, all: 2 })), true, p);
	}
	const { sessionCounts, ...older } = snapshot('mac');
	assert.equal(parses(older), true);
});

test('a row from a provider that is not listed is rejected', () => {
	const s = snapshot('mac');
	assert.equal(parses({ ...s, hourly: [{ ...s.hourly[0], provider: 'not-a-provider' }] }), false);
});
