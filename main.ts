import { App, Editor, FileSystemAdapter, ItemView, MarkdownView, Menu, Modal, Notice, Plugin, PluginSettingTab, Setting, setIcon, WorkspaceLeaf } from 'obsidian';
import { simpleGit, SimpleGit, SimpleGitOptions, StatusResult } from 'simple-git';
import { clearIntervalAsync, setIntervalAsync } from 'set-interval-async';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import {
	BranchSyncSummary,
	describeBranchSync,
	isSafeBranchRef,
	normalizeBranchName,
	redactSensitiveText,
	validateRemoteUrl,
} from './branch-utils';
import { CodexConflictProvider, ConflictAIProvider, ConflictAIRequest, ConflictAISuggestion } from './ai-provider';
import { conflictEditorExtension } from './conflict-editor';
import { ConflictHunk, parseConflictDocument } from './conflict-engine';
import { createTextAnchor, reanchorText, TextAnchor } from './review-anchor';
import { GitHubRepository, GitHubReviewClient, GitHubReviewComment, PullRequestInfo, parseGitHubRepository } from './github-review';

type NoticeLevelSetting = 'ALL' | 'WARNING' | 'ERROR';
type LegacyNoticeLevelSetting = NoticeLevelSetting | 'WARNINGS';
type NoticeSeverity = 'INFO' | 'WARNING' | 'ERROR';

interface GHSyncSettings {
	remoteURL: string;
	gitLocation: string;
	baseBranch: string;
	branchPrefix: string;
	protectBaseBranch: boolean;
	syncinterval: number;
	isSyncOnLoad: boolean;
	checkStatusOnLoad: boolean;
	noticeLevel: NoticeLevelSetting;
	showSyncSuccessNotice: boolean;
	aiProvider: ConflictAIProvider;
	codexExecutable: string;
	aiConsentProvider: ConflictAIProvider;
	githubCliPath: string;
	autoCreateDraftPR: boolean;
}

const DEFAULT_SETTINGS: GHSyncSettings = {
	remoteURL: '',
	gitLocation: '',
	baseBranch: 'main',
	branchPrefix: 'changes',
	protectBaseBranch: true,
	syncinterval: 0,
	isSyncOnLoad: false,
	checkStatusOnLoad: true,
	noticeLevel: 'ALL',
	showSyncSuccessNotice: true,
	aiProvider: 'disabled',
	codexExecutable: '',
	aiConsentProvider: 'disabled',
	githubCliPath: '',
	autoCreateDraftPR: true,
};

const CONFLICT_CENTER_VIEW = 'github-sync-conflict-center';
const REVIEW_CENTER_VIEW = 'github-sync-review-center';

interface ReviewSnapshot {
	repository: GitHubRepository;
	pull: PullRequestInfo;
	comments: GitHubReviewComment[];
}

interface BranchSnapshot {
	current: string;
	base: string;
	branches: string[];
	sync: BranchSyncSummary;
	isClean: boolean;
}

type OperationResult = {
	status: 'success' | 'warning';
	message: string;
};

class GitOperationProgress {
	private readonly notice: Notice;
	private readonly noticeEl: HTMLElement;
	private readonly noticeShellEl: HTMLElement;
	private readonly titleEl: HTMLElement;
	private readonly iconEl: HTMLElement;
	private readonly stepsEl: HTMLElement;
	private activeStepEl?: HTMLElement;
	private finished = false;

	constructor(
		title: string,
		private readonly onStep: (step: string) => void,
		private readonly onFinish: () => void,
	) {
		this.notice = new Notice('', 0);
		this.noticeEl = this.notice.noticeEl;
		this.noticeEl.empty();
		this.noticeEl.addClass('gh-sync-operation__content');
		const noticeShell = this.noticeEl.closest('.notice');
		this.noticeShellEl = noticeShell instanceof HTMLElement ? noticeShell : this.noticeEl;
		this.noticeShellEl.addClass('gh-sync-operation');
		this.noticeShellEl.setAttr('role', 'status');
		this.noticeShellEl.setAttr('aria-live', 'polite');

		const header = this.noticeEl.createDiv({ cls: 'gh-sync-operation__header' });
		this.iconEl = header.createSpan({ cls: 'gh-sync-operation__icon gh-sync-operation__spinner' });
		setIcon(this.iconEl, 'loader-circle');
		this.titleEl = header.createDiv({ cls: 'gh-sync-operation__title', text: title });
		this.stepsEl = this.noticeEl.createDiv({ cls: 'gh-sync-operation__steps' });
		this.noticeEl.createDiv({
			cls: 'gh-sync-operation__hint',
			text: 'Working in the background — keep Obsidian open.',
		});
	}

	step(label: string): void {
		if (this.finished) return;
		if (this.activeStepEl) {
			this.activeStepEl.removeClass('is-active');
			this.activeStepEl.addClass('is-complete');
			const previousIcon = this.activeStepEl.querySelector('.gh-sync-operation__step-icon');
			if (previousIcon instanceof HTMLElement) setIcon(previousIcon, 'check');
		}

		const stepEl = this.stepsEl.createDiv({ cls: 'gh-sync-operation__step is-active' });
		const iconEl = stepEl.createSpan({ cls: 'gh-sync-operation__step-icon' });
		setIcon(iconEl, 'circle');
		stepEl.createSpan({ cls: 'gh-sync-operation__step-label', text: label });
		this.activeStepEl = stepEl;
		this.onStep(label);
	}

	complete(result: OperationResult, showSuccess = true): void {
		if (this.finished) return;
		this.finished = true;
		this.finishActiveStep();
		this.noticeShellEl.removeClass('is-warning');
		this.noticeShellEl.addClass(result.status === 'success' ? 'is-success' : 'is-warning');
		this.iconEl.removeClass('gh-sync-operation__spinner');
		setIcon(this.iconEl, result.status === 'success' ? 'circle-check' : 'circle-alert');
		this.titleEl.setText(result.status === 'success' ? 'Operation complete' : 'Action needed');
		this.replaceHint(result.message);
		this.onFinish();
		const timeout = result.status === 'success' && !showSuccess ? 350 : result.status === 'success' ? 4000 : 10000;
		window.setTimeout(() => this.notice.hide(), timeout);
	}

	fail(error: unknown): void {
		if (this.finished) return;
		this.finished = true;
		this.noticeShellEl.addClass('is-error');
		this.noticeShellEl.setAttr('aria-live', 'assertive');
		this.iconEl.removeClass('gh-sync-operation__spinner');
		setIcon(this.iconEl, 'circle-x');
		this.titleEl.setText('Operation failed');
		if (this.activeStepEl) {
			this.activeStepEl.removeClass('is-active');
			this.activeStepEl.addClass('is-error');
			const icon = this.activeStepEl.querySelector('.gh-sync-operation__step-icon');
			if (icon instanceof HTMLElement) setIcon(icon, 'x');
		}
		this.replaceHint(redactSensitiveText(error));
		this.onFinish();
		window.setTimeout(() => this.notice.hide(), 15000);
	}

	private finishActiveStep(): void {
		if (!this.activeStepEl) return;
		this.activeStepEl.removeClass('is-active');
		this.activeStepEl.addClass('is-complete');
		const icon = this.activeStepEl.querySelector('.gh-sync-operation__step-icon');
		if (icon instanceof HTMLElement) setIcon(icon, 'check');
	}

	private replaceHint(message: string): void {
		const hint = this.noticeEl.querySelector('.gh-sync-operation__hint');
		if (hint instanceof HTMLElement) hint.setText(message);
	}
}

export default class GHSyncPlugin extends Plugin {
	settings: GHSyncSettings;
	private syncInProgress = false;
	private syncTimer?: ReturnType<typeof setIntervalAsync>;
	private branchStatusEl?: HTMLElement;
	private headerBranchBadgeEl?: HTMLButtonElement;
	private displayedBranch?: string;
	private displayedSync?: BranchSyncSummary;
	private displayedDirty = false;
	private conflictedFiles = new Map<string, number>();
	private dirtyRefreshTimer?: number;
	private readonly gitControlEls: HTMLElement[] = [];
	private reviewSnapshot?: ReviewSnapshot;

	private shouldShowNotice(severity: NoticeSeverity): boolean {
		switch (this.settings.noticeLevel) {
			case 'ERROR': return severity === 'ERROR';
			case 'WARNING': return severity !== 'INFO';
			default: return true;
		}
	}

	private showNotice(message: unknown, severity: NoticeSeverity, timeout?: number): void {
		if (this.shouldShowNotice(severity)) {
			new Notice(redactSensitiveText(message), timeout);
		}
	}

