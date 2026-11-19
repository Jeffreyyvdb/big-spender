import { createHash, timingSafeEqual } from 'node:crypto';

const digest = (s: string) => createHash('sha256').update(s).digest();

export function authorized(header: string | null, expected: string): boolean {
	const match = /^Bearer (.+)$/.exec(header ?? '');
	if (!match) return false;
	// Hash both sides so the comparison is constant-time regardless of length.
	return timingSafeEqual(digest(match[1]), digest(expected));
}
