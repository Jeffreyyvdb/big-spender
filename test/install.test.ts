import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { main } from '../src/cli.ts';
import { parseEnv, renameLegacyKeys, upsertEnv } from '../src/envfile.ts';
import type { Ctl } from '../src/scheduler.ts';
import { harness, tree, withSandbox, type Sandbox } from './helpers.ts';

const URL_ = 'https://example.com/api/usage/ingest';
const STATE = '{"version":1,  "files":{},"seen":{"c:abc":[1,2]},"buckets":{}}\n';
const LEGACY_ENV = `# ~/.config/usage-collector/env  (chmod 600)
USAGE_DEVICE_ID=laptop
USAGE_INGEST_URL=${URL_}
export USAGE_INGEST_TOKEN='s3cret'
OTHER_SETTING=keep me
`;

const exists = (path: string) =>
	access(path).then(
		() => true,
		() => false
	);

async function writeLegacy(box: Sandbox) {
	const config = join(box.env.XDG_CONFIG_HOME, 'usage-collector');
	const cache = join(box.env.XDG_CACHE_HOME, 'usage-collector');
	const share = join(box.home, '.local', 'share', 'usage-collector');
	const units = join(box.env.XDG_CONFIG_HOME, 'systemd', 'user');
	for (const dir of [config, cache, share, units]) await mkdir(dir, { recursive: true });
	await writeFile(join(config, 'env'), LEGACY_ENV, { mode: 0o600 });
	await writeFile(join(cache, 'state.json'), STATE);
	await writeFile(join(cache, 'litellm-prices.json'), '{"fetchedAt":1,"models":{}}');
	await writeFile(join(share, 'collector.mjs'), '// old collector\n');
	await writeFile(join(units, 'usage-collector.service'), '[Service]\n');
	await writeFile(join(units, 'usage-collector.timer'), '[Timer]\n');
	return { config, cache, share, units };
}

test('install migrates a usage-collector install in place', async () => {
	await withSandbox(async (box) => {
		const legacy = await writeLegacy(box);
		const { ctx, out, err } = harness(box);

		assert.equal(await main(['install', '--device', 'laptop'], ctx), 0, err.join('\n'));

		for (const gone of [legacy.config, legacy.cache, legacy.share])
			assert.equal(await exists(gone), false, gone);
		for (const unit of ['usage-collector.service', 'usage-collector.timer']) {
			assert.equal(await exists(join(legacy.units, unit)), false);
		}

		const env = join(box.env.XDG_CONFIG_HOME, 'big-spender', 'env');
		assert.equal(
			await readFile(env, 'utf8'),
			`# ~/.config/usage-collector/env  (chmod 600)
BIG_SPENDER_DEVICE_ID=laptop
BIG_SPENDER_INGEST_URL=${URL_}
BIG_SPENDER_INGEST_TOKEN=s3cret
OTHER_SETTING=keep me
`
		);
		assert.equal((await stat(env)).mode & 0o777, 0o600);

		const state = join(box.env.XDG_CACHE_HOME, 'big-spender', 'state.json');
		assert.equal(await readFile(state, 'utf8'), STATE);
		assert.equal(
			await exists(join(box.env.XDG_CACHE_HOME, 'big-spender', 'litellm-prices.json')),
			true
		);

		const share = join(box.home, '.local', 'share', 'big-spender', 'collector.mjs');
		assert.equal(await readFile(share, 'utf8'), await readFile(ctx.collector, 'utf8'));
		const service = await readFile(join(legacy.units, 'big-spender.service'), 'utf8');
		assert.match(service, /ExecStart=\S+ %h\/\.local\/share\/big-spender\/collector\.mjs/);
		assert.match(
			await readFile(join(legacy.units, 'big-spender.timer'), 'utf8'),
			/OnCalendar=hourly/
		);
		assert.ok(out.some((l) => l.includes('moved')));
		assert.doesNotMatch([...out, ...err].join('\n'), /s3cret/);
	});
});

test('a second install changes nothing', async () => {
	await withSandbox(async (box) => {
		await writeLegacy(box);
		assert.equal(await main(['install', '--device', 'laptop'], harness(box).ctx), 0);
		const before = await tree(box.home);

		const again = harness(box);
		assert.equal(await main(['install', '--device', 'laptop'], again.ctx), 0, again.err.join('\n'));
		assert.deepEqual(await tree(box.home), before);
		assert.deepEqual(again.asked, []);
		assert.equal(
			again.out.some((l) => l.includes('moved') || l.includes('removed')),
			false
		);
	});
});

