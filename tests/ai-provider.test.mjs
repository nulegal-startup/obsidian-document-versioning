import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

await mkdir('.test-build', { recursive: true });
await build({
	entryPoints: ['ai-provider.ts'],
	bundle: true,
	format: 'esm',
	platform: 'node',
	outfile: '.test-build/ai-provider.mjs',
});

const provider = await import(`${pathToFileURL(`${process.cwd()}/.test-build/ai-provider.mjs`).href}?${Date.now()}`);

const hunk = {
	id: 'abc',
	index: 0,
	from: 10,
	to: 50,
	startLine: 2,
	endLine: 8,
	currentLabel: 'HEAD',
	incomingLabel: 'origin/changes/sprint-2',
	current: 'Slack is supported.\n',
	base: 'Email is supported.\n',
	incoming: 'Teams is supported.\n',
};

test('builds a scoped prompt containing only the selected conflict and nearby context', () => {
	const prompt = provider.buildConflictPrompt({
		filePath: 'docs/billing.md',
		branch: 'changes/sprint-2',
		hunk,
		before: '# Billing\n',
		after: 'Next section.\n',
		currentDocument: 'SHOULD NOT BE SENT',
	});
	assert.match(prompt, /Slack is supported/);
	assert.match(prompt, /Teams is supported/);
	assert.match(prompt, /BEGIN_UNTRUSTED_DOCUMENT_DATA/);
	assert.match(prompt, /contextBefore.*# Billing/);
	assert.doesNotMatch(prompt, /SHOULD NOT BE SENT/);
});

test('accepts a structured reviewable suggestion', () => {
	assert.deepEqual(provider.parseConflictSuggestion(JSON.stringify({
		resolvedText: 'Slack and Teams are supported.\n',
		explanation: 'Combines compatible channel support.',
		assumptions: ['Both statements remain valid.'],
	})), {
		resolvedText: 'Slack and Teams are supported.\n',
		explanation: 'Combines compatible channel support.',
		assumptions: ['Both statements remain valid.'],
	});
});

test('rejects malformed output and suggestions that retain conflict markers', () => {
	assert.throws(() => provider.parseConflictSuggestion('not json'));
	assert.throws(() => provider.parseConflictSuggestion(JSON.stringify({
		resolvedText: '<<<<<<< HEAD\nunsafe',
		explanation: 'No resolution',
		assumptions: [],
	})));
});