	private getGit(): SimpleGit {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) {
			throw new Error('GitHub Sync requires a desktop vault stored on the local file system.');
		}

		const configuredLocation = this.settings.gitLocation.trim();
		if (/[\r\n\0]/.test(configuredLocation)) {
			throw new Error('The configured Git binary location is invalid.');
		}
		const binary = configuredLocation ? path.join(configuredLocation, 'git') : 'git';
		const options: Partial<SimpleGitOptions> = {
			baseDir: adapter.getBasePath(),
			binary,
			maxConcurrentProcesses: 1,
			trimmed: false,
		};
		return simpleGit(options);
	}

	private getReviewClient(): GitHubReviewClient {
		const configured = this.settings.githubCliPath.trim();
		const homebrewExecutable = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh'].find((candidate) => fs.existsSync(candidate));
		const executable = configured || homebrewExecutable || 'gh';
		if (/[\r\n\0]/.test(executable)) throw new Error('The configured GitHub CLI path is invalid.');
		return new GitHubReviewClient(executable);
	}

	private async ensureReview(branch?: string): Promise<ReviewSnapshot> {
		const git = this.getGit();
		await this.configureRemote(git);
		const current = branch ?? await this.currentBranch(git);
		if (current === this.getBaseBranch()) throw new Error('Start or switch to a change branch before adding review comments.');
		const repository = parseGitHubRepository(this.settings.remoteURL);
		const client = this.getReviewClient();
		await client.assertAuthenticated();
		const pull = await client.ensureDraftPR(repository, current, this.getBaseBranch());
		const comments = await client.listComments(repository, pull.number);
		this.reviewSnapshot = { repository, pull, comments };
		this.refreshReviewSurfaces();
		return this.reviewSnapshot;
	}

	private async ensureReviewAfterPush(branch: string): Promise<string | undefined> {
		if (!this.settings.autoCreateDraftPR || branch === this.getBaseBranch()) return undefined;
		try {
			const snapshot = await this.ensureReview(branch);
			return ` · review #${snapshot.pull.number}`;
		} catch (error) {
			this.showNotice(`Branch synced, but review setup needs attention: ${redactSensitiveText(error)}`, 'WARNING', 12000);
			return undefined;
		}
	}

	private getBaseBranch(): string {
		const baseBranch = this.settings.baseBranch.trim();
		if (!isSafeBranchRef(baseBranch)) {
			throw new Error('The configured base branch is invalid.');
		}
		return baseBranch;
	}

	private async configureRemote(git: SimpleGit): Promise<void> {
		const remote = validateRemoteUrl(this.settings.remoteURL);
		const remotes = await git.getRemotes(true);
		if (remotes.some((item) => item.name === 'origin')) {
			await git.remote(['set-url', 'origin', remote]);
		} else {
			await git.addRemote('origin', remote);
		}
	}

	private async currentBranch(git: SimpleGit): Promise<string> {
		const branch = (await git.status()).current;
		if (!branch || !isSafeBranchRef(branch)) {
			throw new Error('The vault is not currently on a named Git branch.');
		}
		return branch;
	}

	private async remoteBranchExists(git: SimpleGit, branch: string): Promise<boolean> {
		const refs = await git.listRemote(['--heads', 'origin', `refs/heads/${branch}`]);
		return refs.trim().length > 0;
	}

	private async branchDivergence(git: SimpleGit, branch: string): Promise<{ ahead: number; behind: number }> {
		const result = await git.raw(['rev-list', '--left-right', '--count', `${branch}...origin/${branch}`]);
		const [aheadText, behindText] = result.trim().split(/\s+/);
		return { ahead: Number(aheadText), behind: Number(behindText) };
	}

	private async requireSynchronizedBranch(git: SimpleGit, branch: string): Promise<void> {
		if (!(await this.remoteBranchExists(git, branch))) {
			throw new Error(`Sync ${branch} before switching branches.`);
		}
		const { ahead, behind } = await this.branchDivergence(git, branch);
		if (ahead > 0 || behind > 0) {
			throw new Error(`Sync ${branch} before switching branches (${ahead} ahead, ${behind} behind).`);
		}
	}

	async getBranchSnapshot(): Promise<BranchSnapshot> {
		const git = this.getGit();
		await this.configureRemote(git);
		await git.fetch('origin');
		const current = await this.currentBranch(git);
		const status = await git.status();
		const published = await this.remoteBranchExists(git, current);
		const divergence = published ? await this.branchDivergence(git, current) : { ahead: 0, behind: 0 };
		const sync = describeBranchSync(divergence.ahead, divergence.behind, published);
		const allBranches = await git.branch(['-a']);
		const branches = Array.from(new Set(allBranches.all
			.map((branch) => branch.replace(/^remotes\/origin\//, '').replace(/^origin\//, ''))
			.filter((branch) => branch !== 'HEAD' && isSafeBranchRef(branch))))
			.sort((left, right) => left.localeCompare(right));
		await this.updateBranchStatus(git, sync);
		return { current, base: this.getBaseBranch(), branches, sync, isClean: status.isClean() };
	}

	openBranchManager(): void {
		new BranchManagerModal(this.app, this).open();
	}

	private async updateBranchStatus(git?: SimpleGit, sync?: BranchSyncSummary): Promise<void> {
		if (!this.branchStatusEl) return;
		try {
			const gitInstance = git ?? this.getGit();
			const branch = await this.currentBranch(gitInstance);
			const status = await gitInstance.status();
			this.displayedDirty = !status.isClean();
			await this.setConflictFiles(status.conflicted);
			if (branch !== this.displayedBranch && !sync) this.displayedSync = undefined;
			this.displayedBranch = branch;
			if (sync) this.displayedSync = sync;
			this.branchStatusEl.empty();
			const icon = this.branchStatusEl.createSpan({ cls: 'gh-sync-status__icon' });
			setIcon(icon, 'git-branch');
			this.branchStatusEl.createSpan({ text: branch });
			if (this.displayedSync) {
				this.branchStatusEl.createSpan({
					cls: `gh-sync-status__state is-${this.displayedSync.state}`,
					text: this.displayedSync.compact,
				});
			}
			if (this.displayedDirty) this.branchStatusEl.createSpan({ cls: 'gh-sync-status__dirty', text: '●' });
			if (this.conflictedFiles.size > 0) {
				this.branchStatusEl.createSpan({ cls: 'gh-sync-status__conflicts', text: `${this.conflictedFiles.size} conflict${this.conflictedFiles.size === 1 ? '' : 's'}` });
			}
			const stateDescription = this.displayedSync ? ` ${this.displayedSync.label}.` : '';
			const dirtyDescription = this.displayedDirty ? ' Local edits.' : '';
			const conflictDescription = this.conflictedFiles.size > 0 ? ` ${this.conflictedFiles.size} conflicted document(s).` : '';
			this.branchStatusEl.setAttr('title', `Current documentation branch: ${branch}.${stateDescription}${dirtyDescription}${conflictDescription}`);
			this.branchStatusEl.setAttr('aria-busy', 'false');
			this.renderHeaderBranchBadge();
		} catch {
			this.branchStatusEl.setText('Git: unavailable');
		}
	}

	private renderHeaderBranchBadge(): void {
		if (!this.displayedBranch) return;
		const leaf = this.app.workspace.getMostRecentLeaf();
		const titleContainer = leaf?.view.containerEl.querySelector('.view-header-title-container');
		const header = titleContainer?.closest('.view-header');
		if (!(header instanceof HTMLElement)) return;

		if (!this.headerBranchBadgeEl) {
			const badge = document.createElement('button');
			badge.type = 'button';
			badge.addClass('gh-sync-header-branch');
			this.registerDomEvent(badge, 'click', () => {
				if (!this.syncInProgress) {
					if (this.conflictedFiles.size > 0) void this.openConflictCenter();
					else this.openBranchManager();
				}
			});
			this.headerBranchBadgeEl = badge;
			this.register(() => badge.remove());
		}

		this.headerBranchBadgeEl.empty();
		const icon = this.headerBranchBadgeEl.createSpan({ cls: 'gh-sync-header-branch__icon' });
		setIcon(icon, 'git-branch');
		this.headerBranchBadgeEl.createSpan({ cls: 'gh-sync-header-branch__label', text: this.displayedBranch });
		if (this.displayedSync) {
			this.headerBranchBadgeEl.createSpan({
				cls: `gh-sync-header-branch__state is-${this.displayedSync.state}`,
				text: this.displayedSync.compact,
			});
		}
		if (this.displayedDirty) this.headerBranchBadgeEl.createSpan({ cls: 'gh-sync-header-branch__dirty', text: '●' });
		if (this.conflictedFiles.size > 0) {
			const conflicts = this.headerBranchBadgeEl.createSpan({ cls: 'gh-sync-header-branch__conflicts' });
			const conflictIcon = conflicts.createSpan();
			setIcon(conflictIcon, 'git-merge');
			conflicts.createSpan({ text: String(this.conflictedFiles.size) });
		}
		const unresolvedReviews = this.reviewSnapshot?.comments.filter((comment) => !comment.metadata.parentId && comment.metadata.state === 'open').length ?? 0;
		if (unresolvedReviews > 0) {
			const reviews = this.headerBranchBadgeEl.createSpan({ cls: 'gh-sync-header-branch__reviews' });
			const reviewIcon = reviews.createSpan();
			setIcon(reviewIcon, 'messages-square');
			reviews.createSpan({ text: String(unresolvedReviews) });
		}
		const stateDescription = this.displayedSync ? ` ${this.displayedSync.label}.` : '';
		const dirtyDescription = this.displayedDirty ? ' Local edits.' : '';
		const conflictDescription = this.conflictedFiles.size > 0 ? ` ${this.conflictedFiles.size} conflicted document(s).` : '';
		this.headerBranchBadgeEl.setAttr('title', `Current documentation branch: ${this.displayedBranch}.${stateDescription}${dirtyDescription}${conflictDescription} Click to manage branches.`);
		this.headerBranchBadgeEl.setAttr('aria-label', `Current documentation branch: ${this.displayedBranch}.${stateDescription}${dirtyDescription}${conflictDescription} Open branch manager.`);
		const actions = header.querySelector('.view-actions');
		if (actions) header.insertBefore(this.headerBranchBadgeEl, actions);
		else header.appendChild(this.headerBranchBadgeEl);
	}

	private setOperationStatus(step?: string): void {
		for (const control of this.gitControlEls) {
			control.toggleClass('is-busy', Boolean(step));
			control.setAttr('aria-disabled', String(Boolean(step)));
		}
		if (!this.branchStatusEl) return;
		this.branchStatusEl.empty();
		if (!step) {
			void this.updateBranchStatus();
			return;
		}
		const spinner = this.branchStatusEl.createSpan({ cls: 'gh-sync-status__spinner' });
		setIcon(spinner, 'loader-circle');
		this.branchStatusEl.createSpan({ text: step });
		this.branchStatusEl.setAttr('title', step);
		this.branchStatusEl.setAttr('aria-busy', 'true');
	}

	private createProgress(title: string): GitOperationProgress {
		return new GitOperationProgress(
			title,
			(step) => this.setOperationStatus(step),
			() => this.setOperationStatus(),
		);
	}

	private async withGitLock(
		title: string,
		action: (progress: GitOperationProgress) => Promise<OperationResult>,
		showSuccess = true,
	): Promise<void> {
		if (this.syncInProgress) {
			this.showNotice('A Git operation is already running.', 'WARNING');
			return;
		}
		this.syncInProgress = true;
		const progress = this.createProgress(title);
		try {
			progress.complete(await action(progress), showSuccess);
		} catch (error) {
			progress.fail(error);
		} finally {
			this.syncInProgress = false;
		}
	}

	private commitMessage(): string {
		const hostname = os.hostname();
		return `docs: sync ${hostname} at ${new Date().toISOString()}`;
	}

	private async commitLocalChanges(git: SimpleGit, status?: StatusResult): Promise<boolean> {
		const currentStatus = status ?? await git.status();
		if (currentStatus.isClean()) return false;
		if (currentStatus.conflicted.length > 0) {
			throw new Error('Resolve the existing merge conflicts before syncing.');
		}
		await git.add(['-A']);
		await git.commit(this.commitMessage());
		return true;
	}

	private safeConflictPath(file: string): string {
		const normalized = file.replace(/\\/g, '/');
		if (!normalized || /[\r\n\0]/.test(normalized) || path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized)) {
			throw new Error('The conflicted file path is invalid.');
		}
		const resolved = path.posix.normalize(normalized);
		if (resolved === '..' || resolved.startsWith('../')) throw new Error('The conflicted file is outside the vault.');
		return resolved;
	}

	getConflictFiles(): Array<{ path: string; unresolved: number }> {
		return Array.from(this.conflictedFiles, ([filePath, unresolved]) => ({ path: filePath, unresolved }))
			.sort((left, right) => left.path.localeCompare(right.path));
	}

	isConflictedFile(filePath: string): boolean {
		return this.conflictedFiles.has(filePath.replace(/\\/g, '/'));
	}

	private async setConflictFiles(files: string[]): Promise<void> {
		const next = new Map<string, number>();
		for (const file of files) {
			const safePath = this.safeConflictPath(file);
			let count = 0;
			try {
				count = parseConflictDocument(await this.app.vault.adapter.read(safePath)).hunks.length;
			} catch {
				count = 1;
			}
			next.set(safePath, count);
		}
		const changed = JSON.stringify(Array.from(this.conflictedFiles)) !== JSON.stringify(Array.from(next));
		this.conflictedFiles = next;
		if (changed) this.refreshConflictSurfaces();
	}

	private refreshConflictSurfaces(): void {
		this.renderHeaderBranchBadge();
		for (const leaf of this.app.workspace.getLeavesOfType(CONFLICT_CENTER_VIEW)) {
			const view = leaf.view;
			if (view instanceof ConflictCenterView) view.refresh();
		}
		this.app.workspace.updateOptions();
	}

	async openConflictFile(file: string): Promise<void> {
		await this.app.workspace.openLinkText(this.safeConflictPath(file), '', true);
	}

	async openConflictCenter(): Promise<void> {
		let leaf = this.app.workspace.getLeavesOfType(CONFLICT_CENTER_VIEW)[0];
		if (!leaf) {
			leaf = this.app.workspace.getRightLeaf(false);
			if (!leaf) return;
			await leaf.setViewState({ type: CONFLICT_CENTER_VIEW, active: true });
		}
		this.app.workspace.revealLeaf(leaf);
	}

	async openReviewCenter(): Promise<void> {
		let leaf = this.app.workspace.getLeavesOfType(REVIEW_CENTER_VIEW)[0];
		if (!leaf) {
			leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf(true);
			await leaf.setViewState({ type: REVIEW_CENTER_VIEW, active: true });
		}
		await this.app.workspace.revealLeaf(leaf);
		void this.refreshReviews();
	}

	private refreshReviewSurfaces(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(REVIEW_CENTER_VIEW)) {
			const view = leaf.view;
			if (view instanceof ReviewCenterView) view.refresh();
		}
		this.renderHeaderBranchBadge();
	}

	async refreshReviews(): Promise<void> {
		try {
			await this.ensureReview();
		} catch (error) {
			this.reviewSnapshot = undefined;
			this.refreshReviewSurfaces();
			for (const leaf of this.app.workspace.getLeavesOfType(REVIEW_CENTER_VIEW)) {
				const view = leaf.view;
				if (view instanceof ReviewCenterView) view.showError(redactSensitiveText(error));
			}
		}
	}

	getReviewSnapshot(): ReviewSnapshot | undefined {
		return this.reviewSnapshot;
	}

	async commentOnSelection(editor?: Editor, markdownView?: MarkdownView): Promise<void> {
		const view = markdownView ?? this.app.workspace.getActiveViewOfType(MarkdownView);
		const activeEditor = editor ?? view?.editor;
		if (!view?.file || !activeEditor) {
			this.showNotice('Open a Markdown note and select text first.', 'WARNING');
			return;
		}
		const selection = activeEditor.getSelection();
		if (!selection) {
			this.showNotice('Select the text you want to discuss first.', 'WARNING');
			return;
		}
		try {
			const from = activeEditor.posToOffset(activeEditor.getCursor('from'));
			const to = activeEditor.posToOffset(activeEditor.getCursor('to'));
			const anchor = createTextAnchor(activeEditor.getValue(), Math.min(from, to), Math.max(from, to), view.file.path);
			const snapshot = await this.ensureReview();
			const collaborators = await this.getReviewClient().listCollaborators(snapshot.repository);
			new ReviewCommentModal(this.app, anchor, collaborators, async (body) => {
				await this.getReviewClient().createComment(snapshot.repository, snapshot.pull.number, anchor, body);
				this.showNotice(`Comment added to review #${snapshot.pull.number}.`, 'INFO');
				await this.refreshReviews();
				await this.openReviewCenter();
			}).open();
		} catch (error) {
			this.showNotice(error, 'ERROR', 12000);
		}
	}

	async replyToReview(comment: GitHubReviewComment): Promise<void> {
		const snapshot = this.reviewSnapshot;
		if (!snapshot) return;
		const collaborators = await this.getReviewClient().listCollaborators(snapshot.repository);
		new ReviewCommentModal(this.app, comment.metadata.anchor, collaborators, async (body) => {
			await this.getReviewClient().createComment(snapshot.repository, snapshot.pull.number, comment.metadata.anchor, body, comment.id);
			await this.refreshReviews();
		}).open();
	}

	async setReviewResolved(comment: GitHubReviewComment, resolved: boolean): Promise<void> {
		const snapshot = this.reviewSnapshot;
		if (!snapshot) return;
		try {
			await this.getReviewClient().setResolved(snapshot.repository, snapshot.pull.number, comment, resolved);
			await this.refreshReviews();
		} catch (error) {
			this.showNotice(error, 'ERROR', 12000);
		}
	}

	async openReviewComment(comment: GitHubReviewComment): Promise<void> {
		await this.app.workspace.openLinkText(comment.metadata.anchor.path, '', true);
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (view) {
			const position = reanchorText(view.editor.getValue(), comment.metadata.anchor);
			const line = Math.max(0, position.startLine - 1);
			view.editor.setCursor({ line, ch: 0 });
			view.editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
		}
	}

	private async openConflictWorkspace(files: string[]): Promise<void> {
		if (files.length === 0) return;
		await this.openConflictFile(files[0]);
		await this.openConflictCenter();
	}

	onConflictDocumentUpdated(filePath: string, remaining: number): void {
		if (!this.conflictedFiles.has(filePath)) return;
		this.conflictedFiles.set(filePath, remaining);
		this.refreshConflictSurfaces();
	}

	async markConflictResolved(file: string, text: string): Promise<void> {
		const safePath = this.safeConflictPath(file);
		if (parseConflictDocument(text).hunks.length > 0) {
			throw new Error('Review every conflicting section before marking this document resolved.');
		}
		const git = this.getGit();
		const status = await git.status();
		const conflictPaths = status.conflicted.map((conflictPath) => conflictPath.replace(/\\/g, '/'));
		if (!conflictPaths.includes(safePath)) {
			this.conflictedFiles.delete(safePath);
			this.refreshConflictSurfaces();
			return;
		}
		await this.app.vault.adapter.write(safePath, text);
		await git.raw(['add', '--', safePath]);
		await this.setConflictFiles((await git.status()).conflicted);
		await this.updateBranchStatus(git);
		this.showNotice(`${safePath} is resolved. Continue Sync current when all documents are ready.`, 'INFO');
	}

	aiProviderLabel(): string | null {
		if (this.settings.aiProvider === 'disabled') return null;
		if (this.settings.aiProvider === 'codex') return 'Codex';
		return this.settings.aiProvider === 'ollama' ? 'Ollama' : 'LM Studio';
	}

	async requestAISuggestion(request: Omit<ConflictAIRequest, 'branch'>): Promise<ConflictAISuggestion> {
		const provider = this.settings.aiProvider;
		if (provider === 'disabled') throw new Error('Enable an AI provider in GitHub Sync settings first.');
		if (this.settings.aiConsentProvider !== provider) {
			const approved = await new Promise<boolean>((resolve) => new AIConsentModal(this.app, provider, resolve).open());
			if (!approved) throw new Error('AI suggestion cancelled.');
			this.settings.aiConsentProvider = provider;
			await this.saveSettings();
		}
		const git = this.getGit();
		const branch = await this.currentBranch(git);
		return new CodexConflictProvider({
			provider,
			executable: this.settings.codexExecutable,
		}).suggest({ ...request, branch });
	}

	private async handleConflicts(git: SimpleGit, pullError: unknown): Promise<string> {
		const status = await git.status();
		const conflicts = status.conflicted;
		if (conflicts.length === 0) {
			throw new Error(`Git could not merge the remote changes. No files were pushed.\n${redactSensitiveText(pullError)}`);
		}
		await this.setConflictFiles(conflicts);
		await this.openConflictWorkspace(conflicts);
		return `Sync paused for ${conflicts.length} conflicted document${conflicts.length === 1 ? '' : 's'}. Review the highlighted sections in the editor.`;
	}

	async syncNotes(showBranchManagerOnProtected = true): Promise<void> {
		await this.withGitLock('Syncing documentation', async (progress) => {
			progress.step('Preparing repository');
			const git = this.getGit();
			await this.configureRemote(git);

			progress.step('Checking the current branch');
			const status = await git.status();
			const branch = await this.currentBranch(git);
			if (status.conflicted.length > 0) {
				await this.setConflictFiles(status.conflicted);
				await this.openConflictWorkspace(status.conflicted);
				return {
					status: 'warning',
					message: `Sync paused for ${status.conflicted.length} conflicted document${status.conflicted.length === 1 ? '' : 's'}. Review the highlighted sections in the editor.`,
				};
			}
			if (this.settings.protectBaseBranch && branch === this.getBaseBranch() && !status.isClean()) {
				if (showBranchManagerOnProtected) this.openBranchManager();
				return {
					status: 'warning',
					message: `${branch} is protected. Start or switch to a change branch before syncing edited files.`,
				};
			}

			progress.step(status.isClean() ? 'No local edits to save' : 'Saving local edits');
			await this.commitLocalChanges(git, status);

			progress.step('Fetching updates from GitHub');
			await git.fetch('origin');
			if (await this.remoteBranchExists(git, branch)) {
				progress.step(`Merging updates into ${branch}`);
				try {
					await git.pull('origin', branch, { '--no-rebase': null });
				} catch (error) {
					return { status: 'warning', message: await this.handleConflicts(git, error) };
				}
			}

			progress.step(`Pushing ${branch} to GitHub`);
			await git.push('origin', branch, ['-u']);
			progress.step('Preparing documentation review');
			const review = await this.ensureReviewAfterPush(branch);
			await this.updateBranchStatus(git, describeBranchSync(0, 0, true));
			return { status: 'success', message: `Synced ${branch}${review ?? ''}` };
		}, this.settings.showSyncSuccessNotice);
	}

	async updateCurrentBranch(): Promise<void> {
		await this.withGitLock('Updating documentation branch', async (progress) => {
			progress.step('Checking for local edits');
			const git = this.getGit();
			if (!(await git.status()).isClean()) {
				throw new Error('This branch has local edits. Use Sync current to save and merge them safely.');
			}

			progress.step('Fetching updates from GitHub');
			await this.configureRemote(git);
			await git.fetch('origin');
			const branch = await this.currentBranch(git);
			const published = await this.remoteBranchExists(git, branch);
			if (!published) throw new Error(`${branch} has not been published. Use Sync current to publish it.`);

			const { ahead, behind } = await this.branchDivergence(git, branch);
			await this.updateBranchStatus(git, describeBranchSync(ahead, behind, true));
			if (ahead > 0) {
				const detail = behind > 0 ? `${ahead} ahead and ${behind} behind` : `${ahead} ahead`;
				throw new Error(`${branch} is ${detail}. Use Sync current to merge and publish local commits safely.`);
			}
			if (behind === 0) return { status: 'success', message: `${branch} is already up to date` };

			progress.step(`Fast-forwarding ${branch}`);
			await git.pull('origin', branch, { '--ff-only': null });
			await this.updateBranchStatus(git, describeBranchSync(0, 0, true));
			return { status: 'success', message: `Updated ${branch} with ${behind} remote commit${behind === 1 ? '' : 's'}` };
		});
	}

	async startChange(changeTitle: string): Promise<void> {
		await this.withGitLock('Starting documentation change', async (progress) => {
			progress.step('Inspecting local edits');
			const git = this.getGit();
			const status = await git.status();

			progress.step('Fetching branches from GitHub');
			await this.configureRemote(git);
			await git.fetch('origin');
			const currentBranch = await this.currentBranch(git);
			const baseBranch = this.getBaseBranch();
			const newBranch = normalizeBranchName(changeTitle, this.settings.branchPrefix);
			const localBranches = await git.branchLocal();
			if (localBranches.all.includes(newBranch) || await this.remoteBranchExists(git, newBranch)) {
				throw new Error(`The branch ${newBranch} already exists. Choose another change name.`);
			}

			if (!status.isClean()) {
				if (currentBranch !== baseBranch) {
					throw new Error(`Sync the edits on ${currentBranch} before starting another change.`);
				}
				if (status.conflicted.length > 0) {
					throw new Error('Resolve the existing merge conflicts before starting a change.');
				}
				progress.step(`Creating ${newBranch}`);
				await git.checkoutLocalBranch(newBranch);
				progress.step('Moving current edits onto the new branch');
				await this.commitLocalChanges(git);
				if (await this.remoteBranchExists(git, baseBranch)) {
					progress.step(`Merging edits with the latest ${baseBranch}`);
					try {
						await git.merge([`origin/${baseBranch}`, '--no-edit']);
					} catch (error) {
						await this.updateBranchStatus(git);
						return { status: 'warning', message: await this.handleConflicts(git, error) };
					}
				}
			} else {
				progress.step(`Checking ${currentBranch} is synchronized`);
				await this.requireSynchronizedBranch(git, currentBranch);
				progress.step(`Updating ${baseBranch}`);
				await git.checkout(baseBranch);
				if (await this.remoteBranchExists(git, baseBranch)) {
					await git.pull('origin', baseBranch, { '--ff-only': null });
				}
				progress.step(`Creating ${newBranch}`);
				await git.checkoutLocalBranch(newBranch);
			}

			progress.step(`Publishing ${newBranch} to GitHub`);
			await git.push('origin', newBranch, ['-u']);
			progress.step('Preparing documentation review');
			const review = await this.ensureReviewAfterPush(newBranch);
			await this.updateBranchStatus(git, describeBranchSync(0, 0, true));
			return { status: 'success', message: `Started change: ${newBranch}${review ?? ''}` };
		});
	}

	async returnToBaseBranch(): Promise<void> {
		await this.withGitLock('Returning to the accepted branch', async (progress) => {
			progress.step('Checking for unsaved Git changes');
			const git = this.getGit();
			if (!(await git.status()).isClean()) {
				throw new Error('Sync or commit your current changes before returning to the base branch.');
			}

			progress.step('Fetching branches from GitHub');
			await this.configureRemote(git);
			await git.fetch('origin');
			const currentBranch = await this.currentBranch(git);
			progress.step(`Checking ${currentBranch} is synchronized`);
			await this.requireSynchronizedBranch(git, currentBranch);
			const baseBranch = this.getBaseBranch();
			progress.step(`Switching to ${baseBranch}`);
			await git.checkout(baseBranch);
			if (await this.remoteBranchExists(git, baseBranch)) {
				progress.step(`Updating ${baseBranch}`);
				await git.pull('origin', baseBranch, { '--ff-only': null });
			}
			await this.updateBranchStatus(git, describeBranchSync(0, 0, true));
			return { status: 'success', message: `Returned to ${baseBranch}` };
		});
	}

	async switchBranch(targetBranch: string): Promise<void> {
		await this.withGitLock('Switching documentation branch', async (progress) => {
			progress.step('Validating the selected branch');
			if (!isSafeBranchRef(targetBranch)) throw new Error('The selected branch name is invalid.');
			const git = this.getGit();
			if (!(await git.status()).isClean()) {
				throw new Error('Sync or discard your current edits before switching branches.');
			}

			progress.step('Fetching branches from GitHub');
			await this.configureRemote(git);
			await git.fetch('origin');
			const currentBranch = await this.currentBranch(git);
			if (currentBranch === targetBranch) {
				return { status: 'success', message: `Already on ${targetBranch}` };
			}

			progress.step(`Checking ${currentBranch} is synchronized`);
			await this.requireSynchronizedBranch(git, currentBranch);
			progress.step(`Switching to ${targetBranch}`);
			const localBranches = await git.branchLocal();
			if (localBranches.all.includes(targetBranch)) {
				await git.checkout(targetBranch);
			} else if (await this.remoteBranchExists(git, targetBranch)) {
				await git.checkout(['-b', targetBranch, `origin/${targetBranch}`]);
			} else {
				throw new Error(`The branch ${targetBranch} no longer exists.`);
			}
			if (await this.remoteBranchExists(git, targetBranch)) {
				progress.step(`Updating ${targetBranch}`);
				await git.pull('origin', targetBranch, { '--ff-only': null });
			}
			await this.updateBranchStatus(git, describeBranchSync(0, 0, true));
			return { status: 'success', message: `Switched to ${targetBranch}` };
		});
	}

	async checkStatusOnStart(autoUpdate = this.settings.isSyncOnLoad, showNotices = true): Promise<void> {
		if (this.syncInProgress) return;
		try {
			const git = this.getGit();
			const status = await git.status();
			if (status.conflicted.length > 0) {
				await this.setConflictFiles(status.conflicted);
				await this.updateBranchStatus(git);
				return;
			}
			await this.configureRemote(git);
			await git.fetch('origin');
			const branch = await this.currentBranch(git);
			const published = await this.remoteBranchExists(git, branch);
			if (!published) {
				await this.updateBranchStatus(git, describeBranchSync(0, 0, false));
				if (showNotices) this.showNotice(`${branch} has not been published yet. Sync to publish it.`, 'WARNING');
				return;
			}
			const { ahead, behind } = await this.branchDivergence(git, branch);
			await this.updateBranchStatus(git, describeBranchSync(ahead, behind, true));
			if (!status.isClean()) {
				const remoteDetail = behind > 0 ? ` and is ${behind} commit(s) behind` : '';
				if (showNotices) this.showNotice(`${branch} has local edits${remoteDetail}. Use Sync current before switching branches.`, 'WARNING');
				return;
			}
			if (behind > 0) {
				if (ahead > 0) {
					if (showNotices) this.showNotice(`${branch} is ${ahead} ahead and ${behind} behind. Use Sync current to merge both histories.`, 'WARNING');
				} else if (autoUpdate) {
					await this.updateCurrentBranch();
				} else if (showNotices) {
					this.showNotice(`${branch} is ${behind} commit(s) behind. Use Update branch before editing.`, 'WARNING');
				}
				return;
			}
			if (showNotices && ahead > 0) this.showNotice(`${branch} has ${ahead} local commit(s) to publish. Use Sync current.`, 'WARNING');
			else if (showNotices) this.showNotice(`${branch} is up to date.`, 'INFO');
		} catch {
			await this.updateBranchStatus();
		}
	}

	async onload(): Promise<void> {
		await this.loadSettings();
		this.registerView(CONFLICT_CENTER_VIEW, (leaf) => new ConflictCenterView(leaf, this));
		this.registerView(REVIEW_CENTER_VIEW, (leaf) => new ReviewCenterView(leaf, this));
		this.registerEditorExtension(conflictEditorExtension({
			isConflictedFile: (filePath) => this.isConflictedFile(filePath),
			onDocumentUpdated: (filePath, remaining) => this.onConflictDocumentUpdated(filePath, remaining),
			markResolved: async (filePath, text) => {
				try {
					await this.markConflictResolved(filePath, text);
				} catch (error) {
					this.showNotice(error, 'ERROR', 12000);
				}
			},
			openConflictCenter: () => void this.openConflictCenter(),
			requestAISuggestion: (filePath, hunk, before, after) => this.requestAISuggestion({ filePath, hunk, before, after }),
			aiProviderLabel: () => this.aiProviderLabel(),
		}));
		this.branchStatusEl = this.addStatusBarItem();
		this.branchStatusEl.addClass('gh-sync-status');
		this.branchStatusEl.setAttr('aria-live', 'polite');
		this.registerDomEvent(this.branchStatusEl, 'click', () => {
			if (!this.syncInProgress) {
				if (this.conflictedFiles.size > 0) void this.openConflictCenter();
				else this.openBranchManager();
			}
		});
		this.registerEvent(this.app.workspace.on('active-leaf-change', () => {
			window.setTimeout(() => this.renderHeaderBranchBadge(), 0);
		}));
		this.registerEvent(this.app.workspace.on('layout-change', () => this.renderHeaderBranchBadge()));
		this.registerEvent(this.app.workspace.on('editor-menu', (menu: Menu, editor: Editor, info) => {
			if (!editor.getSelection()) return;
			menu.addItem((item) => item
				.setTitle('Comment on selection')
				.setIcon('message-square-plus')
				.onClick(() => void this.commentOnSelection(editor, info instanceof MarkdownView ? info : undefined)));
		}));
		this.registerEvent(this.app.vault.on('modify', () => {
			if (this.dirtyRefreshTimer) window.clearTimeout(this.dirtyRefreshTimer);
			this.dirtyRefreshTimer = window.setTimeout(() => {
				if (!this.syncInProgress) void this.updateBranchStatus();
			}, 350);
		}));

		const ribbonIconEl = this.addRibbonIcon('github', 'Sync current branch', () => void this.syncNotes());
		ribbonIconEl.addClass('gh-sync-ribbon');
		const branchRibbonEl = this.addRibbonIcon('git-branch', 'Open branch manager', () => {
			if (!this.syncInProgress) this.openBranchManager();
		});
		branchRibbonEl.addClass('gh-sync-branch-ribbon');
		const reviewRibbonEl = this.addRibbonIcon('messages-square', 'Open documentation review', () => {
			if (!this.syncInProgress) void this.openReviewCenter();
		});
		reviewRibbonEl.addClass('gh-sync-review-ribbon');
		this.gitControlEls.push(ribbonIconEl, branchRibbonEl);

		this.addCommand({ id: 'github-sync-command', name: 'Sync current branch', callback: () => void this.syncNotes() });
		this.addCommand({ id: 'github-sync-update-current', name: 'Update current branch from GitHub', callback: () => void this.updateCurrentBranch() });
		this.addCommand({ id: 'github-sync-branch-manager', name: 'Open branch manager', callback: () => this.openBranchManager() });
		this.addCommand({ id: 'github-sync-conflict-center', name: 'Open conflict center', callback: () => void this.openConflictCenter() });
		this.addCommand({ id: 'github-sync-review-center', name: 'Open review center', callback: () => void this.openReviewCenter() });
		this.addCommand({
			id: 'github-sync-comment-selection',
			name: 'Comment on selected text',
			editorCheckCallback: (checking, editor, view) => {
				if (!editor.getSelection()) return false;
				if (!checking) void this.commentOnSelection(editor, view instanceof MarkdownView ? view : undefined);
				return true;
			},
		});
		this.addCommand({
			id: 'github-sync-start-change',
			name: 'Start a change branch',
			callback: () => new BranchNameModal(this.app, (title) => void this.startChange(title)).open(),
		});
		this.addCommand({ id: 'github-sync-return-to-base', name: 'Return to base branch', callback: () => void this.returnToBaseBranch() });
		this.addSettingTab(new GHSyncSettingTab(this.app, this));

		const interval = this.settings.syncinterval;
		if (Number.isFinite(interval) && interval >= 1) {
			this.syncTimer = setIntervalAsync(() => this.checkStatusOnStart(true, false), interval * 60 * 1000);
			this.showNotice('Automatic safe branch updates enabled.', 'INFO');
		}
		if (this.settings.checkStatusOnLoad) void this.checkStatusOnStart();
		else void this.updateBranchStatus();
	}

	onunload(): void {
		if (this.syncTimer) void clearIntervalAsync(this.syncTimer);
		if (this.dirtyRefreshTimer) window.clearTimeout(this.dirtyRefreshTimer);
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		if ((this.settings.noticeLevel as LegacyNoticeLevelSetting) === 'WARNINGS') this.settings.noticeLevel = 'WARNING';
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}

