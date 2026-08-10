import { App, Editor, EditorPosition, EditorSuggest, EditorSuggestContext, EditorSuggestTriggerInfo, TFile } from 'obsidian';
import { matchingMentions, mentionQueryAt } from './review-mention';

export interface DocumentMentionCallbacks {
	getUsers(): Promise<string[]>;
}

export class DocumentMentionSuggest extends EditorSuggest<string> {
	constructor(app: App, private readonly callbacks: DocumentMentionCallbacks) {
		super(app);
		this.limit = 8;
		this.setInstructions([
			{ command: '↑↓', purpose: 'Navigate' },
			{ command: '↵', purpose: 'Insert user' },
			{ command: 'esc', purpose: 'Close' },
		]);
	}

	onTrigger(cursor: EditorPosition, editor: Editor, _file: TFile | null): EditorSuggestTriggerInfo | null {
		const lineBeforeCursor = editor.getLine(cursor.line).slice(0, cursor.ch);
		const mention = mentionQueryAt(lineBeforeCursor, lineBeforeCursor.length);
		if (!mention) return null;
		return {
			start: { line: cursor.line, ch: mention.start },
			end: cursor,
			query: mention.query,
		};
	}

	async getSuggestions(context: EditorSuggestContext): Promise<string[]> {
		return matchingMentions(await this.callbacks.getUsers(), context.query, this.limit);
	}

	renderSuggestion(user: string, el: HTMLElement): void {
		el.addClass('gh-sync-document-mention');
		const avatar = el.createSpan({ cls: 'gh-sync-document-mention__avatar', text: user.slice(0, 1).toUpperCase() });
		avatar.setAttr('aria-hidden', 'true');
		const copy = el.createDiv({ cls: 'gh-sync-document-mention__copy' });
		copy.createDiv({ cls: 'gh-sync-document-mention__name', text: `@${user}` });
		copy.createDiv({ cls: 'gh-sync-document-mention__detail', text: 'GitHub collaborator' });
	}

	selectSuggestion(user: string, _event: MouseEvent | KeyboardEvent): void {
		const context = this.context;
		if (!context) return;
		const line = context.editor.getLine(context.end.line);
		const suffix = /\s/.test(line.charAt(context.end.ch)) ? '' : ' ';
		context.editor.replaceRange(`@${user}${suffix}`, context.start, context.end);
		this.close();
	}
}
