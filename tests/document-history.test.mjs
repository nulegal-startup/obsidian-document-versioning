import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

await mkdir('.test-build', { recursive: true });
await build({
	entryPoints: ['document-history.ts'],
	bundle: true,
	format: 'esm',
	platform: 'node',
	outfile: '.test-build/document-history.mjs',
});
const history = await import(`${pathToFileURL(`${process.cwd()}/.test-build/document-history.mjs`).href}?${Date.now()}`);
const execFileAsync = promisify(execFile);

function createGit(responses) {
	const calls = [];
	return {
		calls,
		async raw(args) {
			calls.push(args);
			const key = args.join(' ');
			const response = responses.get(key);
			if (response instanceof Error) throw response;
			if (response === undefined) throw new Error(`Unexpected Git call: ${key}`);
			return response;
		},
	};
}

test('loads local changes and committed versions without any network operation', async () => {
	const hash = 'a'.repeat(40);
	const remoteHash = 'b'.repeat(40);
	const log = [
		`\u001e${hash}\x00Ada Lovelace\x002026-08-11T09:30:00+02:00\x00Clarify rollout\x00`,
		`\u001e${remoteHash}\x00Grace Hopper\x002026-08-10T10:00:00+02:00\x00Initial plan\x00`,
	].join('');
	const responses = new Map([
		['rev-parse --abbrev-ref HEAD', 'changes/sprint-2\n'],
		['status --porcelain=v1 -z --untracked-files=all', ' M docs/Plan One.md\0'],
		['rev-parse --verify HEAD', `${hash}\n`],
		['cat-file -s HEAD:docs/Plan One.md', '100\n'],
		['--literal-pathspecs diff --numstat -z --no-ext-diff --no-textconv HEAD -- docs/Plan One.md', '1\t1\tdocs/Plan One.md\0'],
		['--literal-pathspecs diff --no-color --no-ext-diff --no-textconv --find-renames --unified=3 HEAD -- docs/Plan One.md', 'diff --git a/docs/Plan One.md b/docs/Plan One.md\n@@ -1 +1 @@\n-old\n+new\n'],
		['rev-list --max-count 200 HEAD --not --remotes=origin', `${hash}\n`],
		['--literal-pathspecs log --no-color --no-ext-diff --no-textconv -n 50 --format=%x1e%H%x00%an%x00%aI%x00%s%x00 -z -- docs/Plan One.md', log],
	]);
	const git = createGit(responses);
	const service = new history.DocumentHistoryService(git);
	const result = await service.load('docs/Plan One.md', '# current\n');

	assert.equal(result.branch, 'changes/sprint-2');
	assert.equal(result.local.state, 'modified');
	assert.equal(result.local.patch.additions, 1);
	assert.equal(result.local.patch.deletions, 1);
	assert.deepEqual(result.versions.map((version) => ({
		hash: version.hash,
		author: version.author,
		subject: version.subject,
		additions: version.additions,
		deletions: version.deletions,
		localOnly: version.localOnly,
	})), [
		{ hash, author: 'Ada Lovelace', subject: 'Clarify rollout', additions: 0, deletions: 0, localOnly: true },
		{ hash: remoteHash, author: 'Grace Hopper', subject: 'Initial plan', additions: 0, deletions: 0, localOnly: false },
	]);
	assert.equal(git.calls.some((args) => ['fetch', 'pull', 'push', 'ls-remote'].includes(args[0])), false);
});

