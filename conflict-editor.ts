import { EditorState, Extension, StateField } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import { editorInfoField, setIcon } from 'obsidian';
import { ConflictAISuggestion } from './ai-provider';
import {
	ConflictChoice,
	ConflictHunk,
	extractConflictContext,
	parseConflictDocument,
	resolveConflictById,
} from './conflict-engine';

export interface ConflictEditorCallbacks {
	isConflictedFile(filePath: string): boolean;
	onDocumentUpdated(filePath: string, remaining: number): void;
	markResolved(filePath: string, text: string): Promise<void>;
	openConflictCenter(): void;
	requestAISuggestion(filePath: string, hunk: ConflictHunk, before: string, after: string): Promise<ConflictAISuggestion>;
	aiProviderLabel(): string | null;
}

function editorFilePath(state: EditorState): string | null {
	const info = state.field(editorInfoField, false);
	return info?.file?.path || null;
}

function iconButton(parent: HTMLElement, label: string, icon: string, onClick: () => void): HTMLButtonElement {
	const button = parent.createEl('button', { cls: 'gh-sync-conflict-action', attr: { type: 'button', 'aria-label': label } });
	const iconEl = button.createSpan({ cls: 'gh-sync-conflict-action__icon' });
	setIcon(iconEl, icon);
	button.createSpan({ text: label });
	button.addEventListener('mousedown', (event) => event.preventDefault());
	button.addEventListener('click', (event) => {
		event.preventDefault();
		event.stopPropagation();
		onClick();
	});
	return button;
}

function versionPanel(parent: HTMLElement, label: string, description: string, value: string, tone: string): void {
	const panel = parent.createDiv({ cls: `gh-sync-conflict-side is-${tone}` });
	const heading = panel.createDiv({ cls: 'gh-sync-conflict-side__heading' });
	heading.createSpan({ cls: 'gh-sync-conflict-side__label', text: label });
	heading.createSpan({ cls: 'gh-sync-conflict-side__description', text: description });
	panel.createEl('pre', { cls: 'gh-sync-conflict-side__content', text: value || 'Empty section' });
}

class ConflictHunkWidget extends WidgetType {
	constructor(
		private readonly filePath: string,
		private readonly hunk: ConflictHunk,
		private readonly callbacks: ConflictEditorCallbacks,
	) {
		super();
	}

	eq(other: ConflictHunkWidget): boolean {
		return this.filePath === other.filePath && this.hunk.id === other.hunk.id;
	}

	ignoreEvent(): boolean {
		return false;
	}

	toDOM(view: EditorView): HTMLElement {
		const root = document.createElement('section');
		root.addClass('gh-sync-conflict-block');
		root.setAttr('aria-label', `Conflict near line ${this.hunk.startLine + 1}`);

		const header = root.createDiv({ cls: 'gh-sync-conflict-block__header' });
		const title = header.createDiv({ cls: 'gh-sync-conflict-block__title' });
		const icon = title.createSpan({ cls: 'gh-sync-conflict-block__icon' });
		setIcon(icon, 'git-merge');
		title.createSpan({ text: `Conflicting section · line ${this.hunk.startLine + 1}` });
		header.createSpan({ cls: 'gh-sync-conflict-block__review', text: 'Review required' });

		const comparison = root.createDiv({ cls: 'gh-sync-conflict-sides' });
		versionPanel(comparison, 'Current branch', this.hunk.currentLabel || 'Your branch', this.hunk.current, 'current');
		versionPanel(comparison, 'From GitHub', this.hunk.incomingLabel || 'Incoming branch', this.hunk.incoming, 'incoming');

		const actions = root.createDiv({ cls: 'gh-sync-conflict-block__actions' });
		iconButton(actions, 'Keep current', 'check', () => this.apply(view, 'current'));
		iconButton(actions, 'Keep GitHub', 'cloud-download', () => this.apply(view, 'incoming'));
		iconButton(actions, 'Keep both', 'copy-plus', () => this.apply(view, 'both'));
		iconButton(actions, 'Edit combined', 'pencil', () => this.showCustomEditor(view, root));
		const provider = this.callbacks.aiProviderLabel();
		if (provider) iconButton(actions, `Suggest with ${provider}`, 'sparkles', () => void this.suggestWithAI(view, root));
		else {
			const disabled = iconButton(actions, 'AI suggestions off', 'sparkles', () => undefined);
			disabled.addClass('is-secondary');
			disabled.disabled = true;
			disabled.setAttr('title', 'Enable an AI provider in Document Versioning settings.');
		}
		return root;
	}