class ConflictCenterView extends ItemView {
	constructor(leaf: WorkspaceLeaf, private readonly plugin: GHSyncPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return CONFLICT_CENTER_VIEW;
	}

	getDisplayText(): string {
		return 'Conflict center';
	}

	getIcon(): string {
		return 'git-merge';
	}

	async onOpen(): Promise<void> {
		this.refresh();
	}

	refresh(): void {
		this.contentEl.empty();
		this.contentEl.addClass('gh-sync-conflict-center');
		const header = this.contentEl.createDiv({ cls: 'gh-sync-conflict-center__header' });
		const heading = header.createDiv();
		heading.createEl('h3', { text: 'Conflict center' });
		heading.createEl('p', { text: 'Documents paused during the GitHub sync.' });
		const files = this.plugin.getConflictFiles();
		if (files.length === 0) {
			const empty = this.contentEl.createDiv({ cls: 'gh-sync-conflict-center__empty' });
			const icon = empty.createSpan();
			setIcon(icon, 'circle-check');
			empty.createDiv({ cls: 'gh-sync-conflict-center__empty-title', text: 'No unresolved conflicts' });
			empty.createEl('p', { text: 'Your documentation branch is ready for normal editing.' });
			return;
		}

		const total = files.reduce((sum, file) => sum + file.unresolved, 0);
		this.contentEl.createDiv({
			cls: 'gh-sync-conflict-center__summary',
			text: total > 0
				? `${total} section${total === 1 ? '' : 's'} across ${files.length} document${files.length === 1 ? '' : 's'}`
				: `${files.length} document${files.length === 1 ? '' : 's'} ready to mark resolved`,
		});
		const list = this.contentEl.createDiv({ cls: 'gh-sync-conflict-center__list' });
		for (const file of files) {
			const item = list.createEl('button', { cls: 'gh-sync-conflict-center__item', attr: { type: 'button' } });
			const icon = item.createSpan({ cls: 'gh-sync-conflict-center__item-icon' });
			setIcon(icon, file.unresolved > 0 ? 'file-warning' : 'circle-check');
			const copy = item.createDiv({ cls: 'gh-sync-conflict-center__item-copy' });
			copy.createDiv({ cls: 'gh-sync-conflict-center__item-name', text: file.path.split('/').pop() || file.path });
			copy.createDiv({ cls: 'gh-sync-conflict-center__item-path', text: file.path });
			item.createSpan({
				cls: `gh-sync-conflict-center__count${file.unresolved === 0 ? ' is-ready' : ''}`,
				text: file.unresolved > 0 ? String(file.unresolved) : 'Ready',
			});
			item.addEventListener('click', () => void this.plugin.openConflictFile(file.path));
		}
		const footer = this.contentEl.createDiv({ cls: 'gh-sync-conflict-center__footer' });
		footer.createEl('p', { text: 'AI suggestions are optional and never apply changes automatically.' });
	}
}

