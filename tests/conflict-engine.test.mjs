import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

await mkdir('.test-build', { recursive: true });
await build({
	entryPoints: ['conflict-engine.ts'],
	bundle: true,
	format: 'esm',
	platform: 'node',
	outfile: '.test-build/conflict-engine.mjs',
});

const engine = await import(`${pathToFileURL(`${process.cwd()}/.test-build/conflict-engine.mjs`).href}?${Date.now()}`);

const multiConflict = [
	'# Billing',
	'Context before.',
	'<<<<<<< HEAD',
	'Email and Slack are supported.',
	'||||||| base',
	'Email is supported.',
	'=======',
	'Email and Teams are supported.',
	'>>>>>>> origin/changes/sprint-2',
	'Context between.',
	'<<<<<<< HEAD',
	'Current ending.',
	'=======',
	'Incoming ending.',
	'>>>>>>> origin/changes/sprint-2',
	'Context after.',
	'',
].join('\n');

test('parses exact conflict hunks, labels, base text, and source ranges', () => {
	const document = engine.parseConflictDocument(multiConflict);
	assert.equal(document.hunks.length, 2);
	assert.equal(document.newline, '\n');
	assert.deepEqual(document.hunks[0], {
		id: document.hunks[0].id,
		index: 0,
		from: multiConflict.indexOf('<<<<<<< HEAD'),
		to: multiConflict.indexOf('Context between.'),
		startLine: 2,
		endLine: 8,
		currentLabel: 'HEAD',
		incomingLabel: 'origin/changes/sprint-2',
		current: 'Email and Slack are supported.\n',
		base: 'Email is supported.\n',
		incoming: 'Email and Teams are supported.\n',
	});
	assert.equal(multiConflict.slice(document.hunks[0].from, document.hunks[0].to).startsWith('<<<<<<< HEAD'), true);
});

test('resolves one hunk without changing the other hunk', () => {
	const resolved = engine.resolveConflictHunk(multiConflict, 0, 'current');
	assert.equal(resolved.includes('Email and Slack are supported.'), true);
	assert.equal(resolved.includes('Email and Teams are supported.'), false);
	assert.equal(engine.parseConflictDocument(resolved).hunks.length, 1);
	assert.equal(resolved.includes('Current ending.'), true);
	assert.equal(resolved.includes('Incoming ending.'), true);
});

test('supports incoming, both, and custom per-hunk resolutions', () => {
	const incoming = engine.resolveConflictHunk(multiConflict, 0, 'incoming');
	assert.equal(incoming.includes('Email and Teams are supported.'), true);
	assert.equal(incoming.includes('Email and Slack are supported.'), false);

	const both = engine.resolveConflictHunk(multiConflict, 0, 'both');
	assert.match(both, /Email and Slack are supported\.\nEmail and Teams are supported\./);

	const custom = engine.resolveConflictHunk(multiConflict, 0, 'custom', 'Email, Slack, and Teams are supported.\n');
	assert.equal(custom.includes('Email, Slack, and Teams are supported.'), true);
});

test('extracts bounded surrounding context without conflict markers', () => {
	const hunk = engine.parseConflictDocument(multiConflict).hunks[0];
	assert.deepEqual(engine.extractConflictContext(multiConflict, hunk, 1), {
		before: 'Context before.\n',
		after: 'Context between.\n',
	});
});

test('preserves CRLF endings when combining both versions', () => {
	assert.equal(engine.combineConflictVersions('Current\r\n', 'Incoming\r\n', '\r\n'), 'Current\r\nIncoming\r\n');
});

test('rejects malformed conflict markers', () => {
	assert.throws(() => engine.parseConflictDocument('<<<<<<< HEAD\nIncomplete\n'));
});