	private apply(view: EditorView, choice: ConflictChoice, custom?: string): void {
		try {
			const currentText = view.state.doc.toString();
			const nextText = resolveConflictById(currentText, this.hunk.id, choice, custom);
			view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: nextText } });
			const remaining = parseConflictDocument(nextText).hunks.length;
			this.callbacks.onDocumentUpdated(this.filePath, remaining);
		} catch (error) {
			this.showInlineError(error);
		}
	}

	private showCustomEditor(view: EditorView, root: HTMLElement): void {
		const existing = root.querySelector('.gh-sync-conflict-custom');
		if (existing instanceof HTMLElement) {
			existing.querySelector('textarea')?.focus();
			return;
		}
		const editor = root.createDiv({ cls: 'gh-sync-conflict-custom' });
		editor.createDiv({ cls: 'gh-sync-conflict-custom__title', text: 'Edit the final wording' });
		const input = editor.createEl('textarea', { cls: 'gh-sync-conflict-custom__input' });
		input.value = `${this.hunk.current}${this.hunk.incoming}`;
		input.spellcheck = true;
		input.setAttr('aria-label', 'Custom conflict resolution');
		const footer = editor.createDiv({ cls: 'gh-sync-conflict-custom__footer' });
		const cancel = footer.createEl('button', { text: 'Cancel', attr: { type: 'button' } });
		cancel.addEventListener('click', () => editor.remove());
		const apply = footer.createEl('button', { cls: 'mod-cta', text: 'Apply wording', attr: { type: 'button' } });
		apply.addEventListener('click', () => this.apply(view, 'custom', input.value));
		window.setTimeout(() => input.focus(), 0);
	}

	private async suggestWithAI(view: EditorView, root: HTMLElement): Promise<void> {
		const old = root.querySelector('.gh-sync-conflict-ai');
		if (old instanceof HTMLElement) old.remove();
		const panel = root.createDiv({ cls: 'gh-sync-conflict-ai is-loading' });
		const header = panel.createDiv({ cls: 'gh-sync-conflict-ai__header' });
		const spinner = header.createSpan({ cls: 'gh-sync-conflict-ai__spinner' });
		setIcon(spinner, 'loader-circle');
		header.createSpan({ text: 'Preparing a reviewable suggestion…' });
		try {
			const currentText = view.state.doc.toString();
			const latest = parseConflictDocument(currentText).hunks.find((candidate) => candidate.id === this.hunk.id);
			if (!latest) throw new Error('This conflict changed before the suggestion started.');
			const context = extractConflictContext(currentText, latest, 6);
			const suggestion = await this.callbacks.requestAISuggestion(this.filePath, latest, context.before, context.after);
			const stillCurrent = parseConflictDocument(view.state.doc.toString()).hunks.some((candidate) => candidate.id === this.hunk.id);
			if (!stillCurrent) throw new Error('The conflict changed while AI was working. The old suggestion was discarded.');
			this.renderSuggestion(view, panel, suggestion);
		} catch (error) {
			panel.empty();
			panel.removeClass('is-loading');
			panel.addClass('is-error');
			const errorIcon = panel.createSpan({ cls: 'gh-sync-conflict-ai__error-icon' });
			setIcon(errorIcon, 'circle-alert');
			panel.createSpan({ text: error instanceof Error ? error.message : String(error) });
		}
	}

	private renderSuggestion(view: EditorView, panel: HTMLElement, suggestion: ConflictAISuggestion): void {
		panel.empty();
		panel.removeClass('is-loading');
		const header = panel.createDiv({ cls: 'gh-sync-conflict-ai__header' });
		const icon = header.createSpan();
		setIcon(icon, 'sparkles');
		header.createSpan({ text: 'AI suggestion — review before applying' });
		panel.createEl('pre', { cls: 'gh-sync-conflict-ai__content', text: suggestion.resolvedText || 'Empty section' });
		panel.createEl('p', { cls: 'gh-sync-conflict-ai__explanation', text: suggestion.explanation });
		if (suggestion.assumptions.length > 0) {
			const assumptions = panel.createEl('details', { cls: 'gh-sync-conflict-ai__assumptions' });
			assumptions.createEl('summary', { text: `${suggestion.assumptions.length} assumption${suggestion.assumptions.length === 1 ? '' : 's'}` });
			const list = assumptions.createEl('ul');
			for (const assumption of suggestion.assumptions) list.createEl('li', { text: assumption });
		}
		const actions = panel.createDiv({ cls: 'gh-sync-conflict-ai__actions' });
		const discard = actions.createEl('button', { text: 'Discard', attr: { type: 'button' } });
		discard.addEventListener('click', () => panel.remove());
		const apply = actions.createEl('button', { cls: 'mod-cta', text: 'Apply suggestion', attr: { type: 'button' } });
		apply.addEventListener('click', () => this.apply(view, 'custom', suggestion.resolvedText));
	}

	private showInlineError(error: unknown): void {
		const root = document.querySelector(`[aria-label="Conflict near line ${this.hunk.startLine + 1}"]`);
		if (!(root instanceof HTMLElement)) return;
		const old = root.querySelector('.gh-sync-conflict-inline-error');
		if (old) old.remove();
		root.createDiv({ cls: 'gh-sync-conflict-inline-error', text: error instanceof Error ? error.message : String(error) });
	}
}

