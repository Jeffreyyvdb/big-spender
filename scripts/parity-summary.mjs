// Proves the package's summarize() equals the site's, on real snapshots, for several instants and
// device configs. Run: SITE_REPO=<site checkout> node scripts/parity-summary.mjs
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { summarize as packageSummarize } from '../src/summary.ts';
import { usageSnapshotSchema } from '../src/schema.ts';
import { exportSite, fetchPricing, dryRun, packageCollector } from './lib/parity.mjs';

const site = await exportSite();
const load = (name) => import(pathToFileURL(join(site.lib, name)).href);
const { summarize: siteSummarize } = await load('summary.ts');
const { deviceConfig: siteConfig } = await load('devices.config.ts');

const pricing = await fetchPricing();
const listed = Object.keys(siteConfig.devices);
const real = (await dryRun(packageCollector, 'package', listed[0], { pricingFrom: pricing }))
	.snapshot;
console.log(`real snapshot: ${real.hourly.length} rows, ${real.sessionsTotal} sessions`);

const as = (deviceId, hourly = real.hourly) => ({ ...real, deviceId, hourly });
const half = Math.floor(real.hourly.length / 2);
const sets = {
	'one listed device': [as(listed[0])],
	'listed and unlisted devices': [...listed.map((id) => as(id)), as('some-hostname')],
	'split rows, empty device, Object property id': [
		as(listed[0], real.hourly.slice(0, half)),
		as(listed[1], real.hourly.slice(half)),
		as(listed[2], []),
		as('constructor'),
		as('zzz-unlisted')
	]
};
for (const snapshots of Object.values(sets)) {
	for (const s of snapshots) assert.equal(usageSnapshotSchema.safeParse(s).success, true);
}

const configs = {
	'the site config': siteConfig,
	'by-id fallback': { devices: { [listed[0]]: { name: 'Laptop', color: '#3899e2' } } },
	'empty config': { devices: {}, unknownDevices: 'other' }
};
const instants = {
	'Date.now()': Date.now(),
	'2026-11-14T22:30:00Z': Date.parse('2026-11-14T22:30:00Z'),
	'2026-10-20T00:00:00Z': Date.parse('2026-10-20T00:00:00Z')
};

let checks = 0;
for (const [setName, snapshots] of Object.entries(sets)) {
	for (const [configName, config] of Object.entries(configs)) {
		for (const [instantName, now] of Object.entries(instants)) {
			const theirs = siteSummarize(snapshots, now, config);
			const ours = packageSummarize(snapshots, now, config);
			assert.deepEqual(ours, theirs, `${setName} / ${configName} / ${instantName}`);
			assert.equal(JSON.stringify(ours), JSON.stringify(theirs));
			checks++;
		}
	}
}

// The site calls summarize(snapshots, now) with its own config as the default.
for (const [instantName, now] of Object.entries(instants)) {
	const snapshots = sets['listed and unlisted devices'];
	assert.deepEqual(packageSummarize(snapshots, now, siteConfig), siteSummarize(snapshots, now));
	checks++;
	console.log(`ok default-config call at ${instantName}`);
}
const range90 = packageSummarize(sets['listed and unlisted devices'], Date.now(), siteConfig)
	.ranges['90d'];
console.log(
	`90d total across every listed device and one unlisted: ${range90.totalCost.toFixed(2)} USD, devices: ${range90.devices.map((d) => d.name).join(', ')}`
);
console.log(`ok: ${checks} summaries identical (deepEqual and byte-for-byte JSON)`);