test('an interrupted migration converges on the next run', async () => {
	await withSandbox(async (box) => {
		const legacy = await writeLegacy(box);
		// The config dir was renamed but its keys were not.
		const { rename } = await import('node:fs/promises');
		await rename(legacy.config, join(box.env.XDG_CONFIG_HOME, 'big-spender'));

		assert.equal(await main(['install', '--device', 'laptop'], harness(box).ctx), 0);
		const env = parseEnv(
			await readFile(join(box.env.XDG_CONFIG_HOME, 'big-spender', 'env'), 'utf8')
		);
		assert.equal(env.BIG_SPENDER_INGEST_TOKEN, 's3cret');
		assert.equal('USAGE_INGEST_TOKEN' in env, false);
	});
});

test('a fresh install asks for the URL and a hidden token, and never logs the token', async () => {
	await withSandbox(async (box) => {
		const { ctx, out, err, asked } = harness(box, { answers: [URL_, 'tok-123'] });
		assert.equal(await main(['install', '--device', 'desk'], ctx), 0, err.join('\n'));
		assert.deepEqual(asked, ['Ingest URL (https://…/api/usage/ingest): ', 'Ingest token: ']);

		const env = join(box.env.XDG_CONFIG_HOME, 'big-spender', 'env');
		assert.deepEqual(
			{ ...parseEnv(await readFile(env, 'utf8')) },
			{
				BIG_SPENDER_DEVICE_ID: 'desk',
				BIG_SPENDER_INGEST_URL: URL_,
				BIG_SPENDER_INGEST_TOKEN: 'tok-123'
			}
		);
		assert.equal((await stat(env)).mode & 0o777, 0o600);
		assert.doesNotMatch([...out, ...err].join('\n'), /tok-123/);
	});
});

test('the token comes from the environment when set, never from a flag', async () => {
	await withSandbox(async (box) => {
		const viaEnv = harness(box, { env: { BIG_SPENDER_INGEST_TOKEN: 'from-env' } });
		assert.equal(await main(['install', '--device', 'desk', '--url', URL_], viaEnv.ctx), 0);
		assert.deepEqual(viaEnv.asked, []);

		const flagged = harness(box);
		assert.equal(await main(['install', '--device', 'desk', '--token', 'nope'], flagged.ctx), 2);
		assert.match(flagged.err.join('\n'), /--token/);
	});
});

test('a bad device id is a usage error and changes nothing', async () => {
	await withSandbox(async (box) => {
		const { ctx, err } = harness(box);
		assert.equal(await main(['install', '--device', 'Not A Slug'], ctx), 2);
		assert.match(err.join('\n'), /lowercase slug/);
		assert.deepEqual(await tree(box.home), {});
	});
});

test('install refuses to migrate while the old collector holds a recent lock', async () => {
	await withSandbox(async (box) => {
		const legacy = await writeLegacy(box);
		await writeFile(join(legacy.cache, 'run.lock'), '1234');
		const before = await tree(box.home);

		const busy = harness(box);
		assert.equal(await main(['install', '--device', 'laptop'], busy.ctx), 2);
		assert.match(busy.err.join('\n'), /old collector is running/);
		assert.deepEqual(await tree(box.home), before);

		const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
		await utimes(join(legacy.cache, 'run.lock'), old, old);
		assert.equal(await main(['install', '--device', 'laptop'], harness(box).ctx), 0);
		assert.equal(
			await readFile(join(box.env.XDG_CACHE_HOME, 'big-spender', 'state.json'), 'utf8'),
			STATE
		);
	});
});

test('once big-spender is installed, its cache is never overwritten by the old one', async () => {
	await withSandbox(async (box) => {
		const legacy = await writeLegacy(box);
		const fresh = join(box.env.XDG_CACHE_HOME, 'big-spender');
		const installed = join(box.home, '.local', 'share', 'big-spender');
		await mkdir(fresh, { recursive: true });
		await mkdir(installed, { recursive: true });
		await writeFile(join(fresh, 'state.json'), 'new state');
		await writeFile(join(installed, 'collector.mjs'), '// installed\n');

		const { ctx, out } = harness(box);
		assert.equal(await main(['install', '--device', 'laptop'], ctx), 0);
		assert.equal(await readFile(join(fresh, 'state.json'), 'utf8'), 'new state');
		assert.equal(await readFile(join(legacy.cache, 'state.json'), 'utf8'), STATE);
		assert.ok(out.some((l) => l.includes('left') && l.includes('in place')));
	});
});

