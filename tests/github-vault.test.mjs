import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

await mkdir('.test-build', { recursive: true });
await build({ entryPoints: ['github-vault.ts'], bundle: true, format: 'esm', platform: 'node', outfile: '.test-build/github-vault.mjs' });
const vault = await import(`${pathToFileURL(`${process.cwd()}/.test-build/github-vault.mjs`).href}?${Date.now()}`);

function fakeGit({ inside = 'true', fetch, push = fetch } = {}) {
	const mutations = [];
	return {
		mutations,
		raw: async (args) => {
			assert.deepEqual(args, ['rev-parse', '--is-inside-work-tree']);
			return `${inside}\n`;
		},
		getRemotes: async () => fetch ? [{ name: 'origin', refs: { fetch, push } }] : [],
		remote: async (args) => { mutations.push(args); },
	};
}

const expected = { owner: 'nulegal-startup', repo: 'docs' };

test('accepts matching HTTPS or SSH fetch and push destinations', async () => {
	assert.deepEqual(await vault.requireMatchingGitHubOrigin(fakeGit({
		fetch: 'git@github.com:nulegal-startup/docs.git',
	}), expected), {
		fetch: 'git@github.com:nulegal-startup/docs.git',
		push: 'git@github.com:nulegal-startup/docs.git',
	});
	assert.deepEqual(await vault.requireMatchingGitHubOrigin(fakeGit({
		fetch: 'https://github.com/nulegal-startup/docs.git',
	}), expected), {
		fetch: 'https://github.com/nulegal-startup/docs.git',
		push: 'https://github.com/nulegal-startup/docs.git',
	});
});

test('rejects an unrelated, missing, or non-worktree origin', async () => {
	await assert.rejects(
		vault.requireMatchingGitHubOrigin(fakeGit({ fetch: 'https://github.com/other/private.git' }), expected),
		/another GitHub repository/i,
	);
	await assert.rejects(vault.requireMatchingGitHubOrigin(fakeGit(), expected), /no origin remote/i);
	await assert.rejects(
		vault.requireMatchingGitHubOrigin(fakeGit({ inside: 'false', fetch: 'https://github.com/nulegal-startup/docs.git' }), expected),
		/not a Git worktree/i,
	);
});

test('rejects a foreign explicit push destination even when fetch is correct', async () => {
	const git = fakeGit({
		fetch: 'https://github.com/nulegal-startup/docs.git',
		push: 'https://github.com/attacker/exfiltration.git',
	});
	await assert.rejects(vault.configureMatchingGitHubOrigin(
		git, expected, 'https://github.com/nulegal-startup/docs.git',
	), /pushes to another GitHub repository/i);
	assert.deepEqual(git.mutations, []);
});

test('normalizes both fetch and push only after matching the repository', async () => {
	const git = fakeGit({ fetch: 'git@github.com:nulegal-startup/docs.git' });
	await vault.configureMatchingGitHubOrigin(git, expected, 'https://github.com/nulegal-startup/docs.git');
	assert.deepEqual(git.mutations, [
		['set-url', 'origin', 'https://github.com/nulegal-startup/docs.git'],
		['set-url', '--push', 'origin', 'https://github.com/nulegal-startup/docs.git'],
	]);
});

test('requires the effective GitHub URL helper to use gh auth git-credential', async () => {
	const calls = [];
	const effectiveHelper = async (output) => vault.hasEffectiveGitHubCredentialHelper({
		raw: async (args) => {
			calls.push(args);
			return output;
		},
	});

	assert.equal(await effectiveHelper('osxkeychain\n'), false);
	assert.equal(await effectiveHelper('osxkeychain\n!/opt/homebrew/bin/gh auth git-credential\n'), true);
	assert.equal(await effectiveHelper('manager-core\n!"C:/Program Files/GitHub CLI/gh.exe" auth git-credential\n'), true);
	assert.deepEqual(calls, [
		['config', '--get-urlmatch', 'credential.helper', 'https://github.com/'],
		['config', '--get-urlmatch', 'credential.helper', 'https://github.com/'],
		['config', '--get-urlmatch', 'credential.helper', 'https://github.com/'],
	]);
});
