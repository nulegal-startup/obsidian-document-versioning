import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

await mkdir('.test-build', { recursive: true });
await build({
	entryPoints: ['local-changes.ts'],
	bundle: true,
	format: 'esm',
	platform: 'node',
	outfile: '.test-build/local-changes.mjs',
});
const changes = await import(`${pathToFileURL(`${process.cwd()}/.test-build/local-changes.mjs`).href}?${Date.now()}`);

test('lists every local file change without contacting a remote', async () => {
	const calls = [];
	const git = {
		async raw(args) {
			calls.push(args);
			if (args.join(' ') === 'rev-parse --abbrev-ref HEAD') return 'changes/sprint-4\n';
			if (args.join(' ') === 'status --porcelain=v1 -z --untracked-files=all') {
				return [
					' M docs/Billing Plan.md',
					'?? media/new diagram.png',
					'D  docs/Removed.md',
					'R  docs/New Name.md',
					'docs/Old Name.md',
					'UU docs/Conflict.md',
					'',
				].join('\0');
			}
			throw new Error(`Unexpected Git call: ${args.join(' ')}`);
		},
	};

	const snapshot = await new changes.LocalChangesService(git).load();

	assert.equal(snapshot.branch, 'changes/sprint-4');
	assert.deepEqual(snapshot.changes.map((change) => ({
		path: change.path,
		oldPath: change.oldPath,
		state: change.state,
		untracked: change.untracked,
	})), [
		{ path: 'docs/Billing Plan.md', oldPath: undefined, state: 'modified', untracked: false },
		{ path: 'docs/Conflict.md', oldPath: undefined, state: 'conflicted', untracked: false },
		{ path: 'docs/New Name.md', oldPath: 'docs/Old Name.md', state: 'renamed', untracked: false },
		{ path: 'docs/Removed.md', oldPath: undefined, state: 'deleted', untracked: false },
		{ path: 'media/new diagram.png', oldPath: undefined, state: 'added', untracked: true },
	]);
	assert.equal(calls.some((args) => ['fetch', 'pull', 'push', 'ls-remote'].includes(args[0])), false);
});

test('merges an ordinary unstaged Obsidian rename into one understandable change', () => {
	const parsed = changes.parseLocalChanges(' D docs/Old.md\0?? docs/New.md\0');
	const merged = changes.mergeLocalRenameHints(parsed, { 'docs/New.md': 'docs/Old.md' });

	assert.deepEqual(merged, [{
		path: 'docs/New.md',
		oldPath: 'docs/Old.md',
		state: 'renamed',
		code: 'R ',
		staged: false,
		workingTree: true,
		untracked: false,
	}]);
});

test('builds file-scoped revert plans for tracked, new, deleted, and renamed files', () => {
	assert.deepEqual(changes.createLocalRevertPlan({
		path: 'docs/Plan.md', state: 'modified', code: ' M', staged: false, workingTree: true, untracked: false,
	}), {
		resetPaths: ['docs/Plan.md'],
		removePaths: [],
		restorePaths: ['docs/Plan.md'],
	});
	assert.deepEqual(changes.createLocalRevertPlan({
		path: 'docs/New.md', state: 'added', code: '??', staged: false, workingTree: true, untracked: true,
	}), {
		resetPaths: [],
		removePaths: ['docs/New.md'],
		restorePaths: [],
	});
	assert.deepEqual(changes.createLocalRevertPlan({
		path: 'docs/Added.md', state: 'added', code: 'A ', staged: true, workingTree: false, untracked: false,
	}), {
		resetPaths: ['docs/Added.md'],
		removePaths: ['docs/Added.md'],
		restorePaths: [],
	});
	assert.deepEqual(changes.createLocalRevertPlan({
		path: 'docs/Removed.md', state: 'deleted', code: ' D', staged: false, workingTree: true, untracked: false,
	}), {
		resetPaths: ['docs/Removed.md'],
		removePaths: [],
		restorePaths: ['docs/Removed.md'],
	});
	assert.deepEqual(changes.createLocalRevertPlan({
		path: 'docs/New Name.md', oldPath: 'docs/Old Name.md', state: 'renamed', code: 'R ', staged: true, workingTree: false, untracked: false,
	}), {
		resetPaths: ['docs/Old Name.md', 'docs/New Name.md'],
		removePaths: ['docs/New Name.md'],
		restorePaths: ['docs/Old Name.md'],
	});
});

test('applies a revert plan in a deterministic order and only touches its paths', async () => {
	const calls = [];
	await changes.applyLocalRevert({
		path: 'docs/New Name.md', oldPath: 'docs/Old Name.md', state: 'renamed', code: 'R ', staged: true, workingTree: false, untracked: false,
	}, {
		async raw(args) { calls.push(['git', ...args]); return ''; },
	}, async (path) => { calls.push(['remove', path]); });

	assert.deepEqual(calls, [
		['git', 'reset', '--', 'docs/Old Name.md', 'docs/New Name.md'],
		['remove', 'docs/New Name.md'],
		['git', 'restore', '--source=HEAD', '--worktree', '--', 'docs/Old Name.md'],
	]);
});

test('rejects unsafe status paths before they can reach Git or the vault', () => {
	assert.throws(() => changes.parseLocalChanges(' M ../outside.md\0'), /inside the vault/);
	assert.throws(() => changes.parseLocalChanges('?? bad\nname.md\0'), /control characters/);
});
