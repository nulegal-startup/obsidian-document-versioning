import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

await mkdir('.test-build', { recursive: true });
await build({
	entryPoints: ['branch-utils.ts'],
	bundle: true,
	format: 'esm',
	platform: 'node',
	outfile: '.test-build/branch-utils.mjs',
});

const helpers = await import(`${pathToFileURL(`${process.cwd()}/.test-build/branch-utils.mjs`).href}?${Date.now()}`);

test('normalizes a human change title into a safe branch', () => {
	assert.equal(helpers.normalizeBranchName('Next Sprint: Billing & Plans', 'changes'), 'changes/next-sprint-billing-plans');
});

test('rejects an empty change title', () => {
	assert.throws(() => helpers.normalizeBranchName('---', 'changes'));
});

test('accepts standard HTTPS and SSH remotes', () => {
	assert.equal(helpers.validateRemoteUrl('https://github.com/acme/docs.git'), 'https://github.com/acme/docs.git');
	assert.equal(helpers.validateRemoteUrl('git@github.com:acme/docs.git'), 'git@github.com:acme/docs.git');
});

test('rejects embedded credentials and unsafe protocols', () => {
	assert.throws(() => helpers.validateRemoteUrl('https://user:secret@github.com/acme/docs.git'));
	assert.throws(() => helpers.validateRemoteUrl('file:///tmp/repo'));
});

test('redacts common GitHub tokens and URL passwords', () => {
	const redacted = helpers.redactSensitiveText('https://user:secret@github.com/x/y ghp_abcdefghijklmnopqrstuvwxyz');
	assert.equal(redacted.includes('secret'), false);
	assert.equal(redacted.includes('ghp_'), false);
});

test('describes every deterministic branch synchronization state', () => {
	assert.deepEqual(helpers.describeBranchSync(0, 0, true), {
		state: 'up-to-date', label: 'Up to date', compact: '✓',
	});
	assert.deepEqual(helpers.describeBranchSync(0, 3, true), {
		state: 'behind', label: '3 behind', compact: '↓3',
	});
	assert.deepEqual(helpers.describeBranchSync(2, 0, true), {
		state: 'ahead', label: '2 ahead', compact: '↑2',
	});
	assert.deepEqual(helpers.describeBranchSync(2, 3, true), {
		state: 'diverged', label: '2 ahead · 3 behind', compact: '↑2 ↓3',
	});
	assert.deepEqual(helpers.describeBranchSync(0, 0, false), {
		state: 'unpublished', label: 'Not published', compact: 'Local only',
	});
});