class ReviewCenterView extends ItemView {
	private error?: string;

	constructor(leaf: WorkspaceLeaf, private readonly plugin: GHSyncPlugin) {
		super(leaf);
	}

	getViewType(): string { return REVIEW_CENTER_VIEW; }
	getDisplayText(): string { return 'Documentation review'; }
	getIcon(): string { return 'messages-square'; }

	async onOpen(): Promise<void> {
		this.refresh();
	}

	showError(message: string): void {
		this.error = message;
		this.refresh();
	}

	refresh(): void {
		this.contentEl.empty();
		this.contentEl.addClass('gh-sync-review-center');
		const header = this.contentEl.createDiv({ cls: 'gh-sync-review-center__header' });
		const heading = header.createDiv();
		heading.createEl('h3', { text: 'Documentation review' });
		heading.createEl('p', { text: 'Selected-text discussions on the current change branch.' });
		const refresh = header.createEl('button', { cls: 'clickable-icon', attr: { type: 'button', 'aria-label': 'Refresh review comments' } });
		setIcon(refresh, 'refresh-cw');
		refresh.addEventListener('click', () => {
			this.error = undefined;
			void this.plugin.refreshReviews();
		});

		const snapshot = this.plugin.getReviewSnapshot();
		if (!snapshot) {
			const empty = this.contentEl.createDiv({ cls: 'gh-sync-review-center__empty' });
			const icon = empty.createSpan();
			setIcon(icon, this.error ? 'circle-alert' : 'loader-circle');
			empty.createDiv({ cls: 'gh-sync-review-center__empty-title', text: this.error ? 'Review setup needed' : 'Loading review…' });
			empty.createEl('p', { text: this.error ?? 'Checking the draft pull request for this branch.' });
			if (this.error) empty.createEl('p', { text: 'Install and sign in to GitHub CLI, then refresh. Your Git branch sync still works independently.' });
			return;
		}

		this.error = undefined;
		const roots = snapshot.comments.filter((comment) => !comment.metadata.parentId);
		const unresolved = roots.filter((comment) => comment.metadata.state === 'open').length;
		const summary = this.contentEl.createDiv({ cls: 'gh-sync-review-center__summary' });
		summary.createSpan({ text: `Review #${snapshot.pull.number}` });
		summary.createSpan({ cls: unresolved > 0 ? 'is-open' : 'is-resolved', text: unresolved > 0 ? `${unresolved} open` : 'All resolved' });

		if (roots.length === 0) {
			const empty = this.contentEl.createDiv({ cls: 'gh-sync-review-center__empty' });
			const icon = empty.createSpan();
			setIcon(icon, 'message-square-plus');
			empty.createDiv({ cls: 'gh-sync-review-center__empty-title', text: 'No discussions yet' });
			empty.createEl('p', { text: 'Select text in a note, right-click, and choose “Comment on selection”.' });
			return;
		}

		const list = this.contentEl.createDiv({ cls: 'gh-sync-review-center__list' });
		for (const comment of roots) {
			const thread = list.createDiv({ cls: `gh-sync-review-thread${comment.metadata.state === 'resolved' ? ' is-resolved' : ''}` });
			const top = thread.createDiv({ cls: 'gh-sync-review-thread__top' });
			const location = top.createEl('button', { cls: 'gh-sync-review-thread__location', attr: { type: 'button' } });
			setIcon(location.createSpan(), 'file-text');
			location.createSpan({ text: `${comment.metadata.anchor.path} · lines ${comment.metadata.anchor.startLine}–${comment.metadata.anchor.endLine}` });
			location.addEventListener('click', () => void this.plugin.openReviewComment(comment));
			top.createSpan({ cls: `gh-sync-review-thread__state${comment.metadata.state === 'resolved' ? ' is-resolved' : ''}`, text: comment.metadata.state === 'resolved' ? 'Resolved' : 'Open' });

			const quote = thread.createEl('blockquote', { text: comment.metadata.anchor.selectedText.slice(0, 500) });
			if (comment.metadata.anchor.selectedText.length > 500) quote.createSpan({ text: '…' });
			const body = thread.createDiv({ cls: 'gh-sync-review-thread__body', text: comment.body.replace(/^(?:>.*\n?)+\s*/m, '') });
			body.setAttr('data-author', `@${comment.author}`);
			thread.createDiv({ cls: 'gh-sync-review-thread__meta', text: `@${comment.author} · ${new Date(comment.createdAt).toLocaleString()}` });

			for (const reply of snapshot.comments.filter((candidate) => candidate.metadata.parentId === comment.id)) {
				const replyEl = thread.createDiv({ cls: 'gh-sync-review-thread__reply' });
				replyEl.createDiv({ cls: 'gh-sync-review-thread__reply-meta', text: `@${reply.author} · ${new Date(reply.createdAt).toLocaleString()}` });
				replyEl.createDiv({ text: reply.body });
			}

			const actions = thread.createDiv({ cls: 'gh-sync-review-thread__actions' });
			const reply = actions.createEl('button', { text: 'Reply', attr: { type: 'button' } });
			reply.addEventListener('click', () => void this.plugin.replyToReview(comment));
			const resolve = actions.createEl('button', { text: comment.metadata.state === 'resolved' ? 'Reopen' : 'Resolve', attr: { type: 'button' } });
			resolve.addEventListener('click', () => void this.plugin.setReviewResolved(comment, comment.metadata.state !== 'resolved'));
		}
	}
}

