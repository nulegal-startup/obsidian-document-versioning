import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

await mkdir('.test-build', { recursive: true });
await build({ entryPoints: ['review-mention.ts'], bundle: true, format: 'esm', platform: 'node', outfile: '.test-build/review-mention.mjs' });
const mentions = await import(`${pathToFileURL(`${process.cwd()}/.test-build/review-mention.mjs`).href}?${Date.now()}`);

test('opens autocomplete for a bare @ and filters as the user types', () => {
	assert.deepEqual(mentions.mentionQueryAt('Please ask @', 12), { start: 11, end: 12, query: '' });
	assert.deepEqual(mentions.mentionQueryAt('Please ask @ka', 14), { start: 11, end: 14, query: 'ka' });
	assert.deepEqual(mentions.matchingMentions(['marvin', 'kaganuk', 'Kara'], 'ka'), ['kaganuk', 'Kara']);
});

test('does not trigger autocomplete in email addresses or completed prose', () => {
	assert.equal(mentions.mentionQueryAt('mail@example.com', 16), undefined);
	assert.equal(mentions.mentionQueryAt('ask @kaganuk please', 19), undefined);
});

test('inserts the selected GitHub user and returns the next cursor position', () => {
	const text = 'Review with @ka tomorrow';
	const query = mentions.mentionQueryAt(text, 15);
	assert.deepEqual(mentions.applyMention(text, query, 'kaganuk'), {
		text: 'Review with @kaganuk tomorrow',
		cursor: 20,
	});
});
