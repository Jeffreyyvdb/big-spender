import { chmodSync, copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const path = (p) => fileURLToPath(new URL(p, root));

mkdirSync(path('dist'), { recursive: true });
copyFileSync(path('src/collector.mjs'), path('dist/collector.mjs'));
chmodSync(path('dist/collector.mjs'), 0o755);
try {
	chmodSync(path('dist/cli.js'), 0o755);
} catch {
	// No CLI built yet.
}
