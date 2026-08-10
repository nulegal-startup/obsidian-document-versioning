export interface TextAnchor {
	version: 1;
	path: string;
	selectedText: string;
	prefix: string;
	suffix: string;
	startLine: number;
	endLine: number;
	fingerprint: string;
}

export interface AnchoredPosition {
	from: number;
	to: number;
	startLine: number;
	endLine: number;
	confidence: 'exact' | 'context' | 'orphaned';
}

export interface ReviewMetadata {
	version: 1;
	threadId: string;
	anchor: TextAnchor;
	state: 'open' | 'resolved';
	parentId?: number;
}

const MARKER = 'obsidian-github-sync-review:';
const CONTEXT_LENGTH = 80;

function lineAt(text: string, offset: number): number {
	let line = 1;
	for (let index = 0; index < Math.min(offset, text.length); index += 1) {
		if (text.charCodeAt(index) === 10) line += 1;
	}
	return line;
}

function fingerprint(value: string): string {
	let hash = 2166136261;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(36);
}

export function createTextAnchor(document: string, from: number, to: number, filePath: string): TextAnchor {
	if (!filePath || /[\r\n\0]/.test(filePath)) throw new Error('The selected note path is invalid.');
	if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from || to > document.length) {
		throw new Error('Select some text before adding a comment.');
	}
	const selectedText = document.slice(from, to);
	if (selectedText.length > 12000) throw new Error('Select a smaller section (12,000 characters or fewer).');
	const prefix = document.slice(Math.max(0, from - CONTEXT_LENGTH), from);
	const suffix = document.slice(to, Math.min(document.length, to + CONTEXT_LENGTH));
	return {
		version: 1,
		path: filePath,
		selectedText,
		prefix,
		suffix,
		startLine: lineAt(document, from),
		endLine: lineAt(document, Math.max(from, to - 1)),
		fingerprint: fingerprint(`${filePath}\0${prefix}\0${selectedText}\0${suffix}`),
	};
}

export function reanchorText(document: string, anchor: TextAnchor): AnchoredPosition {
	const matches: number[] = [];
	let cursor = 0;
	while (cursor <= document.length) {
		const found = document.indexOf(anchor.selectedText, cursor);
		if (found < 0) break;
		matches.push(found);
		cursor = found + Math.max(1, anchor.selectedText.length);
	}
	if (matches.length === 0) {
		return { from: -1, to: -1, startLine: anchor.startLine, endLine: anchor.endLine, confidence: 'orphaned' };
	}
	const scored = matches.map((from) => {
		const before = document.slice(Math.max(0, from - anchor.prefix.length), from);
		const after = document.slice(from + anchor.selectedText.length, from + anchor.selectedText.length + anchor.suffix.length);
		let score = 0;
		for (let i = 1; i <= Math.min(before.length, anchor.prefix.length); i += 1) {
			if (before[before.length - i] !== anchor.prefix[anchor.prefix.length - i]) break;
			score += 1;
		}
		for (let i = 0; i < Math.min(after.length, anchor.suffix.length); i += 1) {
			if (after[i] !== anchor.suffix[i]) break;
			score += 1;
		}
		return { from, score };
	}).sort((left, right) => right.score - left.score || left.from - right.from);
	const best = scored[0];
	const to = best.from + anchor.selectedText.length;
	return {
		from: best.from,
		to,
		startLine: lineAt(document, best.from),
		endLine: lineAt(document, Math.max(best.from, to - 1)),
		confidence: matches.length === 1 ? 'exact' : 'context',
	};
}

function encode(value: string): string {
	return Buffer.from(value, 'utf8').toString('base64url');
}

function decode(value: string): string {
	return Buffer.from(value, 'base64url').toString('utf8');
}

export function encodeReviewMetadata(metadata: ReviewMetadata): string {
	return `<!-- ${MARKER}${encode(JSON.stringify(metadata))} -->`;
}

export function decodeReviewMetadata(body: string): ReviewMetadata | undefined {
	const match = body.match(new RegExp(`<!--\\s*${MARKER}([A-Za-z0-9_-]{1,30000})\\s*-->`));
	if (!match) return undefined;
	try {
		const value = JSON.parse(decode(match[1])) as Partial<ReviewMetadata>;
		if (value.version !== 1 || !value.threadId || !value.anchor || value.anchor.version !== 1) return undefined;
		if (!['open', 'resolved'].includes(String(value.state))) return undefined;
		if (typeof value.anchor.path !== 'string' || typeof value.anchor.selectedText !== 'string') return undefined;
		if (!value.anchor.path || value.anchor.path.startsWith('/') || value.anchor.path.split(/[\\/]/).includes('..') || /[\r\n\0]/.test(value.anchor.path)) return undefined;
		if (!value.anchor.selectedText || value.anchor.selectedText.length > 12000) return undefined;
		if (typeof value.anchor.prefix !== 'string' || typeof value.anchor.suffix !== 'string') return undefined;
		if (value.anchor.prefix.length > CONTEXT_LENGTH || value.anchor.suffix.length > CONTEXT_LENGTH) return undefined;
		return value as ReviewMetadata;
	} catch {
		return undefined;
	}
}

export function visibleCommentBody(body: string): string {
	return body.replace(new RegExp(`\\n?<!--\\s*${MARKER}[A-Za-z0-9_-]{1,30000}\\s*-->\\s*$`), '').trim();
}