class ReviewCommentModal extends Modal {
	private body = '';
	private submitting = false;

	constructor(
		app: App,
		private readonly anchor: TextAnchor,
		private readonly collaborators: string[],
		private readonly submit: (body: string) => Promise<void>,
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass('gh-sync-review-modal');
		this.contentEl.createEl('h2', { text: 'Comment on selected text' });
		this.contentEl.createDiv({ cls: 'gh-sync-review-modal__location', text: `${this.anchor.path} · lines ${this.anchor.startLine}–${this.anchor.endLine}` });
		this.contentEl.createEl('blockquote', { text: this.anchor.selectedText.slice(0, 1000) });
		const textarea = this.contentEl.createEl('textarea', {
			cls: 'gh-sync-review-modal__input',
			attr: { placeholder: 'Add context or a decision. Type @ to notify a collaborator.', rows: '6', maxlength: '20000' },
		});
		textarea.addEventListener('input', () => this.body = textarea.value);
		const people = this.contentEl.createDiv({ cls: 'gh-sync-review-modal__people' });
		people.createSpan({ text: 'Mention: ' });
		for (const collaborator of this.collaborators.slice(0, 12)) {
			const button = people.createEl('button', { text: `@${collaborator}`, attr: { type: 'button' } });
			button.addEventListener('click', () => {
				const mention = `@${collaborator} `;
				textarea.setRangeText(mention, textarea.selectionStart, textarea.selectionEnd, 'end');
				this.body = textarea.value;
				textarea.focus();
			});
		}
		const status = this.contentEl.createDiv({ cls: 'gh-sync-review-modal__status', attr: { 'aria-live': 'polite' } });
		const actions = this.contentEl.createDiv({ cls: 'gh-sync-review-modal__actions' });
		const cancel = actions.createEl('button', { text: 'Cancel', attr: { type: 'button' } });
		cancel.addEventListener('click', () => this.close());
		const post = actions.createEl('button', { cls: 'mod-cta', text: 'Post comment', attr: { type: 'button' } });
		post.addEventListener('click', async () => {
			if (this.submitting || !this.body.trim()) {
				if (!this.body.trim()) status.setText('Write a comment before posting.');
				return;
			}
			this.submitting = true;
			post.disabled = true;
			cancel.disabled = true;
			status.setText('Posting to GitHub…');
			try {
				await this.submit(this.body);
				this.close();
			} catch (error) {
				status.setText(redactSensitiveText(error));
				this.submitting = false;
				post.disabled = false;
				cancel.disabled = false;
			}
		});
		window.setTimeout(() => textarea.focus(), 0);
	}

