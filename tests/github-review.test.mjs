import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

await mkdir('.test-build', { recursive: true });
await build({ entryPoints: ['github-review.ts'], bundle: true, format: 'esm', platform: 'node', outfile: '.test-build/github-review.mjs' });
const github = await import(`${pathToFileURL(`${process.cwd()}/.test-build/github-review.mjs`).href}?${Date.now()}`);

test('parses supported GitHub HTTPS and SSH remotes', () => {
	assert.deepEqual(github.parseGitHubRepository('https://github.com/acme/docs.git'), { owner: 'acme', repo: 'docs' });
	assert.deepEqual(github.parseGitHubRepository('git@github.com:acme/docs.git'), { owner: 'acme', repo: 'docs' });
	assert.throws(() => github.parseGitHubRepository('https://gitlab.com/acme/docs.git'));
});

test('reuses an existing draft PR without creating another', async () => {
	const calls = [];
	const client = new github.GitHubReviewClient('gh', async (args) => {
		calls.push(args);
		return JSON.stringify([{ number: 7, url: 'https://github.com/acme/docs/pull/7', isDraft: true, headRefName: 'changes/a' }]);
	});
	const result = await client.ensureDraftPR({ owner: 'acme', repo: 'docs' }, 'changes/a', 'main');
	assert.equal(result.number, 7);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].includes('create'), false);
});

test('creates a draft PR when none exists', async () => {
	let listCount = 0;
	const calls = [];
	const client = new github.GitHubReviewClient('gh', async (args) => {
		calls.push(args);
		if (args[0] === 'pr' && args[1] === 'list') {
			listCount += 1;
			return listCount === 1 ? '[]' : JSON.stringify([{ number: 8, url: 'url', isDraft: true, headRefName: 'changes/b' }]);
		}
		return 'url';
	});
	const result = await client.ensureDraftPR({ owner: 'acme', repo: 'docs' }, 'changes/b', 'main');
	assert.equal(result.number, 8);
	const create = calls.find((args) => args[0] === 'pr' && args[1] === 'create');
	assert.ok(create.includes('--draft'));
	assert.ok(create.includes('--head'));
});

test('passes comment text as one argument without a shell', async () => {
	const calls = [];
	const client = new github.GitHubReviewClient('gh', async (args) => { calls.push(args); return '{}'; });
	const anchor = { version: 1, path: 'prd.md', selectedText: 'decision', prefix: '', suffix: '', startLine: 2, endLine: 2, fingerprint: 'abc' };
	await client.createComment({ owner: 'acme', repo: 'docs' }, 4, anchor, '@alex please review; $(unsafe)');
	assert.equal(calls[0][0], 'api');
	assert.equal(calls[0].some((value) => value.includes('@alex please review; $(unsafe)')), true);
});

test('slurps paginated review comments into one JSON array', async () => {
	const calls = [];
	const client = new github.GitHubReviewClient('gh', async (args) => { calls.push(args); return '[[],[]]'; });
	assert.deepEqual(await client.listComments({ owner: 'acme', repo: 'docs' }, 4), []);
	assert.equal(calls[0].includes('--paginate'), true);
	assert.equal(calls[0].includes('--slurp'), true);
	assert.equal(calls[0].includes('--jq'), false);
});