test('a cache that status or push --dry-run made before the first install is set aside, not kept over the old state', async () => {
	await withSandbox(async (box) => {
		const legacy = await writeLegacy(box);
		const cacheRoot = box.env.XDG_CACHE_HOME;
		const fresh = join(cacheRoot, 'big-spender');
		await mkdir(fresh, { recursive: true });
		await writeFile(join(fresh, 'state.json'), 'built from the last 30 days of logs');

		const { ctx, out, err } = harness(box);
		assert.equal(await main(['install', '--device', 'laptop'], ctx), 0, err.join('\n'));

		assert.equal(await readFile(join(fresh, 'state.json'), 'utf8'), STATE);
		assert.equal(await exists(legacy.cache), false);
		const aside = (await readdir(cacheRoot)).filter((n) =>
			n.startsWith('big-spender.pre-install-')
		);
		assert.equal(aside.length, 1);
		assert.equal(
			await readFile(join(cacheRoot, aside[0], 'state.json'), 'utf8'),
			'built from the last 30 days of logs'
		);
		assert.ok(out.some((l) => l.includes(aside[0])));
	});
});

test('a fresh old-collector lock also stops the replacement of a cache made before install', async () => {
	await withSandbox(async (box) => {
		const legacy = await writeLegacy(box);
		const fresh = join(box.env.XDG_CACHE_HOME, 'big-spender');
		await mkdir(fresh, { recursive: true });
		await writeFile(join(fresh, 'state.json'), 'made by status');
		await writeFile(join(legacy.cache, 'run.lock'), '1234');
		const before = await tree(box.home);

		const busy = harness(box);
		assert.equal(await main(['install', '--device', 'laptop'], busy.ctx), 2);
		assert.match(busy.err.join('\n'), /old collector is running/);
		assert.deepEqual(await tree(box.home), before);
	});
});

test('a lock left by a run the old timer started while install was stopping it does not block the new collector', async () => {
	await withSandbox(async (box) => {
		const legacy = await writeLegacy(box);
		const lock = join(legacy.cache, 'run.lock');
		const ctl: Ctl = async (_cmd, args) => {
			if (args.includes('disable') && args.includes('usage-collector.timer')) {
				await writeFile(lock, '4321');
			}
		};

		const { ctx, err } = harness(box, { ctl });
		assert.equal(await main(['install', '--device', 'laptop'], ctx), 0, err.join('\n'));

		const cache = join(box.env.XDG_CACHE_HOME, 'big-spender');
		assert.equal(await readFile(join(cache, 'state.json'), 'utf8'), STATE);
		assert.equal(await exists(join(cache, 'run.lock')), false);
	});
});

test('macOS: old launch agents are removed, unrelated ones are kept, the new one is written', async () => {
	await withSandbox(async (box) => {
		const agents = join(box.home, 'Library', 'LaunchAgents');
		await mkdir(agents, { recursive: true });
		const ours = `<string>${box.home}/.local/share/usage-collector/collector.mjs</string>`;
		await writeFile(join(agents, 'local.usage-collector.plist'), ours);
		await writeFile(join(agents, 'com.example.usage-collector.plist'), ours);
		await writeFile(
			join(agents, 'com.other.usage-collector.plist'),
			'<string>/opt/other-tool</string>'
		);
		await writeFile(join(agents, 'com.example.unrelated.plist'), ours);

		const { ctx, err } = harness(box, { answers: [URL_, 'tok'], platform: 'darwin' });
		assert.equal(await main(['install', '--device', 'mac'], ctx), 0, err.join('\n'));

		assert.equal(await exists(join(agents, 'local.usage-collector.plist')), false);
		assert.equal(await exists(join(agents, 'com.example.usage-collector.plist')), false);
		assert.equal(await exists(join(agents, 'com.other.usage-collector.plist')), true);
		assert.equal(await exists(join(agents, 'com.example.unrelated.plist')), true);

		const plist = await readFile(join(agents, 'local.big-spender.plist'), 'utf8');
		assert.match(plist, /<string>local\.big-spender<\/string>/);
		assert.ok(plist.includes(`${box.home}/.local/share/big-spender/collector.mjs`));
		assert.ok(plist.includes(`${box.home}/Library/Logs/big-spender.log`));
		assert.doesNotMatch(plist, /__HOME__|__NODE__/);
	});
});

test('uninstall removes the schedule and keeps env and state', async () => {
	await withSandbox(async (box) => {
		await writeLegacy(box);
		assert.equal(await main(['install', '--device', 'laptop'], harness(box).ctx), 0);

		const { ctx } = harness(box);
		assert.equal(await main(['uninstall'], ctx), 0);
		const units = join(box.env.XDG_CONFIG_HOME, 'systemd', 'user');
		assert.equal(await exists(join(units, 'big-spender.service')), false);
		assert.equal(await exists(join(units, 'big-spender.timer')), false);
		assert.equal(await exists(join(box.env.XDG_CONFIG_HOME, 'big-spender', 'env')), true);
		assert.equal(await exists(join(box.env.XDG_CACHE_HOME, 'big-spender', 'state.json')), true);
	});
});

