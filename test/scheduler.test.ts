import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { main } from '../src/cli.ts';
import { pickScheduler, type Ctl } from '../src/scheduler.ts';
import { harness, tree, withSandbox } from './helpers.ts';

const exists = (path: string) =>
	access(path).then(
		() => true,
		() => false
	);

/** A systemctl that records every call and fails the ones `failing` matches, even tolerated ones. */
function fakeCtl(failing: (args: string[]) => boolean = () => false) {
	const calls: string[] = [];
	const ctl: Ctl = async (_cmd, args, opts) => {
		calls.push(args.join(' '));
		if (failing(args) && !opts?.tolerate) throw new Error('Failed to connect to bus');
	};
	return { calls, ctl };
}

const NO_BUS = (args: string[]) => args.includes('show-environment');

test('systemd: legacy disable and stop run even with no unit files, and a missing user bus stops before any file is deleted', async () => {
	await withSandbox(async (box) => {
		const { ctx } = harness(box);
		const units = ctx.paths.systemdDir;

		const empty = fakeCtl();
		const none = pickScheduler(ctx.env, 'linux', ctx.paths, ctx.templatesDir, empty.ctl);
		assert.deepEqual(await none.removeLegacy(), []);
		assert.deepEqual(empty.calls, [
			'--user disable --now usage-collector.timer',
			'--user stop usage-collector.service'
		]);

		await mkdir(units, { recursive: true });
		const timer = join(units, 'usage-collector.timer');
		await writeFile(timer, '[Timer]\n');
		const noBus = fakeCtl(NO_BUS);
		const stuck = pickScheduler(ctx.env, 'linux', ctx.paths, ctx.templatesDir, noBus.ctl);
		await assert.rejects(stuck.removeLegacy(), /loginctl enable-linger/);
		assert.equal(await exists(timer), true);
		assert.equal(noBus.calls.includes('--user daemon-reload'), false);
	});
});

test('install checks for a systemd user manager first and changes nothing when there is none', async () => {
	await withSandbox(async (box) => {
		await mkdir(join(box.env.XDG_CONFIG_HOME, 'systemd', 'user'), { recursive: true });
		const { ctl, calls } = fakeCtl(NO_BUS);
		const { ctx, err } = harness(box, { answers: ['https://example.com/ingest', 'tok'], ctl });
		const before = await tree(box.home);

		assert.equal(await main(['install', '--device', 'laptop'], ctx), 2);
		assert.match(err.join('\n'), /loginctl enable-linger/);
		assert.deepEqual(await tree(box.home), before);
		assert.deepEqual(calls, ['--user show-environment']);
	});
});