	onClose(): void { this.contentEl.empty(); }
}

class AIConsentModal extends Modal {
	private resolved = false;

	constructor(
		app: App,
		private readonly provider: Exclude<ConflictAIProvider, 'disabled'>,
		private readonly resolve: (approved: boolean) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass('gh-sync-ai-consent');
		const label = this.provider === 'codex' ? 'Codex' : this.provider === 'ollama' ? 'Ollama' : 'LM Studio';
		this.contentEl.createEl('h2', { text: `Use ${label} for this conflict?` });
		this.contentEl.createEl('p', {
			text: this.provider === 'codex'
				? 'The conflicting text, nearby context, file path, and branch name will be sent to your configured Codex account.'
				: `The conflicting text, nearby context, file path, and branch name will be sent to your local ${label} server.`,
		});
		const safeguards = this.contentEl.createEl('ul');
		safeguards.createEl('li', { text: 'The rest of your vault is not included.' });
		safeguards.createEl('li', { text: 'The provider runs read-only in an isolated temporary folder.' });
		safeguards.createEl('li', { text: 'You must review and apply every suggestion yourself.' });
		const actions = this.contentEl.createDiv({ cls: 'gh-sync-ai-consent__actions' });
		const cancel = actions.createEl('button', { text: 'Cancel', attr: { type: 'button' } });
		cancel.addEventListener('click', () => this.close());
		const continueButton = actions.createEl('button', { cls: 'mod-cta', text: `Allow ${label}`, attr: { type: 'button' } });
		continueButton.addEventListener('click', () => {
			this.resolved = true;
			this.resolve(true);
			this.close();
		});
	}

