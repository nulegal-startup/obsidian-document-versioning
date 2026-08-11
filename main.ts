import { App, Editor, FileSystemAdapter, ItemView, MarkdownView, Menu, Modal, Notice, Plugin, PluginSettingTab, Setting, setIcon, TFile, WorkspaceLeaf } from 'obsidian';
import { simpleGit, SimpleGit, SimpleGitOptions, StatusResult } from 'simple-git';
import { clearIntervalAsync, setIntervalAsync } from 'set-interval-async';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { execFile } from 'child_process';
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
import { reviewEditorExtension } from './review-editor';
import { applyMention, matchingMentions, mentionQueryAt, MentionQuery } from './review-mention';
import { DocumentMentionSuggest } from './document-mention';
import { activateReviewCenter, ReviewRefreshGate } from './review-refresh';
import {
	classifyGitHubConnectionError,
	githubHttpsRemote,
	GitHubAuthClient,
	GitHubConnectionProblem,
	isGitHubCredentialSetupError,
	withoutGitHubTokenEnvironment,
} from './github-auth';
import { createReviewReadyCommit } from './start-change';
import { configureMatchingGitHubOrigin, hasEffectiveGitHubCredentialHelper, requireMatchingGitHubOrigin } from './github-vault';
import {
	DocumentHistoryService,
	DocumentHistoryGit,
	DocumentHistorySnapshot,
	DocumentPatch,
	DocumentVersion,
} from './document-history';
import {
	applyLocalRevert,
	describeLocalChange,
	groupLocalChangesByFolder,
	LocalChange,
	LocalChangesService,
	LocalChangesSnapshot,
} from './local-changes';

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
	setupAssistantSeen: boolean;
	documentRenameHints: Record<string, string>;
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
	setupAssistantSeen: false,
	documentRenameHints: {},
};

const CONFLICT_CENTER_VIEW = 'github-sync-conflict-center';
const REVIEW_CENTER_VIEW = 'github-sync-review-center';
const DOCUMENT_HISTORY_VIEW = 'github-sync-document-history';
const LOCAL_CHANGES_VIEW = 'github-sync-local-changes';

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
	localChangeCount: number;
}

