import { App, FileSystemAdapter, Modal, Notice, Plugin, PluginSettingTab, Setting, setIcon } from 'obsidian';
import { simpleGit, SimpleGit, SimpleGitOptions, StatusResult } from 'simple-git';
import { clearIntervalAsync, setIntervalAsync } from 'set-interval-async';
import * as os from 'os';
import * as path from 'path';
import { isSafeBranchRef, normalizeBranchName, redactSensitiveText, validateRemoteUrl } from './branch-utils';

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
};

interface BranchSnapshot {
	current: string;
	base: string;
	branches: string[];
}

type OperationResult = {
	status: 'success' | 'warning';
	message: string;
};

class GitOperationProgress {
	private readonly notice: Notice;
	private readonly noticeEl: HTMLElement;
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
		this.noticeEl.addClass('gh-sync-operation');
		this.noticeEl.setAttr('role', 'status');
		this.noticeEl.setAttr('aria-live', 'polite');

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
		this.noticeEl.removeClass('is-warning');
		this.noticeEl.addClass(result.status === 'success' ? 'is-success' : 'is-warning');
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
		this.noticeEl.addClass('is-error');
		this.noticeEl.setAttr('aria-live', 'assertive');
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
	private readonly gitControlEls: HTMLElement[] = [];

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
		const allBranches = await git.branch(['-a']);
		const branches = Array.from(new Set(allBranches.all
			.map((branch) => branch.replace(/^remotes\/origin\//, '').replace(/^origin\//, ''))
			.filter((branch) => branch !== 'HEAD' && isSafeBranchRef(branch))))
			.sort((left, right) => left.localeCompare(right));
		return { current, base: this.getBaseBranch(), branches };
	}

	openBranchManager(): void {
		new BranchManagerModal(this.app, this).open();
	}

	private async updateBranchStatus(git?: SimpleGit): Promise<void> {
		if (!this.branchStatusEl) return;
		try {
			const branch = await this.currentBranch(git ?? this.getGit());
			this.branchStatusEl.empty();
			this.branchStatusEl.setText(`Git: ${branch}`);
			this.branchStatusEl.setAttr('title', `Current documentation branch: ${branch}`);
			this.branchStatusEl.setAttr('aria-busy', 'false');
		} catch {
			this.branchStatusEl.setText('Git: unavailable');
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

	private async conflictError(git: SimpleGit, pullError: unknown): Promise<Error> {
		const status = await git.status();
		const conflicts = status.conflicted;
		if (conflicts.length === 0) {
			return new Error(`Git could not merge the remote changes. No files were pushed.\n${redactSensitiveText(pullError)}`);
		}
		for (const file of conflicts) {
			this.app.workspace.openLinkText('', file, true);
		}
		return new Error(`Merge conflicts must be resolved before syncing:\n${conflicts.join('\n')}`);
	}

	async syncNotes(showBranchManagerOnProtected = true): Promise<void> {
		await this.withGitLock('Syncing documentation', async (progress) => {
			progress.step('Preparing repository');
			const git = this.getGit();
			await this.configureRemote(git);

			progress.step('Checking the current branch');
			const status = await git.status();
			const branch = await this.currentBranch(git);
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
					throw await this.conflictError(git, error);
				}
			}

			progress.step(`Pushing ${branch} to GitHub`);
			await git.push('origin', branch, ['-u']);
			await this.updateBranchStatus(git);
			return { status: 'success', message: `Synced ${branch}` };
		}, this.settings.showSyncSuccessNotice);
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
					progress.step(`Replaying edits on the latest ${baseBranch}`);
					try {
						await git.rebase([`origin/${baseBranch}`]);
					} catch (error) {
						await this.updateBranchStatus(git);
						throw await this.conflictError(git, error);
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
			await this.updateBranchStatus(git);
			return { status: 'success', message: `Started change: ${newBranch}` };
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
			await this.updateBranchStatus(git);
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
			await this.updateBranchStatus(git);
			return { status: 'success', message: `Switched to ${targetBranch}` };
		});
	}