class ConflictBannerWidget extends WidgetType {
	constructor(
		private readonly filePath: string,
		private readonly hunks: ConflictHunk[],
		private readonly callbacks: ConflictEditorCallbacks,
	) {
		super();
	}

	eq(other: ConflictBannerWidget): boolean {
		return this.filePath === other.filePath && this.hunks.map((hunk) => hunk.id).join(',') === other.hunks.map((hunk) => hunk.id).join(',');
	}

	ignoreEvent(): boolean {
		return false;
	}

	toDOM(view: EditorView): HTMLElement {
		const banner = document.createElement('aside');
		banner.addClass('gh-sync-conflict-banner');
		const icon = banner.createSpan({ cls: 'gh-sync-conflict-banner__icon' });
		setIcon(icon, this.hunks.length > 0 ? 'git-merge' : 'circle-check');
		const copy = banner.createDiv({ cls: 'gh-sync-conflict-banner__copy' });
		copy.createDiv({
			cls: 'gh-sync-conflict-banner__title',
			text: this.hunks.length > 0
				? `${this.hunks.length} unresolved section${this.hunks.length === 1 ? '' : 's'}`
				: 'All conflict sections reviewed',
		});
		copy.createDiv({
			cls: 'gh-sync-conflict-banner__description',
			text: this.hunks.length > 0
				? 'Choose the final wording for each highlighted section.'
				: 'Mark this document resolved so Git can continue the sync.',
		});
		const actions = banner.createDiv({ cls: 'gh-sync-conflict-banner__actions' });
		if (this.hunks.length > 0) {
			iconButton(actions, 'Next conflict', 'arrow-down', () => {
				view.dispatch({ effects: EditorView.scrollIntoView(this.hunks[0].from, { y: 'center' }) });
				view.focus();
			});
		} else {
			const done = iconButton(actions, 'Mark resolved', 'check', () => void this.callbacks.markResolved(this.filePath, view.state.doc.toString()));
			done.addClass('mod-cta');
		}
		iconButton(actions, 'Conflict center', 'list-tree', () => this.callbacks.openConflictCenter());
		return banner;
	}
}

function buildDecorations(state: EditorState, callbacks: ConflictEditorCallbacks): DecorationSet {
	const filePath = editorFilePath(state);
	if (!filePath) return Decoration.none;
	let hunks: ConflictHunk[];
	try {
		hunks = parseConflictDocument(state.doc.toString()).hunks;
	} catch {
		return Decoration.none;
	}
	if (hunks.length === 0 && !callbacks.isConflictedFile(filePath)) return Decoration.none;

	const ranges = [
		Decoration.widget({ widget: new ConflictBannerWidget(filePath, hunks, callbacks), block: true, side: -1 }).range(0),
		...hunks.map((hunk) => Decoration.replace({
			widget: new ConflictHunkWidget(filePath, hunk, callbacks),
			block: true,
		}).range(hunk.from, hunk.to)),
	];
	return Decoration.set(ranges, true);
}

export function conflictEditorExtension(callbacks: ConflictEditorCallbacks): Extension {
	return StateField.define<DecorationSet>({
		create: (state) => buildDecorations(state, callbacks),
		update: (decorations, transaction) => transaction.docChanged || transaction.reconfigured
			? buildDecorations(transaction.state, callbacks)
			: decorations,
		provide: (field) => EditorView.decorations.from(field),
	});
}
