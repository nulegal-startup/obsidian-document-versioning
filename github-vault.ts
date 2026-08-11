import type { GitHubRepository } from './github-review';
import { parseGitHubRepository } from './github-review';

export interface GitRemoteReferences {
	name: string;
	refs: { fetch: string; push: string };
}

export interface GitOriginReader {
	raw(args: string[]): Promise<string>;
	getRemotes(verbose: true): Promise<GitRemoteReferences[]>;
}

export interface GitOriginConfigurator extends GitOriginReader {
	remote(args: string[]): Promise<unknown>;
}

export interface MatchingGitHubOrigin {
	fetch: string;
	push: string;
}

const GITHUB_CLI_CREDENTIAL_HELPER = /^\s*!\s*(?:"[^"\r\n]*[/\\]gh(?:\.exe)?"|'[^'\r\n]*[/\\]gh(?:\.exe)?'|(?:[^\s'"]*[/\\])?gh(?:\.exe)?)\s+auth\s+git-credential(?:\s|$)/i;

export async function hasEffectiveGitHubCredentialHelper(git: Pick<GitOriginReader, 'raw'>): Promise<boolean> {
	let output: string;
	try {
		output = await git.raw(['config', '--get-urlmatch', 'credential.helper', 'https://github.com/']);
	} catch {
		return false;
	}
	return output.split(/\r?\n/).some((line) => GITHUB_CLI_CREDENTIAL_HELPER.test(line));
}

function sameRepository(actual: GitHubRepository, expected: GitHubRepository): boolean {
	return actual.owner === expected.owner && actual.repo === expected.repo;
}

export async function requireMatchingGitHubOrigin(
	git: GitOriginReader,
	expected: GitHubRepository,
): Promise<MatchingGitHubOrigin> {
	const insideWorktree = (await git.raw(['rev-parse', '--is-inside-work-tree'])).trim();
	if (insideWorktree !== 'true') throw new Error('The open folder is not a Git worktree.');

	const origin = (await git.getRemotes(true)).find((remote) => remote.name === 'origin');
	const fetch = (origin?.refs.fetch ?? '').trim();
	const push = (origin?.refs.push ?? '').trim();
	if (!fetch || !push) throw new Error('The documentation vault has no origin remote.');

	let fetchRepository: GitHubRepository;
	let pushRepository: GitHubRepository;
	try {
		fetchRepository = parseGitHubRepository(fetch);
	} catch {
		throw new Error('The open folder points to another GitHub repository.');
	}
	try {
		pushRepository = parseGitHubRepository(push);
	} catch {
		throw new Error('The open folder pushes to another GitHub repository.');
	}
	if (!sameRepository(fetchRepository, expected)) {
		throw new Error('The open folder points to another GitHub repository.');
	}
	if (!sameRepository(pushRepository, expected)) {
		throw new Error('The open folder pushes to another GitHub repository.');
	}
	return { fetch, push };
}

export async function configureMatchingGitHubOrigin(
	git: GitOriginConfigurator,
	expected: GitHubRepository,
	canonicalRemote: string,
): Promise<void> {
	await requireMatchingGitHubOrigin(git, expected);
	await git.remote(['set-url', 'origin', canonicalRemote]);
	await git.remote(['set-url', '--push', 'origin', canonicalRemote]);
}
