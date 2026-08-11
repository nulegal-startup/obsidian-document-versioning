import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

await mkdir('.test-build', { recursive: true });
await build({ entryPoints: ['start-change.ts'], bundle: true, format: 'esm', platform: 'node', outfile: '.test-build/start-change.mjs' });
const startChange = await import(`${pathToFileURL(`${process.cwd()}/.test-build/start-change.mjs`).href}?${Date.now()}`);

test('creates a review-ready lifecycle commit without changing document files', async () => {
	const calls = [];
	await startChange.createReviewReadyCommit({
		raw: async (args) => {
			calls.push(args);
			return args[0] === 'rev-list' ? '0\n' : '';
		},
	}, 'main', 'changes/sprint-12-billing');

	assert.deepEqual(calls, [
		['rev-list', '--count', 'main..changes/sprint-12-billing'],
		['commit', '--allow-empty', '-m', 'docs: start changes/sprint-12-billing'],
	]);
});

test('keeps an existing document commit as the review-ready branch difference', async () => {
	const calls = [];
	await startChange.createReviewReadyCommit({
		raw: async (args) => {
			calls.push(args);
			return '1\n';
		},
	}, 'main', 'changes/with-edits');

	assert.deepEqual(calls, [
		['rev-list', '--count', 'main..changes/with-edits'],
	]);
});

test('repairs a legacy empty branch even when the accepted branch has advanced', async () => {
	const calls = [];
	await startChange.createReviewReadyCommit({
		raw: async (args) => { calls.push(args); return args[0] === 'rev-list' ? '0\n' : ''; },
	}, 'main', 'changes/legacy-empty');
	assert.equal(calls.some((args) => args.includes('--allow-empty')), true);
});

test('rejects an unsafe branch name before creating the lifecycle commit', async () => {
	await assert.rejects(
		startChange.createReviewReadyCommit({ raw: async () => '' }, 'main', 'changes/test\nmalicious'),
		/invalid/i,
	);
});
