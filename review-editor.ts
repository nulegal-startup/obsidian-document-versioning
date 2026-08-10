import { Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { setIcon } from 'obsidian';

export interface ReviewEditorCallbacks {
	commentOnSelection(): void;
}

class SelectionCommentControl {
	private readonly button: HTMLButtonElement;
	private frame?: number;

	constructor(private readonly view: EditorView, private readonly callbacks: ReviewEditorCallbacks) {
		this.button = document.createElement('button');
		this.button.type = 'button';
		this.button.className = 'gh-sync-selection-comment';
		this.button.setAttribute('aria-label', 'Comment on selected text');
		this.button.setAttribute('title', 'Comment on selected text');
		const icon = this.button.createSpan({ cls: 'gh-sync-selection-comment__icon' });
		setIcon(icon, 'message-square-plus');
		this.button.createSpan({ text: 'Comment' });
		this.button.addEventListener('mousedown', (event) => event.preventDefault());
		this.button.addEventListener('click', (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.callbacks.commentOnSelection();
		});
		this.view.dom.appendChild(this.button);
		this.scheduleRender();
	}

	update(update: ViewUpdate): void {
		if (update.selectionSet || update.docChanged || update.focusChanged || update.geometryChanged) this.scheduleRender();
	}

	destroy(): void {
		if (this.frame !== undefined) window.cancelAnimationFrame(this.frame);
		this.button.remove();
	}

	private scheduleRender(): void {
		if (this.frame !== undefined) window.cancelAnimationFrame(this.frame);
		this.frame = window.requestAnimationFrame(() => {
			this.frame = undefined;
			this.render();
		});
	}

	private render(): void {
		const selection = this.view.state.selection.main;
		if (selection.empty || !this.view.hasFocus) {
			this.button.removeClass('is-visible');
			return;
		}
		const coords = this.view.coordsAtPos(selection.to);
		if (!coords) {
			this.button.removeClass('is-visible');
			return;
		}
		const editorRect = this.view.dom.getBoundingClientRect();
		const buttonWidth = 104;
		const left = Math.max(8, Math.min(coords.left - editorRect.left, editorRect.width - buttonWidth - 8));
		const below = coords.bottom - editorRect.top + 7;
		const top = below + 42 < editorRect.height ? below : coords.top - editorRect.top - 39;
		this.button.style.left = `${Math.round(left)}px`;
		this.button.style.top = `${Math.round(Math.max(8, top))}px`;
		this.button.addClass('is-visible');
	}
}

export function reviewEditorExtension(callbacks: ReviewEditorCallbacks): Extension {
	return ViewPlugin.fromClass(class extends SelectionCommentControl {
		constructor(view: EditorView) { super(view, callbacks); }
	});
}
