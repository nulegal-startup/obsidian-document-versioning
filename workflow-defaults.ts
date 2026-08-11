export const NULEGAL_WORKFLOW_DEFAULTS = Object.freeze({
	remoteURL: 'https://github.com/nulegal-startup/docs.git',
	baseBranch: 'main',
	branchPrefix: 'changes',
	protectBaseBranch: true,
	autoCreateDraftPR: true,
});

export function withNuLegalRepositoryDefault<T extends { remoteURL?: string }>(settings: T): T & { remoteURL: string } {
	return {
		...settings,
		remoteURL: settings.remoteURL?.trim() || NULEGAL_WORKFLOW_DEFAULTS.remoteURL,
	};
}
