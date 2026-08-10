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