	onClose(): void {
		if (!this.resolved) this.resolve(false);
		this.contentEl.empty();
	}
}

class BranchManagerModal extends Modal {
	constructor(app: App, private readonly plugin: GHSyncPlugin) {
		super(app);
	}

	onOpen(): void {
		void this.render();
	}

	private async render(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.createEl('h2', { text: 'Documentation branches' });
		const loading = this.contentEl.createEl('p', { text: 'Loading branches…' });
		try {
			const snapshot = await this.plugin.getBranchSnapshot();
			loading.remove();

			const currentDescription = snapshot.isClean
				? snapshot.current === snapshot.base
					? 'Accepted documentation branch.'
					: 'Edits and syncs use this branch.'
				: snapshot.current === snapshot.base
					? 'Local edits are protected. Move them to a change branch.'
					: 'Local edits have not been synchronized yet.';
			const currentSetting = new Setting(this.contentEl)
				.setName(snapshot.current)
				.setDesc(currentDescription);
			currentSetting.nameEl.createSpan({
				cls: `gh-sync-state-pill is-${snapshot.sync.state}`,
				text: snapshot.sync.label,
			});
			if (!snapshot.isClean) {
				currentSetting.nameEl.createSpan({ cls: 'gh-sync-state-pill is-dirty', text: 'Local edits' });
			}

			if (snapshot.current === snapshot.base && !snapshot.isClean) {
				currentSetting.addButton((button) => button.setButtonText('Start change').setCta().onClick(() => {
					this.close();
					new BranchNameModal(this.app, (title) => void this.plugin.startChange(title)).open();
				}));
			} else if (snapshot.sync.state === 'behind' && snapshot.isClean) {
				currentSetting.addButton((button) => button.setButtonText('Update branch').setCta().onClick(() => {
					this.close();
					void this.plugin.updateCurrentBranch();
				}));
			} else {
				const syncLabel = snapshot.sync.state === 'diverged' || (snapshot.sync.state === 'behind' && !snapshot.isClean)
					? 'Sync & merge'
					: snapshot.sync.state === 'ahead'
						? 'Push changes'
						: snapshot.sync.state === 'unpublished'
							? 'Publish branch'
							: snapshot.isClean ? 'Sync current' : 'Sync edits';
				currentSetting.addButton((button) => {
					button.setButtonText(syncLabel);
					if (snapshot.sync.state !== 'up-to-date' || !snapshot.isClean) button.setCta();
					button.onClick(() => {
						this.close();
						void this.plugin.syncNotes();
					});
				});
			}

			new Setting(this.contentEl)
				.setName('Start a new change')
				.setDesc(`Create a new branch from ${snapshot.base}.`)
				.addButton((button) => button.setButtonText('Start change').setCta().onClick(() => {
					this.close();
					new BranchNameModal(this.app, (title) => void this.plugin.startChange(title)).open();
				}));

			let selectedBranch = snapshot.current;
			new Setting(this.contentEl)
				.setName('Switch to an existing branch')
				.setDesc('Local and GitHub branches are listed together.')
				.addDropdown((dropdown) => {
					for (const branch of snapshot.branches) dropdown.addOption(branch, branch);
					return dropdown.setValue(snapshot.current).onChange((value) => selectedBranch = value);
				})
				.addButton((button) => button.setButtonText('Switch').onClick(() => {
					this.close();
					void this.plugin.switchBranch(selectedBranch);
				}));

			if (snapshot.current !== snapshot.base) {
				new Setting(this.contentEl)
					.setName(`Return to ${snapshot.base}`)
					.setDesc('Use this after the current change has been synchronized and merged.')
					.addButton((button) => button.setButtonText(`Return to ${snapshot.base}`).onClick(() => {
						this.close();
						void this.plugin.returnToBaseBranch();
					}));
			}
		} catch (error) {
			loading.setText(`Could not load branches: ${redactSensitiveText(error)}`);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class BranchNameModal extends Modal {
	private title = '';

	constructor(app: App, private readonly onSubmit: (title: string) => void) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.createEl('h2', { text: 'Start a documentation change' });
		new Setting(this.contentEl)
			.setName('Change name')
			.setDesc('Use a short description, such as “Next sprint billing”.')
			.addText((text) => text.setPlaceholder('Next sprint billing').onChange((value) => this.title = value));
		new Setting(this.contentEl).addButton((button) => button
			.setButtonText('Start change')
			.setCta()
			.onClick(() => {
				this.close();
				this.onSubmit(this.title);
			}));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class GHSyncSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: GHSyncPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const howto = containerEl.createEl('div', { cls: 'howto' });
		howto.createEl('div', { text: 'Branch-based documentation workflow', cls: 'howto_title' });
		howto.createEl('small', { text: 'The base branch is not a branch selector. Use the Branch Manager to start or switch changes, then sync the explicitly displayed current branch.', cls: 'howto_text' });

		new Setting(containerEl)
			.setName('Remote URL')
			.setDesc('Use an HTTPS URL without embedded credentials, or an SSH URL.')
			.addText((text) => text.setValue(this.plugin.settings.remoteURL).onChange(async (value) => {
				this.plugin.settings.remoteURL = value;
				await this.plugin.saveSettings();
			}));

		new Setting(containerEl)
			.setName('Base branch')
			.setDesc('The accepted documentation branch used as the starting point for changes. This is not the current branch selector.')
			.addText((text) => text.setPlaceholder('main').setValue(this.plugin.settings.baseBranch).onChange(async (value) => {
				this.plugin.settings.baseBranch = value;
				await this.plugin.saveSettings();
			}));

		new Setting(containerEl)
			.setName('Protect base branch')
			.setDesc('Prevent edited files from being committed directly to the base branch. Recommended for non-technical teams.')
			.addToggle((toggle) => toggle.setValue(this.plugin.settings.protectBaseBranch).onChange(async (value) => {
				this.plugin.settings.protectBaseBranch = value;
				await this.plugin.saveSettings();
			}));

		new Setting(containerEl)
			.setName('Change branch prefix')
			.setDesc('New branches will look like changes/next-sprint-billing.')
			.addText((text) => text.setPlaceholder('changes').setValue(this.plugin.settings.branchPrefix).onChange(async (value) => {
				this.plugin.settings.branchPrefix = value;
				await this.plugin.saveSettings();
			}));

		new Setting(containerEl)
			.setName('Git binary location')
			.setDesc('Optional directory containing the Git executable. Leave empty when Git is on PATH.')
			.addText((text) => text.setValue(this.plugin.settings.gitLocation).onChange(async (value) => {
				this.plugin.settings.gitLocation = value;
				await this.plugin.saveSettings();
			}));

		containerEl.createEl('h3', { text: 'Selected-text reviews' });
		containerEl.createEl('p', {
			cls: 'setting-item-description',
			text: 'Comments are stored on the change branch’s draft GitHub pull request. GitHub accounts and the authenticated GitHub CLI provide identity, mentions, and notifications.',
		});

		new Setting(containerEl)
			.setName('Create draft review automatically')
			.setDesc('Create or reuse a draft pull request after publishing a change branch. A review setup error never prevents Git synchronization.')
			.addToggle((toggle) => toggle.setValue(this.plugin.settings.autoCreateDraftPR).onChange(async (value) => {
				this.plugin.settings.autoCreateDraftPR = value;
				await this.plugin.saveSettings();
			}));

		new Setting(containerEl)
			.setName('GitHub CLI executable')
			.setDesc('Optional full path to gh. Leave empty when the GitHub CLI is on PATH.')
			.addText((text) => text
				.setPlaceholder('/opt/homebrew/bin/gh')
				.setValue(this.plugin.settings.githubCliPath)
				.onChange(async (value) => {
					this.plugin.settings.githubCliPath = value;
					await this.plugin.saveSettings();
				}));

		containerEl.createEl('h3', { text: 'Conflict suggestions' });
		containerEl.createEl('p', {
			cls: 'setting-item-description',
			text: 'AI is optional. Suggestions are read-only and must be reviewed before they can replace a conflicting section.',
		});

		new Setting(containerEl)
			.setName('AI provider')
			.setDesc('Codex uses your local Codex CLI login. Ollama and LM Studio use the Codex CLI with a local model server.')
			.addDropdown((dropdown) => dropdown
				.addOption('disabled', 'Disabled')
				.addOption('codex', 'Codex')
				.addOption('ollama', 'Ollama (local)')
				.addOption('lmstudio', 'LM Studio (local)')
				.setValue(this.plugin.settings.aiProvider)
				.onChange(async (value: ConflictAIProvider) => {
					this.plugin.settings.aiProvider = value;
					this.plugin.settings.aiConsentProvider = 'disabled';
					await this.plugin.saveSettings();
					this.plugin.app.workspace.updateOptions();
					this.display();
				}));

		if (this.plugin.settings.aiProvider !== 'disabled') {
			new Setting(containerEl)
				.setName('Codex executable')
				.setDesc('Optional full path to the Codex executable. Leave empty to use the ChatGPT app copy or codex on PATH.')
				.addText((text) => text
					.setPlaceholder('/Applications/ChatGPT.app/Contents/Resources/codex')
					.setValue(this.plugin.settings.codexExecutable)
					.onChange(async (value) => {
						this.plugin.settings.codexExecutable = value;
						await this.plugin.saveSettings();
					}));
		}

		new Setting(containerEl)
			.setName('Notice level')
			.setDesc('Choose which synchronization notices appear.')
			.addDropdown((dropdown) => dropdown
				.addOption('ALL', 'ALL')
				.addOption('WARNING', 'WARNING')
				.addOption('ERROR', 'ERROR')
				.setValue(this.plugin.settings.noticeLevel)
				.onChange(async (value: NoticeLevelSetting) => {
					this.plugin.settings.noticeLevel = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Hide success message')
			.setDesc('Hide the confirmation shown after a successful synchronization.')
			.addToggle((toggle) => toggle.setValue(!this.plugin.settings.showSyncSuccessNotice).onChange(async (value) => {
				this.plugin.settings.showSyncSuccessNotice = !value;
				await this.plugin.saveSettings();
			}));

		new Setting(containerEl)
			.setName('Check status on startup')
			.setDesc('Show whether the current branch is ahead, behind, diverged, or up to date.')
			.addToggle((toggle) => toggle.setValue(this.plugin.settings.checkStatusOnLoad).onChange(async (value) => {
				this.plugin.settings.checkStatusOnLoad = value;
				await this.plugin.saveSettings();
			}));

		new Setting(containerEl)
			.setName('Auto update on startup')
			.setDesc('Fast-forward automatically only when the branch is clean and has remote-only updates. Local work still requires explicit Sync.')
			.addToggle((toggle) => toggle.setValue(this.plugin.settings.isSyncOnLoad).onChange(async (value) => {
				this.plugin.settings.isSyncOnLoad = value;
				await this.plugin.saveSettings();
			}));

		new Setting(containerEl)
			.setName('Auto update interval')
			.setDesc('Minutes between safe remote checks. Clean remote-only updates fast-forward automatically; local work is never committed. Use 0 to disable.')
			.addText((text) => text.setValue(String(this.plugin.settings.syncinterval)).onChange(async (value) => {
				this.plugin.settings.syncinterval = Number(value);
				await this.plugin.saveSettings();
			}));
	}
}