test('follows a committed rename and retains the path needed for older patches', () => {
	const newest = 'c'.repeat(40);
	const renamed = 'd'.repeat(40);
	const oldest = 'e'.repeat(40);
	const raw = [
		`\u001e${newest}\x00Ada\x002026-08-11T09:00:00Z\x00Edit new name\x00\x00\n2\t1\tdocs/New name.md\x00`,
		`\u001e${renamed}\x00Ada\x002026-08-10T09:00:00Z\x00Rename document\x00\x00\n0\t0\t\x00docs/Old name.md\x00docs/New name.md\x00`,
		`\u001e${oldest}\x00Ada\x002026-08-09T09:00:00Z\x00Create document\x00\x00\n5\t0\tdocs/Old name.md\x00`,
	].join('');

	const versions = history.parseDocumentLog(raw, 'docs/New name.md', new Set());
	assert.deepEqual(versions.map((version) => version.path), [
		'docs/New name.md',
		'docs/New name.md',
		'docs/Old name.md',
	]);
	assert.deepEqual(versions.map((version) => [version.additions, version.deletions]), [[2, 1], [0, 0], [5, 0]]);
});

test('creates a bounded added-file preview for an untracked document and supports unborn HEAD', async () => {
	const responses = new Map([
		['rev-parse --abbrev-ref HEAD', 'changes/new-doc\n'],
		['status --porcelain=v1 -z --untracked-files=all', '?? New.md\0'],
		['rev-parse --verify HEAD', new Error('unknown revision')],
	]);
	const git = createGit(responses);
	const service = new history.DocumentHistoryService(git, { maxPatchLines: 6, maxPatchBytes: 1000 });
	const result = await service.load('New.md', 'one\ntwo\nthree\nfour\nfive\n');

	assert.equal(result.local.state, 'untracked');
	assert.equal(result.local.patch.additions, 5);
	assert.equal(result.local.patch.truncated, true);
	assert.deepEqual(result.versions, []);
});

test('does not render bytes from a new binary file', async () => {
	const responses = new Map([
		['rev-parse --abbrev-ref HEAD', 'changes/new-media\n'],
		['status --porcelain=v1 -z --untracked-files=all', '?? media/diagram.png\0'],
		['rev-parse --verify HEAD', new Error('unknown revision')],
	]);
	const result = await new history.DocumentHistoryService(createGit(responses))
		.load('media/diagram.png', '\u0089PNG\0binary bytes');

	assert.equal(result.local.patch.binary, true);
	assert.match(result.local.patch.text, /Binary document changed/);
	assert.equal(result.local.patch.text.includes('binary bytes'), false);
});

test('classifies staged, mixed, conflicted, and renamed document states', () => {
	assert.equal(history.classifyDocumentStatus('M  note.md\0'), 'staged');
	assert.equal(history.classifyDocumentStatus('MM note.md\0'), 'staged-and-modified');
	assert.equal(history.classifyDocumentStatus('UU note.md\0'), 'conflicted');
	assert.equal(history.classifyDocumentStatus('R  new.md\0old.md\0'), 'renamed');
	assert.equal(history.classifyDocumentStatus(''), 'clean');
});

test('validates document paths and commit ids before passing values to Git', () => {
	assert.equal(history.validateDocumentPath('Product/Über plan.md'), 'Product/Über plan.md');
	assert.throws(() => history.validateDocumentPath('../secrets.md'), /inside the vault/);
	assert.throws(() => history.validateDocumentPath('/tmp/file.md'), /inside the vault/);
	assert.throws(() => history.validateDocumentPath('bad\nname.md'), /control characters/);
	assert.throws(() => history.validateCommitHash('HEAD'), /commit/);
	assert.equal(history.validateCommitHash('f'.repeat(40)), 'f'.repeat(40));
});

test('loads only the selected document patch and truncates oversized output', async () => {
	const hash = 'f'.repeat(40);
	const path = 'docs/Safe plan.md';
	const patch = ['diff --git a/x b/x', '@@ -1,5 +1,5 @@', '-1', '-2', '-3', '+a', '+b', '+c', ' context'].join('\n');
	const git = createGit(new Map([
		[`cat-file -s ${hash}:${path}`, '100\n'],
		[`cat-file -s ${hash}^:${path}`, '100\n'],
		[`--literal-pathspecs show --numstat -z --format= --find-renames --no-ext-diff --no-textconv ${hash} -- ${path}`, `1\t1\t${path}\0`],
		[`--literal-pathspecs show --format= --find-renames --no-color --no-ext-diff --no-textconv --unified=3 ${hash} -- ${path}`, patch],
	]));
	const service = new history.DocumentHistoryService(git, { maxPatchLines: 5, maxPatchBytes: 1000 });
	const result = await service.loadVersionPatch(hash, path);

	assert.equal(result.truncated, true);
	assert.equal(result.additions, 3);
	assert.equal(result.deletions, 3);
	assert.equal(git.calls.at(-1).at(-2), '--');
});

