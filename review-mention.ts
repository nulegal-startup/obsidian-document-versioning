export interface MentionQuery {
	start: number;
	end: number;
	query: string;
}

export function mentionQueryAt(text: string, cursor: number): MentionQuery | undefined {
	if (!Number.isInteger(cursor) || cursor < 0 || cursor > text.length) return undefined;
	const before = text.slice(0, cursor);
	const match = before.match(/(?:^|\s)@([A-Za-z0-9-]{0,39})$/);
	if (!match) return undefined;
	const start = cursor - match[1].length - 1;
	return { start, end: cursor, query: match[1].toLowerCase() };
}

export function matchingMentions(users: string[], query: string, limit = 6): string[] {
	const normalized = query.toLowerCase();
	return Array.from(new Set(users))
		.filter((user) => user.toLowerCase().includes(normalized))
		.sort((left, right) => {
			const leftStarts = left.toLowerCase().startsWith(normalized) ? 0 : 1;
			const rightStarts = right.toLowerCase().startsWith(normalized) ? 0 : 1;
			return leftStarts - rightStarts || left.localeCompare(right);
		})
		.slice(0, Math.max(0, limit));
}

export function applyMention(text: string, mention: MentionQuery, user: string): { text: string; cursor: number } {
	const replacement = `@${user}${/\s/.test(text.charAt(mention.end)) ? '' : ' '}`;
	const next = `${text.slice(0, mention.start)}${replacement}${text.slice(mention.end)}`;
	return { text: next, cursor: mention.start + replacement.length };
}
