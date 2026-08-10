import { App, FileSystemAdapter, Modal, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
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
	syncinterval: 0,
	isSyncOnLoad: false,
	checkStatusOnLoad: true,
	noticeLevel: 'ALL',
	showSyncSuccessNotice: true,
};

export default class GHSyncPlugin extends Plugin {
	settings: GHSyncSettings;
	private syncInProgress = false;
	private syncTimer?: ReturnType<typeof setIntervalAsync>;
	private branchStatusEl?: HTMLElement;

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

	private async updateBranchStatus(git?: SimpleGit): Promise<void> {
		if (!this.branchStatusEl) return;
		try {
			const branch = await this.currentBranch(git ?? this.getGit());
			this.branchStatusEl.setText(`Git: ${branch}`);
			this.branchStatusEl.setAttr('title', `Current documentation branch: ${branch}`);
		} catch {
			this.branchStatusEl.setText('Git: unavailable');
		}
	}

	private async withGitLock(action: () => Promise<void>): Promise<void> {
		if (this.syncInProgress) {
			this.showNotice('A Git operation is already running.', 'WARNING');
			return;
		}
		this.syncInProgress = true;
		try {
			await action();
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

	private async showConflicts(git: SimpleGit, pullError: unknown): Promise<void> {
		const status = await git.status();
		const conflicts = status.conflicted;
		if (conflicts.length === 0) {
			this.showNotice(`Git could not merge the remote changes. No files were pushed.\n${redactSensitiveText(pullError)}`, 'ERROR', 10000);
			return;
		}
		this.showNotice(`Merge conflicts must be resolved before syncing:\n${conflicts.join('\n')}`, 'WARNING', 15000);
		for (const file of conflicts) {
			this.app.workspace.openLinkText('', file, true);
		}
	}

	async syncNotes(): Promise<void> {
		await this.withGitLock(async () => {
			try {
				const git = this.getGit();
				await git.status();
				await this.configureRemote(git);
				const branch = await this.currentBranch(git);
				await this.commitLocalChanges(git);
				await git.fetch('origin');

				if (await this.remoteBranchExists(git, branch)) {
					try {
						await git.pull('origin', branch, { '--no-rebase': null });
					} catch (error) {
						await this.showConflicts(git, error);
						return;
					}
				}

				await git.push('origin', branch, ['-u']);
				await this.updateBranchStatus(git);
				if (this.settings.showSyncSuccessNotice) {
					this.showNotice(`Synced ${branch}`, 'INFO');
				}
			} catch (error) {
				this.showNotice(error, 'ERROR', 10000);
			}
		});
	}

	async startChange(changeTitle: string): Promise<void> {
		await this.withGitLock(async () => {
			try {
				const git = this.getGit();
				const status = await git.status();
				if (!status.isClean()) {
					throw new Error('Sync or commit your current changes before starting a new change.');
				}

				await this.configureRemote(git);
				await git.fetch('origin');
				const currentBranch = await this.currentBranch(git);
				await this.requireSynchronizedBranch(git, currentBranch);
				const baseBranch = this.getBaseBranch();
				const newBranch = normalizeBranchName(changeTitle, this.settings.branchPrefix);
				const localBranches = await git.branchLocal();
				if (localBranches.all.includes(newBranch) || await this.remoteBranchExists(git, newBranch)) {
					throw new Error(`The branch ${newBranch} already exists. Choose another change name.`);
				}

				await git.checkout(baseBranch);
				if (await this.remoteBranchExists(git, baseBranch)) {
					await git.pull('origin', baseBranch, { '--ff-only': null });
				}
				await git.checkoutLocalBranch(newBranch);
				await git.push('origin', newBranch, ['-u']);
				await this.updateBranchStatus(git);
				this.showNotice(`Started change: ${newBranch}`, 'INFO', 8000);
			} catch (error) {
				this.showNotice(error, 'ERROR', 10000);
			}
		});
	}

	async returnToBaseBranch(): Promise<void> {
		await this.withGitLock(async () => {
			try {
				const git = this.getGit();
				if (!(await git.status()).isClean()) {
					throw new Error('Sync or commit your current changes before returning to the base branch.');
				}
				await this.configureRemote(git);
				await git.fetch('origin');
				const currentBranch = await this.currentBranch(git);
				await this.requireSynchronizedBranch(git, currentBranch);
				const baseBranch = this.getBaseBranch();
				await git.checkout(baseBranch);
				if (await this.remoteBranchExists(git, baseBranch)) {
					await git.pull('origin', baseBranch, { '--ff-only': null });
				}
				await this.updateBranchStatus(git);
				this.showNotice(`Returned to ${baseBranch}`, 'INFO');
			} catch (error) {
				this.showNotice(error, 'ERROR', 10000);
			}
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
				if (this.settings.isSyncOnLoad) await this.syncNotes();
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

		const ribbonIconEl = this.addRibbonIcon('github', 'Sync current branch', () => void this.syncNotes());
		ribbonIconEl.addClass('gh-sync-ribbon');

		this.addCommand({ id: 'github-sync-command', name: 'Sync current branch', callback: () => void this.syncNotes() });
		this.addCommand({
			id: 'github-sync-start-change',
			name: 'Start a change branch',
			callback: () => new BranchNameModal(this.app, (title) => void this.startChange(title)).open(),
		});
		this.addCommand({ id: 'github-sync-return-to-base', name: 'Return to base branch', callback: () => void this.returnToBaseBranch() });
		this.addSettingTab(new GHSyncSettingTab(this.app, this));

		const interval = this.settings.syncinterval;
		if (Number.isFinite(interval) && interval >= 1) {
			this.syncTimer = setIntervalAsync(() => this.syncNotes(), interval * 60 * 1000);
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
		howto.createEl('small', { text: 'Use “Start a change branch”, edit normally, then use “Sync current branch”. Return to the base branch after the change is merged.', cls: 'howto_text' });

		new Setting(containerEl)
			.setName('Remote URL')
			.setDesc('Use an HTTPS URL without embedded credentials, or an SSH URL.')
			.addText((text) => text.setValue(this.plugin.settings.remoteURL).onChange(async (value) => {
				this.plugin.settings.remoteURL = value;
				await this.plugin.saveSettings();
			}));

		new Setting(containerEl)
			.setName('Base branch')
			.setDesc('The accepted documentation branch used as the starting point for new changes.')
			.addText((text) => text.setPlaceholder('main').setValue(this.plugin.settings.baseBranch).onChange(async (value) => {
				this.plugin.settings.baseBranch = value;
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
