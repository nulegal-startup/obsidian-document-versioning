import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

await mkdir('.test-build', { recursive: true });
await build({
	entryPoints: ['workflow-defaults.ts'],
	bundle: true,
	format: 'esm',
	platform: 'node',
	outfile: '.test-build/workflow-defaults.mjs',
});
const defaults = await import(`${pathToFileURL(`${process.cwd()}/.test-build/workflow-defaults.mjs`).href}?${Date.now()}`);

test('a first run already knows the complete private NuLegal workflow', () => {
	assert.deepEqual(defaults.NULEGAL_WORKFLOW_DEFAULTS, {
		remoteURL: 'https://github.com/nulegal-startup/docs.git',
		baseBranch: 'main',
		branchPrefix: 'changes',
		protectBaseBranch: true,
		autoCreateDraftPR: true,
	});
});

test('an empty legacy repository value is repaired without replacing an explicit repository', () => {
	assert.equal(defaults.withNuLegalRepositoryDefault({ remoteURL: '' }).remoteURL,
		'https://github.com/nulegal-startup/docs.git');
	assert.equal(defaults.withNuLegalRepositoryDefault({ remoteURL: 'https://github.com/acme/other.git' }).remoteURL,
		'https://github.com/acme/other.git');
});