test('env helpers: rename keeps values and other lines, upsert edits in place', () => {
	assert.equal(renameLegacyKeys(LEGACY_ENV).includes('USAGE_'), false);
	assert.equal(
		renameLegacyKeys('USAGE_INGEST_URL=old\nBIG_SPENDER_INGEST_URL=new\n'),
		'USAGE_INGEST_URL=old\nBIG_SPENDER_INGEST_URL=new\n'
	);
	assert.equal(upsertEnv('# c\nA=1\nB=2', { A: 'x', C: '3' }), '# c\nA=x\nB=2\nC=3\n');
});

test('--device with a different id than the migrated one is refused unless --rename is passed', async () => {
	await withSandbox(async (box) => {
		await writeLegacy(box);
		const before = await tree(box.home);

		const refused = harness(box);
		assert.equal(await main(['install', '--device', 'desktop'], refused.ctx), 2);
		const message = refused.err.join('\n');
		assert.match(message, /"laptop"/);
		assert.match(message, /"desktop"/);
		assert.match(message, /twice/);
		assert.deepEqual(await tree(box.home), before);

		const renamed = harness(box);
		assert.equal(
			await main(['install', '--device', 'desktop', '--rename'], renamed.ctx),
			0,
			renamed.err.join('\n')
		);
		const env = parseEnv(
			await readFile(join(box.env.XDG_CONFIG_HOME, 'big-spender', 'env'), 'utf8')
		);
		assert.equal(env.BIG_SPENDER_DEVICE_ID, 'desktop');
	});
});

test('an old cache with no schedule left only replaces the current one when its state is newer', async () => {
	const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
	const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
	const setUp = async (
		box: Sandbox,
		{ scheduled, legacyAt }: { scheduled: boolean; legacyAt: Date }
	) => {
		const legacy = await writeLegacy(box);
		if (!scheduled) {
			for (const unit of ['usage-collector.service', 'usage-collector.timer']) {
				await rm(join(legacy.units, unit));
			}
		}
		await utimes(join(legacy.cache, 'state.json'), legacyAt, legacyAt);
		const fresh = join(box.env.XDG_CACHE_HOME, 'big-spender');
		await mkdir(fresh, { recursive: true });
		await writeFile(join(fresh, 'state.json'), 'kept by big-spender push');
		await utimes(join(fresh, 'state.json'), hourAgo, hourAgo);
		return { legacy, state: join(fresh, 'state.json') };
	};

	await withSandbox(async (box) => {
		const { legacy, state } = await setUp(box, { scheduled: false, legacyAt: dayAgo });
		const { ctx, out, err } = harness(box);
		assert.equal(await main(['install', '--device', 'laptop'], ctx), 0, err.join('\n'));
		assert.equal(await readFile(state, 'utf8'), 'kept by big-spender push');
		assert.equal(await readFile(join(legacy.cache, 'state.json'), 'utf8'), STATE);
		assert.ok(
			out.some((l) => l.includes(legacy.cache) && l.includes('older')),
			out.join('\n')
		);
	});

	await withSandbox(async (box) => {
		const { state } = await setUp(box, { scheduled: true, legacyAt: dayAgo });
		assert.equal(await main(['install', '--device', 'laptop'], harness(box).ctx), 0);
		assert.equal(await readFile(state, 'utf8'), STATE);
	});

	await withSandbox(async (box) => {
		const { state } = await setUp(box, { scheduled: false, legacyAt: new Date() });
		assert.equal(await main(['install', '--device', 'laptop'], harness(box).ctx), 0);
		assert.equal(await readFile(state, 'utf8'), STATE);
	});
});

test('a status or push holding the new cache lock stops its replacement and changes nothing', async () => {
	await withSandbox(async (box) => {
		await writeLegacy(box);
		const fresh = join(box.env.XDG_CACHE_HOME, 'big-spender');
		await mkdir(fresh, { recursive: true });
		await writeFile(join(fresh, 'state.json'), 'being written by status');
		await writeFile(join(fresh, 'run.lock'), '5678');
		const before = await tree(box.home);

		const busy = harness(box);
		assert.equal(await main(['install', '--device', 'laptop'], busy.ctx), 2);
		assert.ok(busy.err.join('\n').includes(join(fresh, 'run.lock')), busy.err.join('\n'));
		assert.deepEqual(await tree(box.home), before);
	});
});