test('recognizes binary patches without rendering binary contents', () => {
	const result = history.toDocumentPatch('diff --git a/image.png b/image.png\nBinary files a/image.png and b/image.png differ\n');
	assert.equal(result.binary, true);
	assert.equal(result.text.includes('Binary files'), false);
	assert.match(result.text, /Binary document changed/);
});

test('uses the old and new literal paths for an uncommitted rename', async () => {
	const hash = '1'.repeat(40);
	const log = `\u001e${hash}\x00Ada\x002026-08-11T09:00:00Z\x00Original version\x00\x00\n3\t0\tdocs/Old [plan].md\x00`;
	const responses = new Map([
		['rev-parse --abbrev-ref HEAD', 'changes/rename\n'],
		['status --porcelain=v1 -z --untracked-files=all', 'R  docs/New [plan].md\0docs/Old [plan].md\0'],
		['rev-parse --verify HEAD', `${hash}\n`],
		['cat-file -s HEAD:docs/Old [plan].md', '40\n'],
		['show --format= HEAD:docs/Old [plan].md', '# plan\n'],
		['--literal-pathspecs diff --numstat -z --no-ext-diff --no-textconv HEAD -- docs/Old [plan].md docs/New [plan].md', '0\t0\t\0docs/Old [plan].md\0docs/New [plan].md\0'],
		['--literal-pathspecs diff --no-color --no-ext-diff --no-textconv --find-renames --unified=3 HEAD -- docs/Old [plan].md docs/New [plan].md', 'similarity index 100%\nrename from docs/Old [plan].md\nrename to docs/New [plan].md\n'],
		['rev-list --max-count 200 HEAD --not --remotes=origin', ''],
		['--literal-pathspecs log --no-color --no-ext-diff --no-textconv -n 50 --format=%x1e%H%x00%an%x00%aI%x00%s%x00 -z -- docs/Old [plan].md', log],
	]);
	const git = createGit(responses);
	const result = await new history.DocumentHistoryService(git).load('docs/New [plan].md', '# plan\n');

	assert.equal(result.local.state, 'renamed');
	assert.equal(result.versions[0].path, 'docs/Old [plan].md');
	assert.equal(git.calls.some((args) => args.includes('docs/Old [plan].md') && args.includes('docs/New [plan].md')), true);
});

test('preflights oversized tracked changes without generating their patch', async () => {
	const hash = '2'.repeat(40);
	const path = 'Huge.md';
	const responses = new Map([
		['rev-parse --abbrev-ref HEAD', 'main\n'],
		['status --porcelain=v1 -z --untracked-files=all', ' M Huge.md\0'],
		['rev-parse --verify HEAD', `${hash}\n`],
		['cat-file -s HEAD:Huge.md', '500000\n'],
		['--literal-pathspecs diff --numstat -z --no-ext-diff --no-textconv HEAD -- Huge.md', '1\t1\tHuge.md\0'],
		['rev-list --max-count 200 HEAD --not --remotes=origin', ''],
		['--literal-pathspecs log --no-color --no-ext-diff --no-textconv -n 50 --format=%x1e%H%x00%an%x00%aI%x00%s%x00 -z -- Huge.md', ''],
	]);
	const git = createGit(responses);
	const result = await new history.DocumentHistoryService(git, { maxPatchBytes: 1000 }).load(path, 'small\n');

	assert.equal(result.local.patch.truncated, true);
	assert.match(result.local.patch.text, /too large/i);
	assert.equal(git.calls.some((args) => args[1] === 'diff'), false);
});

