import { isSafeBranchRef } from './branch-utils';

export interface StartChangeGit {
	raw(args: string[]): Promise<string>;
}

export async function createReviewReadyCommit(
	git: StartChangeGit,
	baseBranch: string,
	changeBranch: string,
): Promise<boolean> {
	if (!isSafeBranchRef(baseBranch) || !isSafeBranchRef(changeBranch)) {
		throw new Error('The documentation branch name is invalid.');
	}
	const uniqueCommitCount = (await git.raw(['rev-list', '--count', `${baseBranch}..${changeBranch}`])).trim();
	if (!/^\d+$/.test(uniqueCommitCount) || !Number.isSafeInteger(Number(uniqueCommitCount))) {
		throw new Error('Git returned an invalid branch history.');
	}
	if (Number(uniqueCommitCount) > 0) return false;
	await git.raw(['commit', '--allow-empty', '-m', `docs: start ${changeBranch}`]);
	return true;
}
