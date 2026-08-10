import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

await mkdir('.test-build', { recursive: true });
await build({ entryPoints: ['review-anchor.ts'], bundle: true, format: 'esm', platform: 'node', outfile: '.test-build/review-anchor.mjs' });
const review = await import(`${pathToFileURL(`${process.cwd()}/.test-build/review-anchor.mjs`).href}?${Date.now()}`);

test('creates a bounded deterministic anchor and follows inserted text', () => {
	const source = '# PRD\n\nThe billing decision is annual plans.\n\nNext.';
	const from = source.indexOf('billing decision');
	const anchor = review.createTextAnchor(source, from, from + 'billing decision'.length, 'prd.md');
	assert.equal(anchor.startLine, 3);
	assert.equal(anchor.fingerprint, review.createTextAnchor(source, from, from + 'billing decision'.length, 'prd.md').fingerprint);
	const moved = review.reanchorText(`New intro\n${source}`, anchor);
	assert.equal(moved.confidence, 'exact');
	assert.equal(`New intro\n${source}`.slice(moved.from, moved.to), 'billing decision');
});

test('uses context to choose between duplicate selected text', () => {
	const source = 'First decision here.\nSecond decision there.';
	const from = source.lastIndexOf('decision');
	const anchor = review.createTextAnchor(source, from, from + 8, 'prd.md');
	const result = review.reanchorText(`Intro\n${source}`, anchor);
	assert.equal(result.confidence, 'context');
	assert.equal(result.startLine, 3);
});

test('reports deleted text as orphaned', () => {
	const anchor = review.createTextAnchor('Keep this decision', 10, 18, 'prd.md');
	assert.equal(review.reanchorText('Decision removed', anchor).confidence, 'orphaned');
});

test('round trips valid hidden metadata and rejects malformed markers', () => {
	const anchor = review.createTextAnchor('Selected text', 0, 8, 'prd.md');
	const metadata = { version: 1, threadId: 'thread-1', anchor, state: 'open' };
	const body = `Visible comment\n\n${review.encodeReviewMetadata(metadata)}`;
	assert.deepEqual(review.decodeReviewMetadata(body), metadata);
	assert.equal(review.visibleCommentBody(body), 'Visible comment');
	assert.equal(review.decodeReviewMetadata('<!-- obsidian-github-sync-review:not-json -->'), undefined);
	const unsafe = { ...metadata, anchor: { ...anchor, path: '../outside.md' } };
	assert.equal(review.decodeReviewMetadata(review.encodeReviewMetadata(unsafe)), undefined);
});

test('rejects empty selections and oversized selections', () => {
	assert.throws(() => review.createTextAnchor('abc', 1, 1, 'prd.md'));
	assert.throws(() => review.createTextAnchor('x'.repeat(12001), 0, 12001, 'prd.md'));
});
