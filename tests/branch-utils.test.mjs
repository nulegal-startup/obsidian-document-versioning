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

test('builds complete current and incoming documents from Git conflict markers', () => {
	const conflict = [
		'# Shared title',
		'<<<<<<< HEAD',
		'Current paragraph',
		'=======',
		'Incoming paragraph',
		'>>>>>>> origin/changes/example',
		'',
		'Common ending',
		'<<<<<<< HEAD',
		'Current final line',
		'=======',
		'Incoming final line',
		'>>>>>>> origin/changes/example',
		'',
	].join('\n');

	assert.deepEqual(helpers.parseGitConflict(conflict), {
		current: '# Shared title\nCurrent paragraph\n\nCommon ending\nCurrent final line\n',
		incoming: '# Shared title\nIncoming paragraph\n\nCommon ending\nIncoming final line\n',
		conflictCount: 2,
	});
});

test('rejects malformed or marker-free conflict text', () => {
	assert.throws(() => helpers.parseGitConflict('# No conflict here\n'));
	assert.throws(() => helpers.parseGitConflict('<<<<<<< HEAD\nIncomplete\n'));
});

test('preserves CRLF line endings and ignores the base section in diff3 conflicts', () => {
	const conflict = [
		'Before',
		'<<<<<<< HEAD',
		'Current',
		'||||||| base',
		'Original',
		'=======',
		'Incoming',
		'>>>>>>> origin/changes/example',
		'After',
		'',
	].join('\r\n');

	assert.deepEqual(helpers.parseGitConflict(conflict), {
		current: 'Before\r\nCurrent\r\nAfter\r\n',
		incoming: 'Before\r\nIncoming\r\nAfter\r\n',
		conflictCount: 1,
	});
});
