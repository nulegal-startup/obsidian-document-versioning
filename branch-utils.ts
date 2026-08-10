export function isSafeBranchRef(value: string): boolean {
	const branch = value.trim();
	return branch.length > 0
		&& branch.length <= 160
		&& !branch.startsWith('-')
		&& !branch.startsWith('.')
		&& !branch.startsWith('/')
		&& !branch.endsWith('.')
		&& !branch.endsWith('/')
		&& !branch.endsWith('.lock')
		&& !branch.includes('..')
		&& !branch.includes('@{')
		&& !/[\s~^:?*\\[\\]\\\\]/.test(branch)
		&& !branch.split('/').some((segment) => segment.length === 0 || segment.startsWith('.'));
}

export function normalizeBranchName(input: string, prefix: string): string {
	const safePrefix = prefix.trim().replace(/^\/+|\/+$/g, '');
	if (safePrefix && !isSafeBranchRef(safePrefix)) {
		throw new Error('The configured branch prefix is invalid.');
	}

	const slug = input
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/['’]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.replace(/-{2,}/g, '-')
		.slice(0, 80)
		.replace(/-+$/g, '');

	if (!slug) {
		throw new Error('Enter a change name containing at least one letter or number.');
	}

	const branch = safePrefix ? `${safePrefix}/${slug}` : slug;
	if (!isSafeBranchRef(branch)) {
		throw new Error('The generated branch name is invalid.');
	}
	return branch;
}

export function validateRemoteUrl(value: string): string {
	const remote = value.trim();
	if (!remote || /[\r\n\0]/.test(remote)) {
		throw new Error('Enter a valid HTTPS or SSH remote URL.');
	}

	if (/^[\w.-]+@[\w.-]+:[^\s]+$/.test(remote)) {
		return remote;
	}

	let url: URL;
	try {
		url = new URL(remote);
	} catch {
		throw new Error('Enter a valid HTTPS or SSH remote URL.');
	}

	if (!['https:', 'ssh:'].includes(url.protocol)) {
		throw new Error('Only HTTPS and SSH remote URLs are supported.');
	}
	if (url.protocol === 'https:' && (url.username || url.password)) {
		throw new Error('Do not put a username or access token in the remote URL. Use Git Credential Manager or SSH instead.');
	}
	return remote;
}

export function redactSensitiveText(value: unknown): string {
	const text = value instanceof Error ? value.message : String(value);
	return text
		.replace(/https:\/\/[^\s/@:]+:[^\s/@]+@/gi, 'https://***:***@')
		.replace(/\b(?:ghp|github_pat|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{10,}\b/g, '[REDACTED]');
}

export type BranchSyncState = 'up-to-date' | 'behind' | 'ahead' | 'diverged' | 'unpublished';

export interface BranchSyncSummary {
	state: BranchSyncState;
	label: string;
	compact: string;
}

export function describeBranchSync(ahead: number, behind: number, published: boolean): BranchSyncSummary {
	if (!published) return { state: 'unpublished', label: 'Not published', compact: 'Local only' };
	if (ahead > 0 && behind > 0) {
		return { state: 'diverged', label: `${ahead} ahead · ${behind} behind`, compact: `↑${ahead} ↓${behind}` };
	}
	if (behind > 0) return { state: 'behind', label: `${behind} behind`, compact: `↓${behind}` };
	if (ahead > 0) return { state: 'ahead', label: `${ahead} ahead`, compact: `↑${ahead}` };
	return { state: 'up-to-date', label: 'Up to date', compact: '✓' };
}

export interface GitConflictVersions {
	current: string;
	incoming: string;
	conflictCount: number;
}

export function parseGitConflict(text: string): GitConflictVersions {
	type ParseState = 'shared' | 'current' | 'base' | 'incoming';
	const newline = text.includes('\r\n') ? '\r\n' : '\n';
	const normalized = text.replace(/\r\n?/g, '\n');
	const hasFinalNewline = normalized.endsWith('\n');
	const lines = normalized.split('\n');
	if (hasFinalNewline) lines.pop();

	const current: string[] = [];
	const incoming: string[] = [];
	let state: ParseState = 'shared';
	let conflictCount = 0;

	for (const line of lines) {
		if (state === 'shared' && /^<<<<<<<(?: |$)/.test(line)) {
			state = 'current';
			continue;
		}
		if (state === 'current' && /^\|\|\|\|\|\|\|(?: |$)/.test(line)) {
			state = 'base';
			continue;
		}
		if ((state === 'current' || state === 'base') && /^=======$/.test(line)) {
			state = 'incoming';
			continue;
		}
		if (state === 'incoming' && /^>>>>>>>(?: |$)/.test(line)) {
			state = 'shared';
			conflictCount += 1;
			continue;
		}
		if (/^(?:<<<<<<<|\|\|\|\|\|\|\||=======|>>>>>>>)(?: |$)/.test(line)) {
			throw new Error('The conflict markers are malformed. Open the note for manual resolution.');
		}

		if (state === 'shared') {
			current.push(line);
			incoming.push(line);
		} else if (state === 'current') {
			current.push(line);
		} else if (state === 'incoming') {
			incoming.push(line);
		}
	}

	if (state !== 'shared' || conflictCount === 0) {
		throw new Error('No complete Git conflict was found. Open the note for manual resolution.');
	}
	const suffix = hasFinalNewline ? newline : '';
	return { current: current.join(newline) + suffix, incoming: incoming.join(newline) + suffix, conflictCount };
}
