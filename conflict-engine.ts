export type ConflictChoice = 'current' | 'incoming' | 'both' | 'custom';

export interface ConflictHunk {
	id: string;
	index: number;
	from: number;
	to: number;
	startLine: number;
	endLine: number;
	currentLabel: string;
	incomingLabel: string;
	current: string;
	base?: string;
	incoming: string;
}

export interface ConflictDocument {
	newline: string;
	hunks: ConflictHunk[];
}

interface SourceLine {
	content: string;
	full: string;
	from: number;
	to: number;
	line: number;
}

function sourceLines(text: string): SourceLine[] {
	const lines: SourceLine[] = [];
	let from = 0;
	let line = 0;
	const matcher = /([^\r\n]*)(\r\n|\r|\n|$)/g;
	let match: RegExpExecArray | null;
	while ((match = matcher.exec(text)) !== null) {
		if (match[0].length === 0) break;
		const to = from + match[0].length;
		lines.push({ content: match[1], full: match[0], from, to, line });
		from = to;
		line += 1;
	}
	return lines;
}

function markerLabel(line: string, marker: string): string | null {
	const match = line.match(new RegExp(`^${marker}(?: (.*))?$`));
	return match ? (match[1] || '') : null;
}

function stableId(currentLabel: string, incomingLabel: string, current: string, base: string | undefined, incoming: string): string {
	const value = [currentLabel, incomingLabel, current, base || '', incoming].join('\u0000');
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(36);
}

export function parseConflictDocument(text: string): ConflictDocument {
	type State = 'shared' | 'current' | 'base' | 'incoming';
	const newline = text.includes('\r\n') ? '\r\n' : text.includes('\r') ? '\r' : '\n';
	const hunks: ConflictHunk[] = [];
	let state: State = 'shared';
	let opener: SourceLine | null = null;
	let currentLabel = '';
	let incomingLabel = '';
	let current = '';
	let base: string | undefined;
	let incoming = '';

	for (const line of sourceLines(text)) {
		const startLabel = markerLabel(line.content, '<<<<<<<');
		const baseLabel = markerLabel(line.content, '\\|\\|\\|\\|\\|\\|\\|');
		const endLabel = markerLabel(line.content, '>>>>>>>');

		if (state === 'shared' && startLabel !== null) {
			state = 'current';
			opener = line;
			currentLabel = startLabel;
			incomingLabel = '';
			current = '';
			base = undefined;
			incoming = '';
			continue;
		}
		if (state === 'current' && baseLabel !== null) {
			state = 'base';
			base = '';
			continue;
		}
		if ((state === 'current' || state === 'base') && line.content === '=======') {
			state = 'incoming';
			continue;
		}
		if (state === 'incoming' && endLabel !== null && opener) {
			incomingLabel = endLabel;
			const index = hunks.length;
			hunks.push({
				id: stableId(currentLabel, incomingLabel, current, base, incoming),
				index,
				from: opener.from,
				to: line.to,
				startLine: opener.line,
				endLine: line.line,
				currentLabel,
				incomingLabel,
				current,
				...(base !== undefined ? { base } : {}),
				incoming,
			});
			state = 'shared';
			opener = null;
			continue;
		}

		const looksLikeMarker = startLabel !== null
			|| baseLabel !== null
			|| line.content === '======='
			|| endLabel !== null;
		if (looksLikeMarker && state !== 'shared') {
			throw new Error(`Malformed Git conflict near line ${line.line + 1}.`);
		}

		if (state === 'current') current += line.full;
		else if (state === 'base') base = (base || '') + line.full;
		else if (state === 'incoming') incoming += line.full;
	}

	if (state !== 'shared') {
		throw new Error(`Incomplete Git conflict beginning near line ${(opener?.line || 0) + 1}.`);
	}
	return { newline, hunks };
}

export function combineConflictVersions(current: string, incoming: string, newline: string): string {
	if (!current) return incoming;
	if (!incoming) return current;
	const separator = /(?:\r\n|\r|\n)$/.test(current) || /^(?:\r\n|\r|\n)/.test(incoming) ? '' : newline;
	return current + separator + incoming;
}

export function resolveConflictHunk(
	text: string,
	hunkIndex: number,
	choice: ConflictChoice,
	custom?: string,
): string {
	const document = parseConflictDocument(text);
	const hunk = document.hunks[hunkIndex];
	if (!hunk) throw new Error('That conflict is no longer present. Refresh and try again.');

	let replacement: string;
	if (choice === 'current') replacement = hunk.current;
	else if (choice === 'incoming') replacement = hunk.incoming;
	else if (choice === 'both') replacement = combineConflictVersions(hunk.current, hunk.incoming, document.newline);
	else if (choice === 'custom' && typeof custom === 'string') replacement = custom;
	else throw new Error('Enter a custom resolution before applying it.');

	return text.slice(0, hunk.from) + replacement + text.slice(hunk.to);
}

export function resolveConflictById(
	text: string,
	hunkId: string,
	choice: ConflictChoice,
	custom?: string,
): string {
	const document = parseConflictDocument(text);
	const hunk = document.hunks.find((candidate) => candidate.id === hunkId);
	if (!hunk) throw new Error('This conflict changed while you were reviewing it. Review the latest version and try again.');
	return resolveConflictHunk(text, hunk.index, choice, custom);
}

export function extractConflictContext(text: string, hunk: ConflictHunk, surroundingLines = 3): { before: string; after: string } {
	const beforeLines = sourceLines(text.slice(0, hunk.from));
	const afterLines = sourceLines(text.slice(hunk.to));
	return {
		before: beforeLines.slice(-Math.max(0, surroundingLines)).map((line) => line.full).join(''),
		after: afterLines.slice(0, Math.max(0, surroundingLines)).map((line) => line.full).join(''),
	};
}

export function hasConflictMarkers(text: string): boolean {
	return parseConflictDocument(text).hunks.length > 0;
}
