import { execFile } from 'child_process';
import { promisify } from 'util';
import { TextAnchor, ReviewMetadata, decodeReviewMetadata, encodeReviewMetadata, visibleCommentBody } from './review-anchor';
import { withoutGitHubTokenEnvironment } from './github-auth';

const execFileAsync = promisify(execFile);

export interface GitHubRepository { owner: string; repo: string }
export interface PullRequestInfo { number: number; url: string; isDraft: boolean; headRefName: string }
export interface GitHubReviewComment {
	id: number;
	url: string;
	author: string;
	createdAt: string;
	body: string;
	metadata: ReviewMetadata;
}

export function parseGitHubRepository(remote: string): GitHubRepository {
	const normalized = remote.trim().replace(/\.git$/, '');
	const ssh = normalized.match(/^(?:ssh:\/\/)?git@github\.com(?::|\/)([^/]+)\/([^/]+)$/i);
	const https = normalized.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/i);
	const match = ssh ?? https;
	if (!match) throw new Error('Review comments currently require a github.com repository URL.');
	return { owner: match[1], repo: match[2] };
}

export type GitHubRunner = (args: string[]) => Promise<string>;

export class GitHubReviewClient {
	constructor(private readonly executable = 'gh', private readonly runner?: GitHubRunner) {}

	private async run(args: string[]): Promise<string> {
		if (this.runner) return this.runner(args);
		try {
			const { stdout } = await execFileAsync(this.executable, args, {
				timeout: 30000,
				maxBuffer: 2 * 1024 * 1024,
				windowsHide: true,
				env: withoutGitHubTokenEnvironment(process.env),
			});
			return stdout;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (/ENOENT|not found/i.test(message)) throw new Error('Install the GitHub CLI (gh) to use review comments.');
			throw new Error(message
				.replace(/\b(?:ghp|github_pat|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{10,}\b/g, '[REDACTED]')
				.replace(/(https?:\/\/)[^/@\s]+@/gi, '$1[REDACTED]@'));
		}
	}

	async assertAuthenticated(): Promise<void> {
		await this.run(['auth', 'status', '--active', '--hostname', 'github.com']);
	}

	async ensureDraftPR(repository: GitHubRepository, head: string, base: string, title?: string): Promise<PullRequestInfo> {
		const fullRepo = `${repository.owner}/${repository.repo}`;
		const existing = JSON.parse(await this.run([
			'pr', 'list', '--repo', fullRepo, '--head', head, '--base', base, '--state', 'open',
			'--json', 'number,url,isDraft,headRefName', '--limit', '1',
		])) as PullRequestInfo[];
		if (existing[0]) return existing[0];
		await this.run([
			'pr', 'create', '--repo', fullRepo, '--draft', '--base', base, '--head', head,
			'--title', title || `Docs: ${head}`, '--body', 'Documentation review created by Obsidian GitHub Sync.',
		]);
		const created = JSON.parse(await this.run([
			'pr', 'list', '--repo', fullRepo, '--head', head, '--base', base, '--state', 'open',
			'--json', 'number,url,isDraft,headRefName', '--limit', '1',
		])) as PullRequestInfo[];
		if (!created[0]) throw new Error('GitHub created the pull request, but it could not be loaded.');
		return created[0];
	}

	async listCollaborators(repository: GitHubRepository): Promise<string[]> {
		const data = await this.run([
			'api', `repos/${repository.owner}/${repository.repo}/collaborators?per_page=100`, '--paginate', '--jq', '.[].login',
		]).catch(() => '');
		return data.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
	}

	async listComments(repository: GitHubRepository, pullNumber: number): Promise<GitHubReviewComment[]> {
		const raw = await this.run([
			'api', `repos/${repository.owner}/${repository.repo}/issues/${pullNumber}/comments?per_page=100`,
			'--paginate', '--slurp',
		]);
		const pages = JSON.parse(raw) as Array<Array<{ id: number; html_url: string; user?: { login?: string }; created_at: string; body: string }>>;
		const comments = pages.reduce((all, page) => all.concat(page), []);
		return comments.flatMap((comment) => {
			const metadata = decodeReviewMetadata(comment.body || '');
			return metadata ? [{
				id: comment.id,
				url: comment.html_url,
				author: comment.user?.login || 'unknown',
				createdAt: comment.created_at,
				body: visibleCommentBody(comment.body || ''),
				metadata,
			}] : [];
		});
	}

	async createComment(repository: GitHubRepository, pullNumber: number, anchor: TextAnchor, body: string, parentId?: number): Promise<void> {
		const trimmed = body.trim();
		if (!trimmed) throw new Error('Write a comment before posting.');
		if (trimmed.length > 20000) throw new Error('The comment is too long.');
		const threadId = parentId ? `reply-${parentId}-${Date.now()}` : `${anchor.fingerprint}-${Date.now()}`;
		const metadata: ReviewMetadata = { version: 1, threadId, anchor, state: 'open', parentId };
		const quote = anchor.selectedText.split(/\r?\n/).slice(0, 12).map((line) => `> ${line}`).join('\n');
		const visible = parentId ? trimmed : `${quote}\n\n${trimmed}`;
		await this.run([
			'api', '--method', 'POST', `repos/${repository.owner}/${repository.repo}/issues/${pullNumber}/comments`,
			'-f', `body=${visible}\n\n${encodeReviewMetadata(metadata)}`,
		]);
	}

	async setResolved(repository: GitHubRepository, pullNumber: number, comment: GitHubReviewComment, resolved: boolean): Promise<void> {
		const metadata = { ...comment.metadata, state: resolved ? 'resolved' as const : 'open' as const };
		await this.run([
			'api', '--method', 'PATCH', `repos/${repository.owner}/${repository.repo}/issues/comments/${comment.id}`,
			'-f', `body=${comment.body}\n\n${encodeReviewMetadata(metadata)}`,
		]);
	}
}
