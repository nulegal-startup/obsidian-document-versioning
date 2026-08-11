import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('uses a private NuLegal plugin identity instead of the upstream community identity', async () => {
	const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
	assert.equal(manifest.id, 'nulegal-document-versioning');
	assert.equal(manifest.name, 'Document Versioning');
	assert.equal(manifest.author, 'NuLegal');
	assert.match(manifest.authorUrl, /nulegal-startup\/obsidian-document-versioning/);
	assert.notEqual(manifest.id, 'github-sync');
});
