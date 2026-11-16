// KEY=value lines, as the collector and systemd's EnvironmentFile read them.

const LINE = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/;

export const SETTINGS = ['DEVICE_ID', 'INGEST_URL', 'INGEST_TOKEN'] as const;
export type Setting = (typeof SETTINGS)[number];

export function parseEnv(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const raw of text.split('\n')) {
		const m = LINE.exec(raw);
		if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
	}
	return out;
}

/** The value of a setting under its current name, or the name collectors used before the rename. */
export function setting(vars: Record<string, string | undefined>, name: Setting): string {
	return vars[`BIG_SPENDER_${name}`] || vars[`USAGE_${name}`] || '';
}

/**
 * Renames USAGE_DEVICE_ID, USAGE_INGEST_URL and USAGE_INGEST_TOKEN to their BIG_SPENDER_ names,
 * keeping every value, comment and other line. A key whose new name is already defined is left alone.
 */
export function renameLegacyKeys(text: string): string {
	const defined = parseEnv(text);
	return text
		.split('\n')
		.map((line) => {
			const m = /^(\s*(?:export\s+)?)USAGE_(DEVICE_ID|INGEST_URL|INGEST_TOKEN)(\s*=.*)$/.exec(line);
			if (!m || `BIG_SPENDER_${m[2]}` in defined) return line;
			return `${m[1]}BIG_SPENDER_${m[2]}${m[3]}`;
		})
		.join('\n');
}

/** Sets each key in place, or appends it, leaving all other lines as they are. */
export function upsertEnv(text: string, values: Record<string, string>): string {
	const lines = text.split('\n');
	if (lines.at(-1) === '') lines.pop();
	for (const [key, value] of Object.entries(values)) {
		const at = lines.findLastIndex((l) => LINE.exec(l)?.[1] === key);
		if (at === -1) lines.push(`${key}=${value}`);
		else lines[at] = `${key}=${value}`;
	}
	return `${lines.join('\n')}\n`;
}