test('does not turn an unexpected log failure into an empty history', async () => {
	const hash = '3'.repeat(40);
	const responses = new Map([
		['rev-parse --abbrev-ref HEAD', 'main\n'],
		['status --porcelain=v1 -z --untracked-files=all', ''],
		['rev-parse --verify HEAD', `${hash}\n`],
		['rev-list --max-count 200 HEAD --not --remotes=origin', ''],
		['--literal-pathspecs log --no-color --no-ext-diff --no-textconv -n 50 --format=%x1e%H%x00%an%x00%aI%x00%s%x00 -z -- Note.md', new Error('repository read failed')],
	]);
	await assert.rejects(new history.DocumentHistoryService(createGit(responses)).load('Note.md', ''), /repository read failed/);
});

test('accepts SHA-256 Git commit ids', () => {
	assert.equal(history.validateCommitHash('a'.repeat(64)), 'a'.repeat(64));
});

test('real Git preserves staged and committed rename history for a literal filename', async (t) => {
	const directory = await mkdtemp(join(tmpdir(), 'document-history-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const run = async (args) => (await execFileAsync('git', args, {
		cwd: directory,
		encoding: 'utf8',
		env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_LITERAL_PATHSPECS: '1' },
	})).stdout;
	await run(['init', '-b', 'main']);
	await run(['config', 'user.name', 'History Test']);
	await run(['config', 'user.email', 'history@example.com']);
	await writeFile(join(directory, 'Old [plan].md'), '# Plan\nOriginal\n');
	await run(['add', '--', 'Old [plan].md']);
	await run(['commit', '-m', 'Create plan']);
	await rename(join(directory, 'Old [plan].md'), join(directory, 'New [plan].md'));

	const service = new history.DocumentHistoryService({ raw: run });
	const unstaged = await service.load('New [plan].md', '# Plan\nOriginal\n', ['Old [plan].md']);
	assert.equal(unstaged.local.state, 'renamed');
	assert.equal(unstaged.versions[0].path, 'Old [plan].md');
	assert.match(unstaged.local.patch.text, /rename from Old \[plan\]\.md/);
	await writeFile(join(directory, 'New [plan].md'), '# Plan\nRevised after rename\n');
	const editedRename = await service.load('New [plan].md', '# Plan\nRevised after rename\n', ['Old [plan].md']);
	assert.equal(editedRename.local.state, 'renamed');
	assert.equal(editedRename.local.patch.additions, 1);
	assert.equal(editedRename.local.patch.deletions, 1);
	assert.match(editedRename.local.patch.text, /\+Revised after rename/);

	await run(['add', '-A']);
	const staged = await service.load('New [plan].md', '# Plan\nRevised after rename\n', ['Old [plan].md']);
	assert.equal(staged.local.state, 'renamed');
	assert.equal(staged.versions[0].path, 'Old [plan].md');
	assert.match(staged.local.patch.text, /rename from Old \[plan\]\.md/);

	await run(['commit', '-m', 'Rename plan']);
	const discovered = await service.load('New [plan].md', '# Plan\nRevised after rename\n');
	assert.equal(discovered.versions.length, 2);
	assert.equal(discovered.versions[0].previousPath, 'Old [plan].md');
	assert.equal(discovered.versions[1].path, 'Old [plan].md');
	const committed = await service.load('New [plan].md', '# Plan\nRevised after rename\n', ['Old [plan].md']);
	assert.equal(committed.versions[0].previousPath, 'Old [plan].md');
	const patch = await service.loadVersionPatch(
		committed.versions[0].hash,
		committed.versions[0].path,
		committed.versions[0].previousPath,
	);
	assert.match(patch.text, /Old \[plan\]\.md/);
	assert.match(patch.text, /New \[plan\]\.md/);
	assert.match(patch.text, /\+Revised after rename/);
});
