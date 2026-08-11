import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

await mkdir('.test-build', { recursive: true });
await build({ entryPoints: ['github-auth.ts'], bundle: true, format: 'esm', platform: 'node', outfile: '.test-build/github-auth.mjs' });
const auth = await import(`${pathToFileURL(`${process.cwd()}/.test-build/github-auth.mjs`).href}?${Date.now()}`);

test('connects through the browser with HTTPS and configures the credential helper', async () => {
	const calls = [];
	const client = new auth.GitHubAuthClient('gh', async (args) => {
		calls.push(args);
		return args[0] === 'api' ? 'kaganuk\n' : '';
	});

	assert.deepEqual(await client.connectWithBrowser(), { login: 'kaganuk', storage: 'unknown' });
	assert.deepEqual(calls, [
		['auth', 'login', '--hostname', 'github.com', '--web', '--clipboard', '--git-protocol', 'https', '--skip-ssh-key'],
		['config', 'set', 'git_protocol', 'https', '--host', 'github.com'],
		['auth', 'setup-git', '--hostname', 'github.com'],
		['auth', 'status', '--active', '--hostname', 'github.com'],
		['api', 'user', '--jq', '.login'],
	]);
});

test('repairs an authenticated HTTPS credential helper without starting browser login', async () => {
	const calls = [];
	const client = new auth.GitHubAuthClient('gh', async (args) => { calls.push(args); return ''; });

	await client.setupGitCredentialHelper();

	assert.deepEqual(calls, [
		['config', 'set', 'git_protocol', 'https', '--host', 'github.com'],
		['auth', 'setup-git', '--hostname', 'github.com'],
	]);
	assert.equal(calls.some((args) => args[0] === 'auth' && args[1] === 'login'), false);
});

test('checks authentication without exposing a token', async () => {
	const calls = [];
	const client = new auth.GitHubAuthClient('gh', async (args) => {
		calls.push(args);
		return args[0] === 'api' ? 'alex\n' : '';
	});

	assert.equal(await client.authenticatedLogin(), 'alex');
	assert.equal(calls.flat().includes('--show-token'), false);
	assert.equal(calls.flat().includes('token'), false);
});

test('checks private repository access after authentication', async () => {
	const calls = [];
	const client = new auth.GitHubAuthClient('gh', async (args) => { calls.push(args); return ''; });
	await client.assertRepositoryAccess({ owner: 'nulegal-startup', repo: 'docs' });
	assert.deepEqual(calls, [[
		'repo', 'view', 'nulegal-startup/docs', '--json', 'nameWithOwner', '--jq', '.nameWithOwner',
	]]);
});

test('loads a safe Git author identity without reading a token', async () => {
	const calls = [];
	const client = new auth.GitHubAuthClient('gh', async (args) => {
		calls.push(args);
		return JSON.stringify({ login: 'alex', id: 42, name: 'Alex Example', email: '' });
	});
	assert.deepEqual(await client.authenticatedIdentity(), {
		login: 'alex', id: 42, name: 'Alex Example', email: '',
	});
	assert.equal(calls.flat().includes('--show-token'), false);
});

test('maps common connection failures to non-technical setup states', () => {
	assert.equal(auth.classifyGitHubConnectionError(new Error('spawn gh ENOENT')).kind, 'missing-helper');
	assert.equal(auth.classifyGitHubConnectionError(new Error('The token in keyring is invalid')).kind, 'signed-out');
	assert.equal(auth.classifyGitHubConnectionError(new Error('HTTP 403 Resource protected by organization SAML enforcement')).kind, 'no-access');
	assert.equal(auth.classifyGitHubConnectionError(new Error('HTTP 404 Not Found')).kind, 'no-access');
	assert.equal(auth.classifyGitHubConnectionError(new Error('GraphQL: Could not resolve to a Repository with the name nulegal-startup/docs')).kind, 'no-access');
	assert.equal(auth.classifyGitHubConnectionError(new Error('dial tcp: lookup api.github.com: no such host')).kind, 'offline');
	assert.equal(auth.classifyGitHubConnectionError(new Error('error connecting to api.github.com; check your internet connection')).kind, 'offline');
	assert.equal(auth.classifyGitHubConnectionError(new Error('TLS handshake timeout while connecting to api.github.com')).kind, 'offline');
});

test('recognizes Git HTTPS credential failures that need GitHub setup', () => {
	assert.equal(auth.isGitHubCredentialSetupError(
		new Error("fatal: could not read Username for 'https://github.com': Device not configured"),
	), true);
	assert.equal(auth.isGitHubCredentialSetupError(
		new Error("fatal: could not read Password for 'https://github.com/nulegal-startup/docs.git': terminal prompts disabled"),
	), true);
	assert.equal(auth.isGitHubCredentialSetupError(
		new Error('fatal: unable to access repository: HTTP 500'),
	), false);
});

test('browser authentication ignores temporary token environment variables', () => {
	const clean = auth.withoutGitHubTokenEnvironment({
		PATH: '/usr/bin',
		GH_TOKEN: 'secret-one',
		GITHUB_TOKEN: 'secret-two',
		GH_ENTERPRISE_TOKEN: 'secret-three',
		GITHUB_ENTERPRISE_TOKEN: 'secret-four',
		GIT_PAGER: 'cat',
		PAGER: 'cat',
	});
	assert.deepEqual(clean, { PATH: '/usr/bin' });
});

test('detects GitHub CLI plaintext credential fallback warnings', () => {
	assert.equal(auth.credentialStorageFromLoginOutput('Authentication credentials saved in plain text'), 'plaintext');
	assert.equal(auth.credentialStorageFromLoginOutput('Authentication complete. Stored in the system credential store.'), 'secure');
	assert.equal(auth.credentialStorageFromLoginOutput('Authentication complete.'), 'unknown');
});

test('converts supported GitHub remotes to credential-helper HTTPS', () => {
	assert.equal(auth.githubHttpsRemote({ owner: 'acme', repo: 'docs' }), 'https://github.com/acme/docs.git');
	assert.throws(() => auth.githubHttpsRemote({ owner: 'acme\nmalicious', repo: 'docs' }), /invalid/i);
});
