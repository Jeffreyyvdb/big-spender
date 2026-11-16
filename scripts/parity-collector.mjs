// Proves the package's collector produces the same snapshot as the site's collector on the same
// logs. Run: SITE_REPO=<site checkout> node scripts/parity-collector.mjs
import assert from 'node:assert/strict';
import { collectBoth, exportSite, fetchPricing } from './lib/parity.mjs';

// generatedAt is the wall clock of each run, so it is the one field allowed to differ.
const strip = ({ generatedAt, ...rest }) => rest;
const same = (a, b) => JSON.stringify(strip(a)) === JSON.stringify(strip(b));

const site = await exportSite();
const pricing = await fetchPricing();

let failures = 0;
for (const deviceId of ['desktop', 'laptop', 'some-hostname']) {
	const { theirs, ours, attempt } = await collectBoth(site, deviceId, pricing, same);
	try {
		assert.deepEqual(strip(ours), strip(theirs));
		assert.equal(JSON.stringify(strip(ours)), JSON.stringify(strip(theirs)));
		console.log(
			`ok ${deviceId}: ${ours.hourly.length} rows, ${ours.sessionsTotal} sessions, ` +
				`pricing ${ours.pricingSource}, identical JSON (attempt ${attempt})`
		);
	} catch (err) {
		failures++;
		console.error(`FAIL ${deviceId}:`, err.message);
	}
}
process.exit(failures ? 1 : 0);