	async checkStatusOnStart(): Promise<void> {
		try {
			const git = this.getGit();
			await this.configureRemote(git);
			await git.fetch('origin');
			const branch = await this.currentBranch(git);
			await this.updateBranchStatus(git);
			if (!(await this.remoteBranchExists(git, branch))) {
				this.showNotice(`${branch} has not been published yet. Sync to publish it.`, 'WARNING');
				return;
			}
			const { behind } = await this.branchDivergence(git, branch);
			if (behind > 0) {
				if (this.settings.isSyncOnLoad) await this.syncNotes(false);
				else this.showNotice(`${branch} is ${behind} commit(s) behind. Sync before editing.`, 'WARNING');
			} else {
				this.showNotice(`${branch} is up to date.`, 'INFO');
			}
		} catch {
			await this.updateBranchStatus();
		}
	}

	async onload(): Promise<void> {
		await this.loadSettings();
		this.branchStatusEl = this.addStatusBarItem();
		this.branchStatusEl.addClass('gh-sync-status');
		this.branchStatusEl.setAttr('aria-live', 'polite');
		this.registerDomEvent(this.branchStatusEl, 'click', () => {
			if (!this.syncInProgress) this.openBranchManager();
		});

		const ribbonIconEl = this.addRibbonIcon('github', 'Sync current branch', () => void this.syncNotes());
		ribbonIconEl.addClass('gh-sync-ribbon');
		const branchRibbonEl = this.addRibbonIcon('git-branch', 'Open branch manager', () => {
			if (!this.syncInProgress) this.openBranchManager();
		});
		branchRibbonEl.addClass('gh-sync-branch-ribbon');
		this.gitControlEls.push(ribbonIconEl, branchRibbonEl);

		this.addCommand({ id: 'github-sync-command', name: 'Sync current branch', callback: () => void this.syncNotes() });
		this.addCommand({ id: 'github-sync-branch-manager', name: 'Open branch manager', callback: () => this.openBranchManager() });
		this.addCommand({
			id: 'github-sync-start-change',
			name: 'Start a change branch',
			callback: () => new BranchNameModal(this.app, (title) => void this.startChange(title)).open(),
		});
		this.addCommand({ id: 'github-sync-return-to-base', name: 'Return to base branch', callback: () => void this.returnToBaseBranch() });
		this.addSettingTab(new GHSyncSettingTab(this.app, this));

		const interval = this.settings.syncinterval;
		if (Number.isFinite(interval) && interval >= 1) {
			this.syncTimer = setIntervalAsync(() => this.syncNotes(false), interval * 60 * 1000);
			this.showNotice('Automatic branch sync enabled.', 'INFO');
		}
		if (this.settings.checkStatusOnLoad) void this.checkStatusOnStart();
		else void this.updateBranchStatus();
	}

	onunload(): void {
		if (this.syncTimer) void clearIntervalAsync(this.syncTimer);
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		if ((this.settings.noticeLevel as LegacyNoticeLevelSetting) === 'WARNINGS') this.settings.noticeLevel = 'WARNING';
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
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

			new Setting(this.contentEl)
				.setName('Current branch')
				.setDesc(snapshot.current === snapshot.base
					? `${snapshot.current} is the accepted documentation branch. Start a change before editing.`
					: `Edits and syncs are going to ${snapshot.current}.`)
				.addButton((button) => button.setButtonText('Sync current').onClick(() => {
					this.close();
					void this.plugin.syncNotes();
				}));

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
			.setDesc('Check whether the current branch is behind its remote branch.')
			.addToggle((toggle) => toggle.setValue(this.plugin.settings.checkStatusOnLoad).onChange(async (value) => {
				this.plugin.settings.checkStatusOnLoad = value;
				await this.plugin.saveSettings();
			}));

		new Setting(containerEl)
			.setName('Auto sync on startup')
			.setDesc('Synchronize the current branch automatically when it is behind.')
			.addToggle((toggle) => toggle.setValue(this.plugin.settings.isSyncOnLoad).onChange(async (value) => {
				this.plugin.settings.isSyncOnLoad = value;
				await this.plugin.saveSettings();
			}));

		new Setting(containerEl)
			.setName('Auto sync interval')
			.setDesc('Minutes between synchronizations. Use 0 to disable; restart Obsidian after changing.')
			.addText((text) => text.setValue(String(this.plugin.settings.syncinterval)).onChange(async (value) => {
				this.plugin.settings.syncinterval = Number(value);
				await this.plugin.saveSettings();
			}));
	}
}