interface GitHubSetupReadiness {
	gitReady: boolean;
	vaultRepairable: boolean;
	vaultReady: boolean;
	vaultDetail: string;
	connection: 'connected' | GitHubConnectionProblem;
	login?: string;
	repository?: string;
	detail: string;
	warning?: string;
	ready: boolean;
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
	private headerHistoryButtonEl?: HTMLButtonElement;
	private headerDocumentPath?: string;
	private displayedBranch?: string;
	private displayedSync?: BranchSyncSummary;
	private displayedDirty = false;
	private displayedDirtyCount = 0;
	private conflictedFiles = new Map<string, number>();
	private dirtyRefreshTimer?: number;
	private readonly gitControlEls: HTMLElement[] = [];
	private reviewSnapshot?: ReviewSnapshot;
	private readonly reviewRefresh = new ReviewRefreshGate<void>();
	private requestedReviewBranch?: string;
	private collaboratorCache?: { users: string[]; expiresAt: number };
	private collaboratorRequest?: Promise<string[]>;
	private githubConnectionRequest?: Promise<GitHubSetupReadiness>;

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
			throw new Error('Document Versioning requires a desktop vault stored on the local file system.');
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
		return simpleGit(options).env(withoutGitHubTokenEnvironment(process.env));
	}

	private getHistoryGit(): DocumentHistoryGit {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) {
			throw new Error('Document history requires a desktop vault stored on the local file system.');
		}
		const configuredLocation = this.settings.gitLocation.trim();
		if (/[\r\n\0]/.test(configuredLocation)) {
			throw new Error('The configured Git binary location is invalid.');
		}
		const binary = configuredLocation ? path.join(configuredLocation, 'git') : 'git';
		const environment = {
			...withoutGitHubTokenEnvironment(process.env),
			GIT_NO_LAZY_FETCH: '1',
			GIT_LITERAL_PATHSPECS: '1',
			GIT_OPTIONAL_LOCKS: '0',
		};
		return {
			raw: (args: string[]) => new Promise<string>((resolve, reject) => {
				execFile(binary, args, {
					cwd: adapter.getBasePath(),
					env: environment,
					encoding: 'utf8',
					maxBuffer: 1024 * 1024,
					timeout: 15_000,
					windowsHide: true,
				}, (error, stdout, stderr) => {
					if (error) {
						reject(new Error(stderr.trim() || error.message));
						return;
					}
					resolve(stdout);
				});
			}),
		};
	}

	private markdownViewForPath(filePath?: string): MarkdownView | undefined {
		const active = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (active?.file && (!filePath || active.file.path === filePath)) return active;
		for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.file && (!filePath || view.file.path === filePath)) return view;
		}
		return undefined;
	}

	getActiveDocumentPath(): string | undefined {
		return this.markdownViewForPath()?.file?.path;
	}

	private documentRenameHistory(filePath: string): string[] {
		const history: string[] = [];
		const seen = new Set([filePath]);
		let current = filePath;
		for (let index = 0; index < 7; index += 1) {
			const previous = this.settings.documentRenameHints[current];
			if (!previous || seen.has(previous)) break;
			history.push(previous);
			seen.add(previous);
			current = previous;
		}
		return history;
	}

	private async rememberDocumentRename(filePath: string, oldPath: string): Promise<void> {
		if (this.syncInProgress || filePath === oldPath) return;
		const hints = { ...this.settings.documentRenameHints, [filePath]: oldPath };
		const entries = Object.entries(hints);
		const capped: Record<string, string> = {};
		for (const [nextPath, previousPath] of entries.slice(Math.max(0, entries.length - 200))) capped[nextPath] = previousPath;
		this.settings.documentRenameHints = capped;
		await this.saveSettings();
		this.followDocumentHistorySurfaces(filePath);
	}

	async loadDocumentHistory(filePath: string, saveEditor = false): Promise<DocumentHistorySnapshot> {
		if (this.syncInProgress) throw new Error('Git is updating. Document history will refresh when the operation finishes.');
		const view = this.markdownViewForPath(filePath);
		let contents = '';
		if (view?.file) {
			if (saveEditor) await view.save();
			contents = view.getViewData();
		} else {
			contents = await this.app.vault.adapter.read(filePath).catch(() => '');
		}
		return new DocumentHistoryService(this.getHistoryGit()).load(filePath, contents, this.documentRenameHistory(filePath));
	}

	async loadDocumentVersionPatch(version: DocumentVersion): Promise<DocumentPatch> {
		if (this.syncInProgress) throw new Error('Git is updating. Try the version again when the operation finishes.');
		return new DocumentHistoryService(this.getHistoryGit()).loadVersionPatch(version.hash, version.path, version.previousPath);
	}

	private async saveOpenDocuments(): Promise<void> {
		const saves: Promise<void>[] = [];
		for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
			if (leaf.view instanceof MarkdownView) saves.push(leaf.view.save());
		}
		await Promise.all(saves);
	}

	async loadLocalChanges(): Promise<LocalChangesSnapshot> {
		if (this.syncInProgress) throw new Error('Git is updating. Local changes will refresh when the operation finishes.');
		await this.saveOpenDocuments();
		return new LocalChangesService(this.getHistoryGit()).load(this.settings.documentRenameHints);
	}

	async loadLocalChangePatch(change: LocalChange): Promise<DocumentPatch> {
		if (this.syncInProgress) throw new Error('Git is updating. Try this file again when the operation finishes.');
		const view = this.markdownViewForPath(change.path);
		let contents = '';
		if (view?.file) {
			await view.save();
			contents = view.getViewData();
		} else if (change.state !== 'deleted') {
			contents = await this.app.vault.adapter.read(change.path).catch(() => '');
		}
		const hints = change.oldPath ? [change.oldPath] : this.documentRenameHistory(change.path);
		const snapshot = await new DocumentHistoryService(this.getHistoryGit()).load(change.path, contents, hints);
		return snapshot.local.patch;
	}

	async openLocalChangeFile(change: LocalChange): Promise<void> {
		if (change.state === 'deleted') {
			this.showNotice('This file was deleted locally. Revert it first if you want to open it.', 'WARNING');
			return;
		}
		await this.app.workspace.openLinkText(change.path, '', true);
	}

	async revertLocalChange(change: LocalChange): Promise<void> {
		await this.withGitLock('Reverting local file', async (progress) => {
			progress.step('Saving open documents');
			await this.saveOpenDocuments();
			progress.step(`Reverting ${change.path}`);
			await applyLocalRevert(change, this.getHistoryGit(), async (filePath) => {
				const file = this.app.vault.getAbstractFileByPath(filePath);
				if (!(file instanceof TFile)) throw new Error(`Could not move ${filePath} to Obsidian trash.`);
				await this.app.vault.trash(file, true);
			});
			for (const filePath of [change.oldPath, change.path].filter((value): value is string => Boolean(value))) {
				const view = this.markdownViewForPath(filePath);
				if (view?.file && await this.app.vault.adapter.exists(filePath)) {
					view.setViewData(await this.app.vault.adapter.read(filePath), false);
				}
			}
			await this.updateBranchStatus();
			return { status: 'success', message: `Reverted local changes in ${change.path}` };
		});
	}

	async openLocalChanges(): Promise<void> {
		let leaf = this.app.workspace.getLeavesOfType(LOCAL_CHANGES_VIEW)[0];
		let created = false;
		if (!leaf) {
			leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf(true);
			await leaf.setViewState({ type: LOCAL_CHANGES_VIEW, active: true });
			created = true;
		}
		await this.app.workspace.revealLeaf(leaf);
		const view = leaf.view;
		if (!created && view instanceof LocalChangesView) void view.refresh();
	}

	private refreshLocalChangesSurfaces(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(LOCAL_CHANGES_VIEW)) {
			const view = leaf.view;
			if (view instanceof LocalChangesView) void view.refresh();
		}
	}

	private revealLocalChangesAfterBlock(): void {
		window.setTimeout(() => void this.openLocalChanges(), 0);
	}

	async openDocumentHistory(filePath?: string): Promise<void> {
		const pathToOpen = filePath ?? this.getActiveDocumentPath();
		if (!pathToOpen) {
			this.showNotice('Open a Markdown document to view its history.', 'WARNING');
			return;
		}
		let leaf = this.app.workspace.getLeavesOfType(DOCUMENT_HISTORY_VIEW)[0];
		if (!leaf) {
			leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf(true);
			await leaf.setViewState({ type: DOCUMENT_HISTORY_VIEW, active: true });
		}
		const view = leaf.view;
		if (view instanceof DocumentHistoryView) await view.showDocument(pathToOpen);
		await this.app.workspace.revealLeaf(leaf);
	}

	private refreshDocumentHistorySurfaces(filePath?: string): void {
		for (const leaf of this.app.workspace.getLeavesOfType(DOCUMENT_HISTORY_VIEW)) {
			const view = leaf.view;
			if (view instanceof DocumentHistoryView) {
				if (filePath) void view.refreshIfDocument(filePath);
				else void view.refresh();
			}
		}
	}

	private followDocumentHistorySurfaces(filePath: string): void {
		for (const leaf of this.app.workspace.getLeavesOfType(DOCUMENT_HISTORY_VIEW)) {
			const view = leaf.view;
			if (view instanceof DocumentHistoryView) void view.followDocument(filePath);
		}
	}

	private getGitHubCliExecutable(): string {
		const configured = this.settings.githubCliPath.trim();
		const homebrewExecutable = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh'].find((candidate) => fs.existsSync(candidate));
		const executable = configured || homebrewExecutable || 'gh';
		if (/[\r\n\0]/.test(executable)) throw new Error('The configured GitHub CLI path is invalid.');
		return executable;
	}

	private getReviewClient(): GitHubReviewClient {
		return new GitHubReviewClient(this.getGitHubCliExecutable());
	}

	private getAuthClient(): GitHubAuthClient {
		return new GitHubAuthClient(this.getGitHubCliExecutable());
	}

	private async ensureGitIdentity(git: SimpleGit): Promise<void> {
		const [name, email] = await Promise.all([
			git.raw(['config', '--get', 'user.name']).catch(() => ''),
			git.raw(['config', '--get', 'user.email']).catch(() => ''),
		]);
		if (name.trim() && email.trim()) return;
		const identity = await this.getAuthClient().authenticatedIdentity();
		if (!name.trim()) await git.raw(['config', '--local', 'user.name', identity.name]);
		if (!email.trim()) {
			const authorEmail = identity.email || `${identity.id}+${identity.login}@users.noreply.github.com`;
			await git.raw(['config', '--local', 'user.email', authorEmail]);
		}
	}

	async getGitHubSetupReadiness(): Promise<GitHubSetupReadiness> {
		let repository: GitHubRepository;
		try {
			repository = parseGitHubRepository(this.settings.remoteURL);
			githubHttpsRemote(repository);
		} catch {
			return {
				gitReady: false,
				vaultRepairable: false,
				vaultReady: false,
				vaultDetail: 'The documentation repository is not configured yet. Run the NuLegal Docs installer.',
				connection: 'unknown',
				detail: 'The documentation repository is not configured yet. Run the NuLegal Docs installer.',
				ready: false,
			};
		}

		let gitReady = false;
		let vaultRepairable = false;
		let vaultReady = false;
		let vaultDetail = 'Run the NuLegal Docs installer to prepare this folder.';
		try {
			const git = this.getGit();
			await git.raw(['--version']);
			gitReady = true;
			const origin = await requireMatchingGitHubOrigin(git, repository);
			vaultRepairable = true;
			const [name, email] = await Promise.all([
				git.raw(['config', '--get', 'user.name']).catch(() => ''),
				git.raw(['config', '--get', 'user.email']).catch(() => ''),
			]);
			if (!name.trim() || !email.trim()) {
				vaultDetail = 'Git author details are missing. Finish GitHub setup to add them safely.';
			} else if (origin.fetch !== githubHttpsRemote(repository) || origin.push !== githubHttpsRemote(repository)) {
				vaultDetail = 'Finish setup to switch this vault from SSH to passwordless HTTPS.';
			} else if (!(await hasEffectiveGitHubCredentialHelper(git))) {
				vaultDetail = 'GitHub is connected, but passwordless Git access needs repair. Choose Finish setup.';
			} else {
				vaultReady = true;
				vaultDetail = 'The documentation vault and passwordless HTTPS remote are ready.';
			}
		} catch (error) {
			vaultDetail = `The documentation vault needs attention: ${redactSensitiveText(error)}`;
		}

		let login: string | undefined;
		try {
			const client = this.getAuthClient();
			login = await client.authenticatedLogin();
			await client.assertRepositoryAccess(repository);
			if (!gitReady || !vaultReady) {
				return {
					gitReady,
					vaultRepairable,
					vaultReady,
					vaultDetail,
					connection: 'connected',
					login,
					repository: `${repository.owner}/${repository.repo}`,
					detail: `Connected as @${login}.`,
					ready: false,
				};
			}
			return {
				gitReady: true,
				vaultRepairable: true,
				vaultReady: true,
				vaultDetail,
				connection: 'connected',
				login,
				repository: `${repository.owner}/${repository.repo}`,
				detail: `Connected as @${login}. GitHub CLI manages the saved credential.`,
				ready: true,
			};
		} catch (error) {
			const problem = classifyGitHubConnectionError(error);
			return {
				gitReady,
				vaultRepairable,
				vaultReady,
				vaultDetail,
				connection: problem.kind,
				login,
				repository: `${repository.owner}/${repository.repo}`,
				detail: problem.message,
				ready: false,
			};
		}
	}

	async connectGitHubInBrowser(signal?: AbortSignal): Promise<GitHubSetupReadiness> {
		if (this.githubConnectionRequest) return this.githubConnectionRequest;
		const request = this.performGitHubBrowserConnection(signal);
		this.githubConnectionRequest = request;
		try {
			return await request;
		} finally {
			if (this.githubConnectionRequest === request) this.githubConnectionRequest = undefined;
		}
	}

	private async performGitHubBrowserConnection(signal?: AbortSignal): Promise<GitHubSetupReadiness> {
		const repository = parseGitHubRepository(this.settings.remoteURL);
		const client = this.getAuthClient();
		const connection = await client.connectWithBrowser(signal);
		await client.assertRepositoryAccess(repository);
		const checked = await this.getGitHubSetupReadiness();
		const readiness = checked.vaultRepairable ? await this.finishGitHubSetup() : checked;
		if (connection.storage === 'plaintext') {
			return {
				...readiness,
				warning: 'GitHub CLI could not use the system credential store and reported plaintext fallback. Ask a workspace administrator to repair Keychain before using this computer for private documentation.',
			};
		}
		return readiness;
	}

	async finishGitHubSetup(): Promise<GitHubSetupReadiness> {
		const repository = parseGitHubRepository(this.settings.remoteURL);
		const httpsRemote = githubHttpsRemote(repository);
		const client = this.getAuthClient();
		await client.authenticatedLogin();
		await client.assertRepositoryAccess(repository);
		const git = this.getGit();
		await requireMatchingGitHubOrigin(git, repository);
		await client.setupGitCredentialHelper();
		const previousRemote = this.settings.remoteURL;
		this.settings.remoteURL = httpsRemote;
		try {
			await this.configureRemote(git);
			await this.ensureGitIdentity(git);
			await this.saveSettings();
			await this.updateBranchStatus(git);
		} catch (error) {
			this.settings.remoteURL = previousRemote;
			throw error;
		}
		this.collaboratorCache = undefined;
		return this.getGitHubSetupReadiness();
	}

	async completeGitHubSetup(): Promise<void> {
		if (!this.settings.setupAssistantSeen) {
			this.settings.setupAssistantSeen = true;
			await this.saveSettings();
		}
	}

	openGitHubSetup(): void {
		new GitHubSetupModal(this.app, this).open();
	}

	private async loadReview(branch?: string): Promise<ReviewSnapshot> {
		const git = this.getGit();
		await this.configureRemote(git);
		const current = branch ?? await this.currentBranch(git);
		if (current === this.getBaseBranch()) throw new Error('Start or switch to a change branch before adding review comments.');
		const repository = parseGitHubRepository(this.settings.remoteURL);
		const client = this.getReviewClient();
		await client.assertAuthenticated();
		const pull = await client.ensureDraftPR(repository, current, this.getBaseBranch());
		const comments = await client.listComments(repository, pull.number);
		return { repository, pull, comments };
	}

	private applyReviewSnapshot(snapshot: ReviewSnapshot): void {
		this.reviewSnapshot = snapshot;
		this.refreshReviewSurfaces();
	}

	private async ensureReview(branch?: string): Promise<ReviewSnapshot> {
		const snapshot = await this.loadReview(branch);
		this.applyReviewSnapshot(snapshot);
		return snapshot;
	}

	private async ensureReviewAfterPush(branch: string): Promise<string | undefined> {
		if (!this.settings.autoCreateDraftPR || branch === this.getBaseBranch()) return undefined;
		try {
			const snapshot = await this.ensureReview(branch);
			return ` · review #${snapshot.pull.number}`;
		} catch (error) {
			this.showReviewError(error);
			this.showNotice(`Branch synced, but review setup needs attention: ${redactSensitiveText(error)}`, 'WARNING', 12000);
			return undefined;
		}
	}

	async getDocumentMentionUsers(): Promise<string[]> {
		if (this.collaboratorCache && this.collaboratorCache.expiresAt > Date.now()) {
			return this.collaboratorCache.users;
		}
		if (this.collaboratorRequest) return this.collaboratorRequest;
		this.collaboratorRequest = (async () => {
			try {
				const repository = parseGitHubRepository(this.settings.remoteURL);
				const client = this.getReviewClient();
				await client.assertAuthenticated();
				const users = await client.listCollaborators(repository);
				this.collaboratorCache = { users, expiresAt: Date.now() + 5 * 60 * 1000 };
				return users;
			} catch {
				return [];
			} finally {
				this.collaboratorRequest = undefined;
			}
		})();
		return this.collaboratorRequest;
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
		const repository = parseGitHubRepository(remote);
		await configureMatchingGitHubOrigin(git, repository, remote);
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
		return { current, base: this.getBaseBranch(), branches, sync, isClean: status.isClean(), localChangeCount: status.files.length };
	}

	openBranchManager(): void {
		new BranchManagerModal(this.app, this).open();
	}

	private async updateBranchStatus(git?: SimpleGit, sync?: BranchSyncSummary): Promise<void> {
		if (!this.branchStatusEl) return;
		try {
			const gitInstance = git ?? this.getGit();
			const branch = await this.currentBranch(gitInstance);
			const branchChanged = Boolean(this.displayedBranch && branch !== this.displayedBranch);
			const status = await gitInstance.status();
			this.displayedDirty = !status.isClean();
			this.displayedDirtyCount = status.files.length;
			await this.setConflictFiles(status.conflicted);
			if (branch !== this.displayedBranch && !sync) this.displayedSync = undefined;
			this.displayedBranch = branch;
			if (sync) this.displayedSync = sync;
			if (branchChanged) this.selectReviewBranch(branch);
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
			if (this.displayedDirty) this.branchStatusEl.createSpan({ cls: 'gh-sync-status__dirty', text: `${this.displayedDirtyCount} local` });
			if (this.conflictedFiles.size > 0) {
				this.branchStatusEl.createSpan({ cls: 'gh-sync-status__conflicts', text: `${this.conflictedFiles.size} conflict${this.conflictedFiles.size === 1 ? '' : 's'}` });
			}
			const stateDescription = this.displayedSync ? ` ${this.displayedSync.label}.` : '';
			const dirtyDescription = this.displayedDirty ? ` Local edits in ${this.displayedDirtyCount} file(s).` : '';
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
		const markdownView = this.markdownViewForPath();
		if (!markdownView?.file) return;
		const titleContainer = markdownView.containerEl.querySelector('.view-header-title-container');
		const header = titleContainer?.closest('.view-header');
		if (!(header instanceof HTMLElement)) return;
		this.headerDocumentPath = markdownView.file.path;

		if (!this.headerBranchBadgeEl) {
			const badge = document.createElement('button');
			badge.type = 'button';
			badge.addClass('gh-sync-header-branch');
			this.registerDomEvent(badge, 'click', () => {
				if (!this.syncInProgress) {
					if (this.conflictedFiles.size > 0) void this.openConflictCenter();
					else if (this.displayedDirty) void this.openLocalChanges();
					else this.openBranchManager();
				}
			});
			this.headerBranchBadgeEl = badge;
			this.register(() => badge.remove());
		}
		if (!this.headerHistoryButtonEl) {
			const history = document.createElement('button');
			history.type = 'button';
			history.addClass('clickable-icon', 'gh-sync-header-history');
			setIcon(history, 'history');
			history.setAttr('aria-label', 'Open history for this document');
			history.setAttr('title', 'Document history');
			this.registerDomEvent(history, 'click', () => void this.openDocumentHistory(this.headerDocumentPath));
			this.headerHistoryButtonEl = history;
			this.register(() => history.remove());
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
		if (this.displayedDirty) this.headerBranchBadgeEl.createSpan({ cls: 'gh-sync-header-branch__dirty', text: `${this.displayedDirtyCount} local` });
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
		const dirtyDescription = this.displayedDirty ? ` Local edits in ${this.displayedDirtyCount} file(s).` : '';
		const conflictDescription = this.conflictedFiles.size > 0 ? ` ${this.conflictedFiles.size} conflicted document(s).` : '';
		const clickDescription = this.conflictedFiles.size > 0
			? 'Open conflict center.'
			: this.displayedDirty
				? 'Open local changes.'
				: 'Open branch manager.';
		this.headerBranchBadgeEl.setAttr('title', `Current documentation branch: ${this.displayedBranch}.${stateDescription}${dirtyDescription}${conflictDescription} ${clickDescription}`);
		this.headerBranchBadgeEl.setAttr('aria-label', `Current documentation branch: ${this.displayedBranch}.${stateDescription}${dirtyDescription}${conflictDescription} ${clickDescription}`);
		const actions = header.querySelector('.view-actions');
		if (actions) {
			header.insertBefore(this.headerBranchBadgeEl, actions);
			header.insertBefore(this.headerHistoryButtonEl, actions);
		} else {
			header.appendChild(this.headerBranchBadgeEl);
			header.appendChild(this.headerHistoryButtonEl);
		}
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
			if (isGitHubCredentialSetupError(error)) {
				progress.complete({
					status: 'warning',
					message: 'GitHub access needs setup. Reconnect the account or repair Git access to continue.',
				});
				this.openGitHubSetup();
			} else {
				progress.fail(error);
			}
		} finally {
			this.syncInProgress = false;
			this.refreshDocumentHistorySurfaces();
			this.refreshLocalChangesSurfaces();
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
		await this.ensureGitIdentity(git);
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

	private selectReviewBranch(branch: string, scheduleRefresh = true): void {
		this.requestedReviewBranch = branch;
		this.reviewSnapshot = undefined;
		this.refreshReviewSurfaces();
		if (scheduleRefresh) window.setTimeout(() => void this.refreshReviews(), 0);
	}

	async refreshReviews(): Promise<void> {
		let branch: string;
		try {
			branch = await this.currentBranch(this.getGit());
		} catch (error) {
			this.showReviewError(error);
			return;
		}
		this.requestedReviewBranch = branch;
		return this.reviewRefresh.run(branch, async () => {
			try {
				const snapshot = await this.loadReview(branch);
				if (this.requestedReviewBranch === branch) this.applyReviewSnapshot(snapshot);
			} catch (error) {
				if (this.requestedReviewBranch === branch) this.showReviewError(error);
			}
		});
	}

	private showReviewError(error: unknown): void {
		this.reviewSnapshot = undefined;
		this.refreshReviewSurfaces();
		for (const leaf of this.app.workspace.getLeavesOfType(REVIEW_CENTER_VIEW)) {
			const view = leaf.view;
			if (view instanceof ReviewCenterView) view.showError(redactSensitiveText(error));
		}
	}

	getReviewSnapshot(): ReviewSnapshot | undefined {
		return this.reviewSnapshot;
	}

	private async getCurrentReviewSnapshot(): Promise<ReviewSnapshot> {
		const branch = await this.currentBranch(this.getGit());
		const snapshot = this.reviewSnapshot;
		if (!snapshot || snapshot.pull.headRefName !== branch) {
			throw new Error('The documentation branch changed. Refresh the Review panel and try again.');
		}
		return snapshot;
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
			await this.refreshReviews();
			const snapshot = await this.getCurrentReviewSnapshot();
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
		try {
			const snapshot = await this.getCurrentReviewSnapshot();
			const collaborators = await this.getReviewClient().listCollaborators(snapshot.repository);
			new ReviewCommentModal(this.app, comment.metadata.anchor, collaborators, async (body) => {
				await this.getReviewClient().createComment(snapshot.repository, snapshot.pull.number, comment.metadata.anchor, body, comment.id);
				await this.refreshReviews();
			}).open();
		} catch (error) {
			this.showNotice(error, 'ERROR', 12000);
		}
	}

	async setReviewResolved(comment: GitHubReviewComment, resolved: boolean): Promise<void> {
		try {
			const snapshot = await this.getCurrentReviewSnapshot();
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
			view.editor.focus();
			if (position.confidence !== 'orphaned' && position.from >= 0 && position.to >= position.from) {
				const from = view.editor.offsetToPos(position.from);
				const to = view.editor.offsetToPos(position.to);
				view.editor.setSelection(from, to);
				view.editor.scrollIntoView({ from, to }, true);
			} else {
				const line = Math.max(0, position.startLine - 1);
				const fallback = { line, ch: 0 };
				view.editor.setCursor(fallback);
				view.editor.scrollIntoView({ from: fallback, to: fallback }, true);
				this.showNotice('The original commented text was removed. Opened its previous line instead.', 'WARNING');
			}
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
		if (provider === 'disabled') throw new Error('Enable an AI provider in Document Versioning settings first.');
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
					this.revealLocalChangesAfterBlock();
					throw new Error(`Review the local files, then sync or revert the edits on ${currentBranch} before starting another change.`);
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

			progress.step('Preparing the branch for discussion');
			await this.ensureGitIdentity(git);
			await createReviewReadyCommit(git, baseBranch, newBranch);
			this.selectReviewBranch(newBranch, false);
			progress.step(`Publishing ${newBranch} to GitHub`);
			await git.push('origin', newBranch, ['-u']);
			progress.step('Preparing documentation review');
			const review = await this.ensureReviewAfterPush(newBranch);
			await this.updateBranchStatus(git, describeBranchSync(0, 0, true));
			return { status: 'success', message: `Started change: ${newBranch}${review ?? ''}` };
		});
	}

	async prepareCurrentReview(): Promise<void> {
		await this.withGitLock('Preparing documentation review', async (progress) => {
			progress.step('Checking the current branch');
			const git = this.getGit();
			await this.configureRemote(git);
			const branch = await this.currentBranch(git);
			const baseBranch = this.getBaseBranch();
			if (branch === baseBranch) throw new Error('Start or switch to a change branch before adding review comments.');
			progress.step('Creating the review starting point');
			await this.ensureGitIdentity(git);
			await createReviewReadyCommit(git, baseBranch, branch);
			progress.step(`Publishing ${branch} to GitHub`);
			await git.push('origin', branch, ['-u']);
			progress.step('Opening the documentation review');
			const review = await this.ensureReview(branch);
			await this.updateBranchStatus(git, describeBranchSync(0, 0, true));
			return { status: 'success', message: `Review #${review.pull.number} is ready for comments` };
		});
	}

	async returnToBaseBranch(): Promise<void> {
		await this.withGitLock('Returning to the accepted branch', async (progress) => {
			progress.step('Checking for unsaved Git changes');
			const git = this.getGit();
			if (!(await git.status()).isClean()) {
				this.revealLocalChangesAfterBlock();
				throw new Error('Review the local files, then sync or revert them before returning to the base branch.');
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
				this.revealLocalChangesAfterBlock();
				throw new Error('Review the local files, then sync or revert them before switching branches.');
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
		this.registerView(DOCUMENT_HISTORY_VIEW, (leaf) => new DocumentHistoryView(leaf, this));
		this.registerView(LOCAL_CHANGES_VIEW, (leaf) => new LocalChangesView(leaf, this));
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
		this.registerEditorExtension(reviewEditorExtension({
			commentOnSelection: () => void this.commentOnSelection(),
		}));
		this.registerEditorSuggest(new DocumentMentionSuggest(this.app, {
			getUsers: () => this.getDocumentMentionUsers(),
		}));
		this.branchStatusEl = this.addStatusBarItem();
		this.branchStatusEl.addClass('gh-sync-status');
		this.branchStatusEl.setAttr('aria-live', 'polite');
		this.registerDomEvent(this.branchStatusEl, 'click', () => {
			if (!this.syncInProgress) {
				if (this.conflictedFiles.size > 0) void this.openConflictCenter();
				else if (this.displayedDirty) void this.openLocalChanges();
				else this.openBranchManager();
			}
		});
		this.registerEvent(this.app.workspace.on('active-leaf-change', () => {
			window.setTimeout(() => {
				this.renderHeaderBranchBadge();
				const activePath = this.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path;
				if (activePath) this.followDocumentHistorySurfaces(activePath);
			}, 0);
		}));
		this.registerEvent(this.app.workspace.on('layout-change', () => this.renderHeaderBranchBadge()));
		this.registerEvent(this.app.workspace.on('editor-menu', (menu: Menu, editor: Editor, info) => {
			const markdownView = info instanceof MarkdownView ? info : undefined;
			if (markdownView?.file) {
				menu.addItem((item) => item
					.setTitle('View document history')
					.setIcon('history')
					.onClick(() => void this.openDocumentHistory(markdownView.file?.path)));
			}
			if (editor.getSelection()) {
				menu.addItem((item) => item
					.setTitle('Comment on selection')
					.setIcon('message-square-plus')
					.onClick(() => void this.commentOnSelection(editor, markdownView)));
			}
		}));
		this.registerEvent(this.app.vault.on('modify', (file) => {
			if (this.dirtyRefreshTimer) window.clearTimeout(this.dirtyRefreshTimer);
			this.dirtyRefreshTimer = window.setTimeout(() => {
				if (!this.syncInProgress) {
					void this.updateBranchStatus();
					this.refreshDocumentHistorySurfaces(file.path);
					this.refreshLocalChangesSurfaces();
				}
			}, 350);
		}));
		this.registerEvent(this.app.vault.on('create', () => {
			if (!this.syncInProgress) this.refreshLocalChangesSurfaces();
		}));
		this.registerEvent(this.app.vault.on('delete', () => {
			if (!this.syncInProgress) this.refreshLocalChangesSurfaces();
		}));
		this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
			if (file instanceof TFile && file.extension === 'md') void this.rememberDocumentRename(file.path, oldPath);
			if (!this.syncInProgress) this.refreshLocalChangesSurfaces();
		}));

		const ribbonIconEl = this.addRibbonIcon('github', 'Sync current branch', () => void this.syncNotes());
		ribbonIconEl.addClass('gh-sync-ribbon');
		const branchRibbonEl = this.addRibbonIcon('git-branch', 'Open branch manager', () => {
			if (!this.syncInProgress) this.openBranchManager();
		});
		branchRibbonEl.addClass('gh-sync-branch-ribbon');
		const changesRibbonEl = this.addRibbonIcon('files', 'Open local changes', () => {
			if (!this.syncInProgress) void this.openLocalChanges();
		});
		changesRibbonEl.addClass('gh-sync-changes-ribbon');
		const reviewRibbonEl = this.addRibbonIcon('messages-square', 'Open documentation review', () => {
			if (!this.syncInProgress) void this.openReviewCenter();
		});
		reviewRibbonEl.addClass('gh-sync-review-ribbon');
		this.gitControlEls.push(ribbonIconEl, branchRibbonEl, changesRibbonEl);

		this.addCommand({ id: 'github-sync-command', name: 'Sync current branch', callback: () => void this.syncNotes() });
		this.addCommand({ id: 'github-sync-update-current', name: 'Update current branch from GitHub', callback: () => void this.updateCurrentBranch() });
		this.addCommand({ id: 'github-sync-branch-manager', name: 'Open branch manager', callback: () => this.openBranchManager() });
		this.addCommand({ id: 'github-sync-local-changes', name: 'Open local changes', callback: () => void this.openLocalChanges() });
		this.addCommand({ id: 'github-sync-conflict-center', name: 'Open conflict center', callback: () => void this.openConflictCenter() });
		this.addCommand({ id: 'github-sync-review-center', name: 'Open review center', callback: () => void this.openReviewCenter() });
		this.addCommand({
			id: 'github-sync-document-history',
			name: 'Open history for current document',
			editorCheckCallback: (checking, _editor, view) => {
				if (!(view instanceof MarkdownView) || !view.file) return false;
				if (!checking) void this.openDocumentHistory(view.file.path);
				return true;
			},
		});
		this.addCommand({ id: 'github-sync-setup', name: 'Open GitHub connection setup', callback: () => void this.openGitHubSetup() });
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
		this.app.workspace.onLayoutReady(() => {
			if (!this.settings.setupAssistantSeen) {
				window.setTimeout(() => void this.openGitHubSetup(), 500);
			}
		});

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

function renderDocumentPatch(container: HTMLElement, patch: DocumentPatch, label: string): void {
	if (!patch.text.trim()) {
		container.createDiv({ cls: 'gh-sync-document-history__no-patch', text: 'No text changes to preview for this file.' });
		return;
	}
	const patchEl = container.createEl('pre', {
		cls: 'gh-sync-document-patch',
		attr: { tabindex: '0', role: 'region', 'aria-label': label },
	});
	for (const line of patch.text.split('\n')) {
		let cls = 'gh-sync-document-patch__line';
		if (line.startsWith('+') && !line.startsWith('+++')) cls += ' is-addition';
		else if (line.startsWith('-') && !line.startsWith('---')) cls += ' is-deletion';
		else if (line.startsWith('@@')) cls += ' is-hunk';
		else if (/^(?:diff --git|index |--- |\+\+\+ |…)/.test(line)) cls += ' is-meta';
		patchEl.createSpan({ cls, text: line || ' ' });
	}
}

class LocalChangesView extends ItemView {
	private snapshot?: LocalChangesSnapshot;
	private error?: string;
	private loading = false;
	private requestId = 0;
	private expandedKey?: string;
	private loadingPatch?: string;
	private readonly patches = new Map<string, DocumentPatch>();
	private readonly patchErrors = new Map<string, string>();

	constructor(leaf: WorkspaceLeaf, private readonly plugin: GHSyncPlugin) {
		super(leaf);
	}

	getViewType(): string { return LOCAL_CHANGES_VIEW; }
	getDisplayText(): string { return 'Local changes'; }
	getIcon(): string { return 'files'; }

	async onOpen(): Promise<void> {
		await this.refresh();
	}

	private changeKey(change: LocalChange): string {
		return `${change.oldPath ?? ''}\0${change.path}\0${change.code}`;
	}

	async refresh(): Promise<void> {
		const requestId = ++this.requestId;
		this.loading = true;
		this.error = undefined;
		this.render();
		try {
			const snapshot = await this.plugin.loadLocalChanges();
			if (requestId !== this.requestId) return;
			this.snapshot = snapshot;
			const visibleKeys = new Set(snapshot.changes.map((change) => this.changeKey(change)));
			if (this.expandedKey && !visibleKeys.has(this.expandedKey)) this.expandedKey = undefined;
			for (const key of Array.from(this.patches.keys())) if (!visibleKeys.has(key)) this.patches.delete(key);
			for (const key of Array.from(this.patchErrors.keys())) if (!visibleKeys.has(key)) this.patchErrors.delete(key);
		} catch (error) {
			if (requestId === this.requestId) this.error = redactSensitiveText(error);
		} finally {
			if (requestId === this.requestId) {
				this.loading = false;
				this.render();
			}
		}
	}

	private async togglePatch(change: LocalChange): Promise<void> {
		const key = this.changeKey(change);
		if (this.expandedKey === key) {
			this.expandedKey = undefined;
			this.render();
			return;
		}
		this.expandedKey = key;
		this.render();
		if (this.patches.has(key) || this.patchErrors.has(key)) return;
		this.loadingPatch = key;
		this.render();
		try {
			this.patches.set(key, await this.plugin.loadLocalChangePatch(change));
		} catch (error) {
			this.patchErrors.set(key, redactSensitiveText(error));
		} finally {
			if (this.loadingPatch === key) this.loadingPatch = undefined;
			if (this.expandedKey === key) this.render();
		}
	}

	private confirmRevert(change: LocalChange): void {
		new LocalChangeRevertModal(this.app, change, async () => {
			await this.plugin.revertLocalChange(change);
			await this.refresh();
		}).open();
	}

	private render(): void {
		this.contentEl.empty();
		this.contentEl.addClass('gh-sync-local-changes');
		this.contentEl.setAttr('aria-busy', String(this.loading));
		const header = this.contentEl.createDiv({ cls: 'gh-sync-local-changes__header' });
		const heading = header.createDiv();
		heading.createEl('h3', { text: 'Local changes' });
		heading.createEl('p', { text: 'Everything changed on this computer before the next sync.' });
		const refresh = header.createEl('button', {
			cls: 'clickable-icon',
			attr: { type: 'button', 'aria-label': 'Refresh local changes' },
		});
		setIcon(refresh, 'refresh-cw');
		refresh.disabled = this.loading;
		refresh.addEventListener('click', () => void this.refresh());

		if (this.loading && !this.snapshot) {
			const loading = this.contentEl.createDiv({ cls: 'gh-sync-local-changes__empty' });
			setIcon(loading.createSpan({ cls: 'gh-sync-document-history__spinner' }), 'loader-circle');
			loading.createDiv({ cls: 'gh-sync-local-changes__empty-title', text: 'Checking this vault…' });
			return;
		}
		if (this.error && !this.snapshot) {
			const error = this.contentEl.createDiv({ cls: 'gh-sync-local-changes__empty is-error' });
			setIcon(error.createSpan(), 'circle-alert');
			error.createDiv({ cls: 'gh-sync-local-changes__empty-title', text: 'Could not read local changes' });
			error.createEl('p', { text: this.error });
			return;
		}
		const snapshot = this.snapshot;
		if (!snapshot) return;

		const summary = this.contentEl.createDiv({ cls: 'gh-sync-local-changes__summary' });
		const branch = summary.createSpan();
		setIcon(branch.createSpan(), 'git-branch');
		branch.createSpan({ text: snapshot.branch });
		summary.createSpan({
			cls: 'gh-sync-local-changes__count',
			text: `${snapshot.changes.length} file${snapshot.changes.length === 1 ? '' : 's'}`,
		});
		if (this.error) {
			const warning = this.contentEl.createDiv({ cls: 'gh-sync-document-history__warning', attr: { role: 'status' } });
			setIcon(warning.createSpan(), 'circle-alert');
			warning.createSpan({ text: `Showing the last loaded changes. Refresh failed: ${this.error}` });
		}
		if (snapshot.changes.length === 0) {
			const empty = this.contentEl.createDiv({ cls: 'gh-sync-local-changes__empty is-clean' });
			setIcon(empty.createSpan(), 'circle-check');
			empty.createDiv({ cls: 'gh-sync-local-changes__empty-title', text: 'No local changes' });
			empty.createEl('p', { text: 'Every file matches the latest saved version on this branch.' });
			return;
		}

		for (const group of groupLocalChangesByFolder(snapshot.changes)) {
			const section = this.contentEl.createDiv({ cls: 'gh-sync-local-changes__group' });
			const groupHeader = section.createDiv({ cls: 'gh-sync-local-changes__group-header' });
			groupHeader.createSpan({ text: group.folder });
			groupHeader.createSpan({ text: String(group.changes.length) });
			const list = section.createDiv({ cls: 'gh-sync-local-changes__list' });
			for (const change of group.changes) {
				const key = this.changeKey(change);
				const description = describeLocalChange(change);
				const item = list.createDiv({ cls: `gh-sync-local-change is-${change.state}${this.expandedKey === key ? ' is-expanded' : ''}` });
				const row = item.createDiv({ cls: 'gh-sync-local-change__row' });
				const disclosure = row.createEl('button', {
					cls: 'gh-sync-local-change__disclosure',
					attr: { type: 'button', 'aria-expanded': String(this.expandedKey === key) },
				});
				const stateIcon = disclosure.createSpan({ cls: 'gh-sync-local-change__icon' });
				setIcon(stateIcon, description.icon);
				const copy = disclosure.createDiv({ cls: 'gh-sync-local-change__copy' });
				copy.createDiv({ cls: 'gh-sync-local-change__name', text: change.path.split('/').pop() || change.path });
				copy.createDiv({ cls: 'gh-sync-local-change__detail', text: description.detail });
				disclosure.createSpan({ cls: `gh-sync-local-change__state is-${change.state}`, text: description.label });
				const chevron = disclosure.createSpan({ cls: 'gh-sync-local-change__chevron' });
				setIcon(chevron, this.expandedKey === key ? 'chevron-down' : 'chevron-right');
				disclosure.addEventListener('click', () => void this.togglePatch(change));

				const actions = row.createDiv({ cls: 'gh-sync-local-change__actions' });
				if (change.state !== 'deleted') {
					const open = actions.createEl('button', {
						cls: 'clickable-icon',
						attr: { type: 'button', 'aria-label': `Open ${change.path}`, title: 'Open file' },
					});
					setIcon(open, 'file-text');
					open.addEventListener('click', () => void this.plugin.openLocalChangeFile(change));
				}
				const revert = actions.createEl('button', {
					cls: 'clickable-icon gh-sync-local-change__revert',
					attr: { type: 'button', 'aria-label': `Revert local changes in ${change.path}`, title: 'Revert this file' },
				});
				setIcon(revert, 'undo-2');
				revert.addEventListener('click', () => this.confirmRevert(change));

				if (this.expandedKey === key) {
					const detail = item.createDiv({ cls: 'gh-sync-local-change__patch' });
					if (this.loadingPatch === key) {
						const loading = detail.createDiv({ cls: 'gh-sync-document-version__loading' });
						setIcon(loading.createSpan({ cls: 'gh-sync-document-history__spinner' }), 'loader-circle');
						loading.createSpan({ text: 'Loading file diff…' });
					} else if (this.patchErrors.has(key)) {
						detail.createDiv({ cls: 'gh-sync-document-version__error', text: this.patchErrors.get(key) });
					} else {
						const patch = this.patches.get(key);
						if (patch) renderDocumentPatch(detail, patch, `Local changes in ${change.path}`);
					}
				}
			}
		}
	}
}

class LocalChangeRevertModal extends Modal {
	constructor(
		app: App,
		private readonly change: LocalChange,
		private readonly onConfirm: () => Promise<void>,
	) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.addClass('gh-sync-local-revert');
		this.contentEl.createEl('h2', { text: 'Revert this file?' });
		this.contentEl.createEl('p', { text: this.change.path });
		this.contentEl.createEl('p', {
			cls: 'gh-sync-local-revert__warning',
			text: this.change.state === 'added'
				? 'The new file will be moved to the macOS Trash.'
				: 'All local edits in this file will be replaced by its latest saved Git version.',
		});
		const actions = new Setting(this.contentEl);
		actions.addButton((button) => button.setButtonText('Keep changes').onClick(() => this.close()));
		actions.addButton((button) => button.setButtonText('Revert file').setWarning().onClick(() => {
			this.close();
			void this.onConfirm();
		}));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class DocumentHistoryView extends ItemView {
	private filePath?: string;
	private snapshot?: DocumentHistorySnapshot;
	private error?: string;
	private loading = false;
	private requestId = 0;
	private documentGeneration = 0;
	private expandedVersionKey?: string;
	private readonly patches = new Map<string, DocumentPatch>();
	private readonly patchErrors = new Map<string, string>();
	private loadingPatch?: string;

	constructor(leaf: WorkspaceLeaf, private readonly plugin: GHSyncPlugin) {
		super(leaf);
	}

	getViewType(): string { return DOCUMENT_HISTORY_VIEW; }
	getDisplayText(): string { return 'Document history'; }
	getIcon(): string { return 'history'; }

	async onOpen(): Promise<void> {
		const activePath = this.plugin.getActiveDocumentPath();
		if (activePath) await this.showDocument(activePath);
		else this.render();
	}

	async showDocument(filePath: string): Promise<void> {
		const changed = this.filePath !== filePath;
		this.filePath = filePath;
		if (changed) {
			this.documentGeneration += 1;
			this.snapshot = undefined;
			this.expandedVersionKey = undefined;
			this.loadingPatch = undefined;
			this.patches.clear();
			this.patchErrors.clear();
		}
		await this.loadHistory(true);
	}

	async followDocument(filePath: string): Promise<void> {
		if (this.filePath === filePath) return;
		await this.showDocument(filePath);
	}

	async refreshIfDocument(filePath: string): Promise<void> {
		if (this.filePath === filePath) await this.refresh();
	}

	async refresh(): Promise<void> {
		if (!this.filePath) {
			const activePath = this.plugin.getActiveDocumentPath();
			if (!activePath) {
				this.render();
				return;
			}
			this.filePath = activePath;
		}
		await this.loadHistory(false);
	}

	private async loadHistory(saveEditor: boolean): Promise<void> {
		if (!this.filePath) return;
		const requestedPath = this.filePath;
		const requestId = ++this.requestId;
		this.loading = true;
		this.error = undefined;
		this.render();
		try {
			const snapshot = await this.plugin.loadDocumentHistory(requestedPath, saveEditor);
			if (requestId !== this.requestId || requestedPath !== this.filePath) return;
			this.patchErrors.clear();
			this.snapshot = snapshot;
		} catch (error) {
			if (requestId !== this.requestId || requestedPath !== this.filePath) return;
			this.error = redactSensitiveText(error);
		} finally {
			if (requestId === this.requestId && requestedPath === this.filePath) {
				this.loading = false;
				this.render();
			}
		}
	}

	private stateCopy(state: DocumentHistorySnapshot['local']['state']): { title: string; detail: string } {
		switch (state) {
			case 'clean': return { title: 'No local changes', detail: 'This document matches its latest saved version.' };
			case 'untracked': return { title: 'New document — not synced yet', detail: 'This document has not been included in a saved Git version.' };
			case 'conflicted': return { title: 'Document has a conflict', detail: 'Resolve the highlighted sections before syncing.' };
			case 'renamed': return { title: 'Renamed locally — not synced yet', detail: 'The new document name has not been synchronized.' };
			case 'staged': return { title: 'Local changes — ready to save', detail: 'These edits are staged locally but have not been synchronized.' };
			case 'staged-and-modified': return { title: 'Local changes — not synced yet', detail: 'This document has both prepared and newer local edits.' };
			default: return { title: 'Local changes — not synced yet', detail: 'These edits exist only on this computer until you sync.' };
		}
	}

	private renderPatch(container: HTMLElement, patch: DocumentPatch, label: string): void {
		if (!patch.text.trim()) {
			container.createDiv({ cls: 'gh-sync-document-history__no-patch', text: 'No text changes to preview for this version.' });
			return;
		}
		const patchEl = container.createEl('pre', {
			cls: 'gh-sync-document-patch',
			attr: { tabindex: '0', role: 'region', 'aria-label': label },
		});
		for (const line of patch.text.split('\n')) {
			let cls = 'gh-sync-document-patch__line';
			if (line.startsWith('+') && !line.startsWith('+++')) cls += ' is-addition';
			else if (line.startsWith('-') && !line.startsWith('---')) cls += ' is-deletion';
			else if (line.startsWith('@@')) cls += ' is-hunk';
			else if (/^(?:diff --git|index |--- |\+\+\+ |…)/.test(line)) cls += ' is-meta';
			patchEl.createSpan({ cls, text: line || ' ' });
		}
	}

	private versionKey(version: DocumentVersion): string {
		return `${version.hash}\0${version.path}\0${version.previousPath ?? ''}`;
	}

	private async toggleVersion(version: DocumentVersion): Promise<void> {
		const key = this.versionKey(version);
		if (this.expandedVersionKey === key) {
			this.expandedVersionKey = undefined;
			this.render();
			return;
		}
		this.expandedVersionKey = key;
		this.render();
		if (this.patches.has(key) || this.patchErrors.has(key)) return;
		const generation = this.documentGeneration;
		const requestedPath = this.filePath;
		this.loadingPatch = key;
		this.render();
		try {
			const patch = await this.plugin.loadDocumentVersionPatch(version);
			if (generation === this.documentGeneration && requestedPath === this.filePath) this.patches.set(key, patch);
		} catch (error) {
			if (generation === this.documentGeneration && requestedPath === this.filePath) this.patchErrors.set(key, redactSensitiveText(error));
		} finally {
			if (generation === this.documentGeneration && this.loadingPatch === key) this.loadingPatch = undefined;
			if (generation === this.documentGeneration && this.expandedVersionKey === key) this.render();
		}
	}

	private render(): void {
		this.contentEl.empty();
		this.contentEl.addClass('gh-sync-document-history');
		this.contentEl.setAttr('aria-busy', String(this.loading));
		this.contentEl.setAttr('aria-live', 'polite');
		const header = this.contentEl.createDiv({ cls: 'gh-sync-document-history__header' });
		const heading = header.createDiv({ cls: 'gh-sync-document-history__heading' });
		heading.createEl('h3', { text: 'Document history' });
		heading.createEl('p', { text: this.filePath ?? 'Open a Markdown document to inspect its changes.' });
		const refresh = header.createEl('button', {
			cls: 'clickable-icon',
			attr: { type: 'button', 'aria-label': 'Refresh document history' },
		});
		setIcon(refresh, 'refresh-cw');
		refresh.disabled = this.loading || !this.filePath;
		refresh.addEventListener('click', () => {
			if (!this.filePath) return;
			void this.loadHistory(true);
		});

		if (!this.filePath) {
			const empty = this.contentEl.createDiv({ cls: 'gh-sync-document-history__empty' });
			setIcon(empty.createSpan(), 'file-clock');
			empty.createDiv({ cls: 'gh-sync-document-history__empty-title', text: 'No document selected' });
			empty.createEl('p', { text: 'Open a Markdown document, then use its history button.' });
			return;
		}
		if (this.loading && !this.snapshot) {
			const loading = this.contentEl.createDiv({ cls: 'gh-sync-document-history__empty' });
			const icon = loading.createSpan({ cls: 'gh-sync-document-history__spinner' });
			setIcon(icon, 'loader-circle');
			loading.createDiv({ cls: 'gh-sync-document-history__empty-title', text: 'Loading document changes…' });
			loading.createEl('p', { text: 'Reading local Git history. GitHub is not contacted.' });
			return;
		}
		if (this.error && !this.snapshot) {
			const error = this.contentEl.createDiv({ cls: 'gh-sync-document-history__empty is-error' });
			setIcon(error.createSpan(), 'circle-alert');
			error.createDiv({ cls: 'gh-sync-document-history__empty-title', text: 'Could not read document history' });
			error.createEl('p', { text: this.error });
			return;
		}
		const snapshot = this.snapshot;
		if (!snapshot) return;

		const context = this.contentEl.createDiv({ cls: 'gh-sync-document-history__context' });
		setIcon(context.createSpan(), 'git-branch');
		context.createSpan({ text: snapshot.branch });
		context.createSpan({ cls: 'gh-sync-document-history__offline', text: 'Local history' });
		if (this.error) {
			const warning = this.contentEl.createDiv({ cls: 'gh-sync-document-history__warning', attr: { role: 'status' } });
			setIcon(warning.createSpan(), 'circle-alert');
			warning.createSpan({ text: `Showing the last loaded history. Refresh failed: ${this.error}` });
		}

		const localCopy = this.stateCopy(snapshot.local.state);
		const local = this.contentEl.createDiv({ cls: `gh-sync-document-history__local is-${snapshot.local.state}` });
		const localHeader = local.createDiv({ cls: 'gh-sync-document-history__local-header' });
		const localIcon = localHeader.createSpan({ cls: 'gh-sync-document-history__local-icon' });
		setIcon(localIcon, snapshot.local.state === 'clean' ? 'circle-check' : snapshot.local.state === 'conflicted' ? 'triangle-alert' : 'file-pen-line');
		const localCopyEl = localHeader.createDiv({ cls: 'gh-sync-document-history__local-copy' });
		localCopyEl.createDiv({ cls: 'gh-sync-document-history__local-title', text: localCopy.title });
		localCopyEl.createDiv({ cls: 'gh-sync-document-history__local-detail', text: localCopy.detail });
		if (snapshot.local.state !== 'clean') {
			const stats = localHeader.createDiv({ cls: 'gh-sync-document-history__stats' });
			if (snapshot.local.patch.additions > 0) stats.createSpan({ cls: 'is-addition', text: `+${snapshot.local.patch.additions}` });
			if (snapshot.local.patch.deletions > 0) stats.createSpan({ cls: 'is-deletion', text: `−${snapshot.local.patch.deletions}` });
		}
		if (snapshot.local.state !== 'clean') this.renderPatch(local, snapshot.local.patch, 'Current local document changes');

		const versionsHeader = this.contentEl.createDiv({ cls: 'gh-sync-document-history__versions-header' });
		versionsHeader.createEl('h4', { text: 'Saved versions' });
		versionsHeader.createSpan({ text: String(snapshot.versions.length) });
		if (snapshot.versions.length === 0) {
			this.contentEl.createDiv({ cls: 'gh-sync-document-history__no-versions', text: 'This document has no committed versions yet.' });
			return;
		}

		const list = this.contentEl.createDiv({ cls: 'gh-sync-document-history__versions' });
		for (const version of snapshot.versions) {
			const key = this.versionKey(version);
			const item = list.createDiv({ cls: `gh-sync-document-version${this.expandedVersionKey === key ? ' is-expanded' : ''}` });
			const button = item.createEl('button', {
				cls: 'gh-sync-document-version__button',
				attr: { type: 'button', 'aria-expanded': String(this.expandedVersionKey === key) },
			});
			const icon = button.createSpan({ cls: 'gh-sync-document-version__icon' });
			setIcon(icon, this.expandedVersionKey === key ? 'chevron-down' : 'chevron-right');
			const copy = button.createDiv({ cls: 'gh-sync-document-version__copy' });
			copy.createDiv({ cls: 'gh-sync-document-version__subject', text: version.subject });
			const timestamp = Number.isNaN(Date.parse(version.timestamp)) ? version.timestamp : new Date(version.timestamp).toLocaleString();
			copy.createDiv({ cls: 'gh-sync-document-version__meta', text: `${version.author} · ${timestamp}` });
			const badges = button.createDiv({ cls: 'gh-sync-document-version__badges' });
			if (version.localOnly) badges.createSpan({ cls: 'is-local', text: 'Not pushed yet' });
			if (version.additions > 0) badges.createSpan({ cls: 'is-addition', text: `+${version.additions}` });
			if (version.deletions > 0) badges.createSpan({ cls: 'is-deletion', text: `−${version.deletions}` });
			button.addEventListener('click', () => void this.toggleVersion(version));

			if (this.expandedVersionKey === key) {
				const detail = item.createDiv({ cls: 'gh-sync-document-version__detail' });
				detail.createDiv({ cls: 'gh-sync-document-version__detail-title', text: 'What changed in this version' });
				if (this.loadingPatch === key) {
					const loading = detail.createDiv({ cls: 'gh-sync-document-version__loading' });
					setIcon(loading.createSpan({ cls: 'gh-sync-document-history__spinner' }), 'loader-circle');
					loading.createSpan({ text: 'Loading version…' });
				} else if (this.patchErrors.has(key)) {
					detail.createDiv({ cls: 'gh-sync-document-version__error', text: this.patchErrors.get(key) });
				} else {
					const patch = this.patches.get(key);
					if (patch) this.renderPatch(detail, patch, `Changes saved in ${version.subject}`);
				}
			}
		}
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
		activateReviewCenter(() => this.refresh(), () => this.plugin.refreshReviews());
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
			if (this.error) {
				empty.createEl('p', { text: 'Your documents are safe. Use the guided setup below—no SSH key or terminal login is required.' });
				const actions = empty.createDiv({ cls: 'gh-sync-review-center__empty-actions' });
				if (/no commits between/i.test(this.error)) {
					const prepare = actions.createEl('button', { cls: 'mod-cta', text: 'Prepare review', attr: { type: 'button' } });
					prepare.addEventListener('click', () => void this.plugin.prepareCurrentReview());
				}
				const connect = actions.createEl('button', { text: 'GitHub setup', attr: { type: 'button' } });
				connect.addEventListener('click', () => void this.plugin.openGitHubSetup());
				const retry = actions.createEl('button', { text: 'Check again', attr: { type: 'button' } });
				retry.addEventListener('click', () => {
					this.error = undefined;
					void this.plugin.refreshReviews();
				});
			}
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
			const openComment = (): void => void this.plugin.openReviewComment(comment);
			location.addEventListener('click', openComment);
			top.createSpan({ cls: `gh-sync-review-thread__state${comment.metadata.state === 'resolved' ? ' is-resolved' : ''}`, text: comment.metadata.state === 'resolved' ? 'Resolved' : 'Open' });

			const quote = thread.createEl('blockquote', { text: comment.metadata.anchor.selectedText.slice(0, 500) });
			if (comment.metadata.anchor.selectedText.length > 500) quote.createSpan({ text: '…' });
			const body = thread.createDiv({ cls: 'gh-sync-review-thread__body', text: comment.body.replace(/^(?:>.*\n?)+\s*/m, '') });
			body.setAttr('data-author', `@${comment.author}`);
			for (const target of [quote, body]) {
				target.addClass('gh-sync-review-thread__navigation-target');
				target.setAttr('role', 'link');
				target.setAttr('tabindex', '0');
				target.setAttr('aria-label', `Open ${comment.metadata.anchor.path} and select the commented text`);
				target.addEventListener('click', openComment);
				target.addEventListener('keydown', (event: KeyboardEvent) => {
					if (event.key !== 'Enter' && event.key !== ' ') return;
					event.preventDefault();
					openComment();
				});
			}
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
		const composer = this.contentEl.createDiv({ cls: 'gh-sync-review-modal__composer' });
		const textarea = composer.createEl('textarea', {
			cls: 'gh-sync-review-modal__input',
			attr: {
				placeholder: 'Add context or a decision. Type @ to notify a collaborator.',
				rows: '6',
				maxlength: '20000',
				role: 'combobox',
				'aria-autocomplete': 'list',
				'aria-controls': 'gh-sync-mention-suggestions',
				'aria-expanded': 'false',
			},
		});
		const suggestions = composer.createDiv({
			cls: 'gh-sync-review-modal__suggestions',
			attr: { id: 'gh-sync-mention-suggestions', role: 'listbox', 'aria-label': 'GitHub collaborators' },
		});
		const mentionHint = this.contentEl.createDiv({
			cls: 'gh-sync-review-modal__mention-hint',
			text: this.collaborators.length > 0
				? 'Type @ to search and notify a GitHub collaborator.'
				: 'No repository collaborators were returned by GitHub.',
		});
		let activeMention: MentionQuery | undefined;
		let matches: string[] = [];
		let selectedIndex = 0;
		const chooseMention = (user: string): void => {
			if (!activeMention) return;
			const applied = applyMention(textarea.value, activeMention, user);
			textarea.value = applied.text;
			textarea.setSelectionRange(applied.cursor, applied.cursor);
			this.body = textarea.value;
			suggestions.empty();
			suggestions.removeClass('is-visible');
			textarea.setAttr('aria-expanded', 'false');
			textarea.focus();
		};
		const renderSuggestions = (): void => {
			activeMention = mentionQueryAt(textarea.value, textarea.selectionStart);
			matches = activeMention ? matchingMentions(this.collaborators, activeMention.query) : [];
			selectedIndex = Math.min(selectedIndex, Math.max(0, matches.length - 1));
			suggestions.empty();
			if (!activeMention || this.collaborators.length === 0) {
				suggestions.removeClass('is-visible');
				textarea.setAttr('aria-expanded', 'false');
				return;
			}
			if (matches.length === 0) {
				suggestions.createDiv({ cls: 'gh-sync-review-modal__suggestion-empty', text: `No users match “${activeMention.query}”` });
			} else {
				matches.forEach((user, index) => {
					const option = suggestions.createEl('button', {
						cls: `gh-sync-review-modal__suggestion${index === selectedIndex ? ' is-selected' : ''}`,
						attr: { type: 'button', role: 'option', 'aria-selected': String(index === selectedIndex) },
					});
					const avatar = option.createSpan({ cls: 'gh-sync-review-modal__suggestion-avatar', text: user.slice(0, 1).toUpperCase() });
					avatar.setAttr('aria-hidden', 'true');
					option.createSpan({ text: `@${user}` });
					option.addEventListener('mousedown', (event) => event.preventDefault());
					option.addEventListener('click', () => chooseMention(user));
				});
			}
			suggestions.addClass('is-visible');
			textarea.setAttr('aria-expanded', 'true');
		};
		textarea.addEventListener('input', () => {
			this.body = textarea.value;
			selectedIndex = 0;
			renderSuggestions();
		});
		textarea.addEventListener('click', renderSuggestions);
		textarea.addEventListener('keydown', (event) => {
			if (!suggestions.hasClass('is-visible') || matches.length === 0) return;
			if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
				event.preventDefault();
				selectedIndex = (selectedIndex + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
				renderSuggestions();
			} else if (event.key === 'Enter' || event.key === 'Tab') {
				event.preventDefault();
				chooseMention(matches[selectedIndex]);
			} else if (event.key === 'Escape') {
				event.preventDefault();
				suggestions.removeClass('is-visible');
				textarea.setAttr('aria-expanded', 'false');
			}
		});
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
				currentSetting.nameEl.createSpan({
					cls: 'gh-sync-state-pill is-dirty',
					text: `${snapshot.localChangeCount} local file${snapshot.localChangeCount === 1 ? '' : 's'}`,
				});
				currentSetting.addButton((button) => button.setButtonText('Review changes').onClick(() => {
					this.close();
					void this.plugin.openLocalChanges();
				}));
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
			if (!isGitHubCredentialSetupError(error)) {
				loading.setText(`Could not load branches: ${redactSensitiveText(error)}`);
				return;
			}
			loading.remove();
			new Setting(this.contentEl)
				.setName('GitHub access needs setup')
				.setDesc('Git cannot authenticate this computer. Open setup to reconnect the account or repair Git access.')
				.addButton((button) => button.setButtonText('Open GitHub setup').setCta().onClick(() => {
					this.close();
					this.plugin.openGitHubSetup();
				}));
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

class GitHubSetupModal extends Modal {
	private readiness?: GitHubSetupReadiness;
	private busy: 'checking' | 'connecting' | 'finishing' | undefined;
	private operationError?: string;
	private authAbort?: AbortController;
	private closed = false;

	constructor(app: App, private readonly plugin: GHSyncPlugin) {
		super(app);
	}

	onOpen(): void {
		this.closed = false;
		this.modalEl.addClass('gh-sync-setup-modal');
		this.render();
		void this.check();
	}

	private renderStep(
		container: HTMLElement,
		title: string,
		detail: string,
		state: 'ready' | 'action' | 'pending',
	): void {
		const step = container.createDiv({ cls: `gh-sync-setup-step is-${state}` });
		const icon = step.createSpan({ cls: `gh-sync-setup-step__icon${state === 'pending' ? ' gh-sync-operation__spinner' : ''}` });
		setIcon(icon, state === 'ready' ? 'circle-check' : state === 'action' ? 'circle-alert' : 'loader-circle');
		const copy = step.createDiv({ cls: 'gh-sync-setup-step__copy' });
		copy.createDiv({ cls: 'gh-sync-setup-step__title', text: title });
		copy.createDiv({ cls: 'gh-sync-setup-step__detail', text: detail });
	}

	private render(): void {
		this.contentEl.empty();
		const hero = this.contentEl.createDiv({ cls: 'gh-sync-setup__hero' });
		const heroIcon = hero.createSpan({ cls: 'gh-sync-setup__hero-icon' });
		setIcon(heroIcon, 'github');
		const heroCopy = hero.createDiv();
		heroCopy.createEl('h2', { text: 'Connect documentation to GitHub' });
		heroCopy.createEl('p', { text: 'Approve once in your browser. No SSH keys, access tokens, or terminal commands are needed here.' });

		const steps = this.contentEl.createDiv({ cls: 'gh-sync-setup__steps', attr: { 'aria-live': 'polite' } });
		if (!this.readiness || this.busy === 'checking') {
			this.renderStep(steps, 'Required apps', 'Checking Git and the GitHub connection helper…', 'pending');
			this.renderStep(steps, 'GitHub account', 'Checking your saved connection…', 'pending');
			this.renderStep(steps, 'Private documentation', 'Checking repository access…', 'pending');
		} else {
			const helpersReady = this.readiness.gitReady && this.readiness.connection !== 'missing-helper';
			this.renderStep(
				steps,
				'Required apps',
				helpersReady ? 'Git and GitHub helper are ready.' : 'Run the NuLegal Docs installer to add the missing helper.',
				helpersReady ? 'ready' : 'action',
			);
			const accountReady = Boolean(this.readiness.login);
			this.renderStep(
				steps,
				'GitHub account',
				accountReady ? `Connected as @${this.readiness.login}.` : this.readiness.connection === 'offline' ? 'Connection could not be checked while offline.' : 'Browser approval is required.',
				accountReady ? 'ready' : 'action',
			);
			this.renderStep(
				steps,
				'Private documentation',
				this.readiness.ready
					? `${this.readiness.repository} is available.`
					: !this.readiness.vaultReady ? this.readiness.vaultDetail : this.readiness.detail,
				this.readiness.ready ? 'ready' : 'action',
			);
		}

		if (this.busy === 'connecting' || this.busy === 'finishing') {
			const waiting = this.contentEl.createDiv({ cls: 'gh-sync-setup__waiting', attr: { role: 'status', 'aria-live': 'polite' } });
			const spinner = waiting.createSpan({ cls: 'gh-sync-operation__spinner' });
			setIcon(spinner, 'loader-circle');
			const waitingCopy = waiting.createDiv();
			waitingCopy.createDiv({ cls: 'gh-sync-setup__waiting-title', text: this.busy === 'connecting' ? 'Waiting for GitHub in your browser' : 'Finishing passwordless setup' });
			waitingCopy.createDiv({ text: this.busy === 'connecting'
				? 'Approve the request there. If GitHub asks for a one-time code, paste it—the code is already copied.'
				: 'Checking the vault, HTTPS remote, and Git author details.' });
		}

		const warningText = this.operationError ?? this.readiness?.warning;
		if (warningText) {
			const warning = this.contentEl.createDiv({ cls: 'gh-sync-setup__warning', attr: { role: 'alert' } });
			setIcon(warning.createSpan(), 'triangle-alert');
			warning.createDiv({ text: warningText });
		}

		const actions = this.contentEl.createDiv({ cls: 'gh-sync-setup__actions' });
		if (this.busy) {
			if (this.busy === 'connecting') {
				const browser = actions.createEl('button', { cls: 'mod-cta', text: 'Open GitHub', attr: { type: 'button' } });
				browser.addEventListener('click', () => window.open('https://github.com/login/device', '_blank', 'noopener,noreferrer'));
			}
			const close = actions.createEl('button', { text: this.busy === 'connecting' ? 'Cancel' : 'Close', attr: { type: 'button' } });
			close.addEventListener('click', () => this.close());
			return;
		}

		if (this.readiness?.ready) {
			const check = actions.createEl('button', { text: 'Check again', attr: { type: 'button' } });
			check.addEventListener('click', () => void this.check());
			const done = actions.createEl('button', { cls: 'mod-cta', text: 'Done', attr: { type: 'button' } });
			done.addEventListener('click', () => this.close());
			return;
		}

		if (!this.readiness?.gitReady || this.readiness?.connection === 'missing-helper') {
			const guide = actions.createEl('button', { cls: 'mod-cta', text: 'Open setup guide', attr: { type: 'button' } });
			guide.addEventListener('click', () => {
				this.close();
				void this.app.workspace.openLinkText('README.md', '', false);
			});
		} else if (this.readiness?.connection === 'no-access') {
			const access = actions.createEl('button', { text: 'Open repository access', attr: { type: 'button' } });
			access.addEventListener('click', () => window.open(`https://github.com/${this.readiness?.repository ?? ''}`, '_blank', 'noopener,noreferrer'));
			const reconnect = actions.createEl('button', { cls: 'mod-cta', text: 'Reconnect account', attr: { type: 'button' } });
			reconnect.addEventListener('click', () => void this.connect());
		} else if (this.readiness?.connection === 'connected' && this.readiness.vaultRepairable) {
			const finish = actions.createEl('button', { cls: 'mod-cta', text: 'Finish setup', attr: { type: 'button' } });
			finish.addEventListener('click', () => void this.finish());
		} else if (this.readiness?.connection === 'connected') {
			const guide = actions.createEl('button', { cls: 'mod-cta', text: 'Open setup guide', attr: { type: 'button' } });
			guide.addEventListener('click', () => {
				this.close();
				void this.app.workspace.openLinkText('README.md', '', false);
			});
		} else if (this.readiness?.connection !== 'offline') {
			const connect = actions.createEl('button', { cls: 'mod-cta', text: 'Connect GitHub', attr: { type: 'button' } });
			connect.addEventListener('click', () => void this.connect());
		}
		const check = actions.createEl('button', { text: 'Check again', attr: { type: 'button' } });
		check.addEventListener('click', () => void this.check());
	}

	private async check(): Promise<void> {
		this.busy = 'checking';
		this.operationError = undefined;
		this.render();
		this.readiness = await this.plugin.getGitHubSetupReadiness();
		if (this.closed) return;
		this.busy = undefined;
		if (this.readiness.ready) void this.plugin.completeGitHubSetup();
		this.render();
	}

	private async connect(): Promise<void> {
		this.busy = 'connecting';
		this.operationError = undefined;
		this.authAbort = new AbortController();
		this.render();
		try {
			this.readiness = await this.plugin.connectGitHubInBrowser(this.authAbort.signal);
			if (this.closed) return;
			if (this.readiness.ready) void this.plugin.completeGitHubSetup();
		} catch (error) {
			if (this.closed) return;
			this.readiness = await this.plugin.getGitHubSetupReadiness();
			if (this.closed) return;
			const problem = classifyGitHubConnectionError(error);
			this.operationError = problem.kind === 'unknown'
				? `Setup could not finish: ${redactSensitiveText(error)}`
				: problem.message;
		}
		this.authAbort = undefined;
		this.busy = undefined;
		this.render();
	}

	private async finish(): Promise<void> {
		this.busy = 'finishing';
		this.operationError = undefined;
		this.render();
		try {
			this.readiness = await this.plugin.finishGitHubSetup();
			if (this.closed) return;
			if (this.readiness.ready) void this.plugin.completeGitHubSetup();
		} catch (error) {
			if (this.closed) return;
			this.readiness = await this.plugin.getGitHubSetupReadiness();
			if (this.closed) return;
			this.operationError = `Setup could not finish: ${redactSensitiveText(error)}`;
		}
		this.busy = undefined;
		this.render();
	}

	onClose(): void {
		this.closed = true;
		this.authAbort?.abort();
		this.authAbort = undefined;
		this.contentEl.empty();
	}
}

class GHSyncSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: GHSyncPlugin) {
		super(app, plugin);
	}

	private renderConnectionCard(container: HTMLElement): void {
		const card = container.createDiv({ cls: 'gh-sync-setup-card' });
		const icon = card.createSpan({ cls: 'gh-sync-setup-card__icon gh-sync-operation__spinner' });
		setIcon(icon, 'loader-circle');
		const copy = card.createDiv({ cls: 'gh-sync-setup-card__copy' });
		copy.createDiv({ cls: 'gh-sync-setup-card__title', text: 'GitHub connection' });
		const detail = copy.createDiv({ cls: 'gh-sync-setup-card__detail', text: 'Checking this computer…' });
		const open = card.createEl('button', { text: 'Open setup', attr: { type: 'button' } });
		open.addEventListener('click', () => void this.plugin.openGitHubSetup());
		void this.plugin.getGitHubSetupReadiness().then((readiness) => {
			if (!card.isConnected) return;
			icon.removeClass('gh-sync-operation__spinner');
			card.addClass(readiness.ready ? 'is-ready' : 'is-action');
			setIcon(icon, readiness.ready ? 'circle-check' : 'circle-alert');
			const accountReady = readiness.connection === 'connected';
			detail.setText(readiness.warning ?? (!accountReady ? readiness.detail : !readiness.vaultReady ? readiness.vaultDetail : readiness.detail));
			open.setText(readiness.ready
				? 'Manage'
				: accountReady ? 'Finish setup' : readiness.connection === 'no-access' ? 'Review access' : 'Connect GitHub');
		});
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		this.renderConnectionCard(containerEl);

		const howto = containerEl.createEl('div', { cls: 'howto' });
		howto.createEl('div', { text: 'Branch-based documentation workflow', cls: 'howto_title' });
		howto.createEl('small', { text: 'The base branch is not a branch selector. Use the Branch Manager to start or switch changes, then sync the explicitly displayed current branch.', cls: 'howto_text' });

		new Setting(containerEl)
			.setName('Remote URL')
			.setDesc('The installer configures a passwordless GitHub HTTPS address. Never put a password or token here.')
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
			.setDesc('Advanced repair option. The NuLegal Docs installer configures Git automatically; most people should leave this empty.')
			.addText((text) => text.setValue(this.plugin.settings.gitLocation).onChange(async (value) => {
				this.plugin.settings.gitLocation = value;
				await this.plugin.saveSettings();
			}));

		containerEl.createEl('h3', { text: 'Selected-text reviews' });
		containerEl.createEl('p', {
			cls: 'setting-item-description',
			text: 'Comments are stored on the change branch’s draft GitHub pull request. Use the guided GitHub connection above; no SSH key or access token is required.',
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
			.setDesc('Advanced repair option. The NuLegal Docs installer finds this helper automatically; most people should leave this unchanged.')
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
