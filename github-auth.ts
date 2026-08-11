import { execFile } from 'child_process';
import { promisify } from 'util';
import type { GitHubRepository } from './github-review';

const execFileAsync = promisify(execFile);

export type GitHubConnectionProblem =
	| 'missing-helper'
	| 'signed-out'
	| 'no-access'
	| 'offline'
	| 'unknown';

export interface GitHubConnectionError {
	kind: GitHubConnectionProblem;
	message: string;
}

export type GitHubAuthRunner = (args: string[]) => Promise<string>;
export type GitHubCredentialStorage = 'secure' | 'plaintext' | 'unknown';

export interface GitHubBrowserConnection {
	login: string;
	storage: GitHubCredentialStorage;
}

export interface GitHubUserIdentity {
	login: string;
	id: number;
	name: string;
	email: string;
}

export function withoutGitHubTokenEnvironment(
	source: Record<string, string | undefined>,
): Record<string, string | undefined> {
	const clean = { ...source };
	for (const name of [
		'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN',
		'GH_PROMPT_DISABLED', 'GH_DEBUG', 'GH_TRACE',
	]) {
		delete clean[name];
	}
	return clean;
}

export function credentialStorageFromLoginOutput(output: string): GitHubCredentialStorage {
	if (/plain[ -]?text|hosts\.yml/i.test(output)) return 'plaintext';
	if (/keychain|keyring|credential store/i.test(output)) return 'secure';
	return 'unknown';
}

function safeErrorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message
		.replace(/\b(?:ghp|github_pat|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{10,}\b/g, '[REDACTED]')
		.replace(/(https?:\/\/)[^/@\s]+@/gi, '$1[REDACTED]@');
}

export function classifyGitHubConnectionError(error: unknown): GitHubConnectionError {
	const message = safeErrorMessage(error);
	if (/\bENOENT\b|command not found|GitHub CLI.+not installed|Install the GitHub CLI/i.test(message)) {
		return { kind: 'missing-helper', message: 'The GitHub connection helper is not installed yet.' };
	}
	if (/not logged (?:in|into)|token.+invalid|bad credentials|HTTP\s*401|authentication failed/i.test(message)) {
		return { kind: 'signed-out', message: 'Your GitHub connection expired or was revoked. Connect again in the browser.' };
	}
	if (/HTTP\s*(?:403|404)|not found|SAML|organization.+approv|resource not accessible|permission|could not resolve to a repository/i.test(message)) {
		return { kind: 'no-access', message: 'This GitHub account does not currently have access to the private documentation repository.' };
	}
	if (/no such host|lookup api\.github\.com|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|timed? out|TLS handshake timeout|(?:error|failed) connecting to api\.github\.com|check your internet connection|could not resolve (?:host|api\.github\.com)|network|connection (?:reset|refused)/i.test(message)) {
		return { kind: 'offline', message: 'GitHub could not be reached. Check the internet connection and try again.' };
	}
	return { kind: 'unknown', message: 'GitHub could not be verified. Check again or reconnect in the browser.' };
}

export function isGitHubCredentialSetupError(error: unknown): boolean {
	const message = safeErrorMessage(error);
	return /could not read (?:Username|Password) for ['"]?https:\/\/github\.com(?:[/'":]|\b)[\s\S]*(?:Device not configured|terminal prompts disabled|No such device or address)/i.test(message)
		|| /authentication failed for ['"]?https:\/\/github\.com(?:\/|['"]|\b)/i.test(message);
}

export function githubHttpsRemote(repository: GitHubRepository): string {
	if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(repository.owner)
		|| !/^[A-Za-z0-9._-]{1,100}$/.test(repository.repo)) {
		throw new Error('The GitHub repository name is invalid.');
	}
	return `https://github.com/${repository.owner}/${repository.repo}.git`;
}

export class GitHubAuthClient {
	private browserStorage: GitHubCredentialStorage = 'unknown';

	constructor(private readonly executable = 'gh', private readonly runner?: GitHubAuthRunner) {}

	private async run(args: string[], timeout = 30000, signal?: AbortSignal): Promise<string> {
		if (this.runner) return this.runner(args);
		try {
			const { stdout, stderr } = await execFileAsync(this.executable, args, {
				timeout,
				maxBuffer: 2 * 1024 * 1024,
				windowsHide: true,
				env: withoutGitHubTokenEnvironment(process.env),
				signal,
			});
			if (args[0] === 'auth' && (args[1] === 'login' || args[1] === 'status')) {
				const detectedStorage = credentialStorageFromLoginOutput(`${stdout}\n${stderr}`);
				if (detectedStorage !== 'unknown') this.browserStorage = detectedStorage;
			}
			return stdout;
		} catch (error) {
			throw new Error(safeErrorMessage(error));
		}
	}

	async authenticatedLogin(): Promise<string> {
		await this.run(['auth', 'status', '--active', '--hostname', 'github.com']);
		const login = (await this.run(['api', 'user', '--jq', '.login'])).trim();
		if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(login)) {
			throw new Error('GitHub returned an invalid account name.');
		}
		return login;
	}

	async assertRepositoryAccess(repository: GitHubRepository): Promise<void> {
		await this.run([
			'repo', 'view', `${repository.owner}/${repository.repo}`,
			'--json', 'nameWithOwner', '--jq', '.nameWithOwner',
		]);
	}

	async authenticatedIdentity(): Promise<GitHubUserIdentity> {
		const raw = await this.run([
			'api', 'user', '--jq', '{login:.login,id:.id,name:(.name // .login),email:(.email // "")}',
		]);
		let identity: Partial<GitHubUserIdentity>;
		try {
			identity = JSON.parse(raw) as Partial<GitHubUserIdentity>;
		} catch {
			throw new Error('GitHub returned an invalid account identity.');
		}
		const login = typeof identity.login === 'string' ? identity.login.trim() : '';
		const name = typeof identity.name === 'string' ? identity.name.trim() : '';
		const email = typeof identity.email === 'string' ? identity.email.trim() : '';
		if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(login)
			|| !Number.isSafeInteger(identity.id) || Number(identity.id) <= 0
			|| !name || name.length > 200 || /[\r\n\0]/.test(name)
			|| email.length > 320 || /[\r\n\0]/.test(email)) {
			throw new Error('GitHub returned an invalid account identity.');
		}
		return { login, id: Number(identity.id), name, email };
	}

	async setupGitCredentialHelper(): Promise<void> {
		await this.run(['config', 'set', 'git_protocol', 'https', '--host', 'github.com']);
		await this.run(['auth', 'setup-git', '--hostname', 'github.com']);
	}

	async connectWithBrowser(signal?: AbortSignal): Promise<GitHubBrowserConnection> {
		await this.run([
			'auth', 'login', '--hostname', 'github.com', '--web', '--clipboard',
			'--git-protocol', 'https', '--skip-ssh-key',
		], 10 * 60 * 1000, signal);
		await this.setupGitCredentialHelper();
		return { login: await this.authenticatedLogin(), storage: this.browserStorage };
	}
}
