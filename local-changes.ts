import { validateDocumentPath } from './document-history';

export type LocalChangeState = 'modified' | 'added' | 'deleted' | 'renamed' | 'conflicted';

export interface LocalChange {
	path: string;
	oldPath?: string;
	state: LocalChangeState;
	code: string;
	staged: boolean;
	workingTree: boolean;
	untracked: boolean;
}

export interface LocalChangesSnapshot {
	branch: string;
	changes: LocalChange[];
}

export interface LocalChangeGroup {
	folder: string;
	changes: LocalChange[];
}

export interface LocalChangeDescription {
	label: string;
	detail: string;
	icon: string;
}

export interface LocalChangesGit {
	raw(args: string[]): Promise<string>;
}

export interface LocalRevertPlan {
	resetPaths: string[];
	removePaths: string[];
	restorePaths: string[];
}

function classifyChange(code: string): LocalChangeState {
	if (code === '??' || code.includes('A')) return 'added';
	if (code.includes('U') || code === 'DD' || code === 'AA') return 'conflicted';
	if (code.includes('R') || code.includes('C')) return 'renamed';
	if (code.includes('D')) return 'deleted';
	return 'modified';
}

function sortChanges(values: LocalChange[]): LocalChange[] {
	return values.sort((left, right) => left.path.localeCompare(right.path));
}

export function groupLocalChangesByFolder(changes: LocalChange[]): LocalChangeGroup[] {
	const groups = new Map<string, LocalChange[]>();
	for (const change of sortChanges([...changes])) {
		const separator = change.path.lastIndexOf('/');
		const folder = separator < 0 ? 'Vault root' : change.path.slice(0, separator);
		const group = groups.get(folder) ?? [];
		group.push(change);
		groups.set(folder, group);
	}
	return Array.from(groups, ([folder, values]) => ({ folder, changes: values }))
		.sort((left, right) => {
			if (left.folder === 'Vault root') return -1;
			if (right.folder === 'Vault root') return 1;
			return left.folder.localeCompare(right.folder);
		});
}

export function describeLocalChange(change: LocalChange): LocalChangeDescription {
	switch (change.state) {
		case 'added': return { label: 'New file', detail: 'Created on this computer', icon: 'file-plus-2' };
		case 'deleted': return { label: 'Deleted', detail: 'Removed on this computer', icon: 'file-minus-2' };
		case 'renamed': return { label: 'Renamed', detail: `Previously ${change.oldPath ?? 'another file'}`, icon: 'file-input' };
		case 'conflicted': return { label: 'Conflict', detail: 'Needs attention before syncing', icon: 'triangle-alert' };
		default: return { label: 'Modified', detail: 'Edited on this computer', icon: 'file-pen-line' };
	}
}

export function parseLocalChanges(raw: string): LocalChange[] {
	const records = raw.split('\0');
	const result: LocalChange[] = [];
	for (let index = 0; index < records.length; index += 1) {
		const record = records[index];
		if (record.length < 4) continue;
		const code = record.slice(0, 2);
		const path = validateDocumentPath(record.slice(3));
		const rename = code.includes('R') || code.includes('C');
		const oldPath = rename && records[index + 1]
			? validateDocumentPath(records[++index])
			: undefined;
		const untracked = code === '??';
		result.push({
			path,
			oldPath,
			state: classifyChange(code),
			code,
			staged: !untracked && code[0] !== ' ',
			workingTree: untracked || code[1] !== ' ',
			untracked,
		});
	}
	return sortChanges(result);
}

export function mergeLocalRenameHints(changes: LocalChange[], hints: Record<string, string>): LocalChange[] {
	const remaining = [...changes];
	const merged: LocalChange[] = [];
	for (const [newPathValue, oldPathValue] of Object.entries(hints)) {
		const newPath = validateDocumentPath(newPathValue);
		const oldPath = validateDocumentPath(oldPathValue);
		const addedIndex = remaining.findIndex((change) => change.path === newPath && change.state === 'added');
		const deletedIndex = remaining.findIndex((change) => change.path === oldPath && change.state === 'deleted');
		if (addedIndex < 0 || deletedIndex < 0) continue;
		const added = remaining[addedIndex];
		const deleted = remaining[deletedIndex];
		for (const index of [addedIndex, deletedIndex].sort((left, right) => right - left)) remaining.splice(index, 1);
		merged.push({
			path: newPath,
			oldPath,
			state: 'renamed',
			code: 'R ',
			staged: added.staged || deleted.staged,
			workingTree: added.workingTree || deleted.workingTree,
			untracked: false,
		});
	}
	return sortChanges([...remaining, ...merged]);
}

export function createLocalRevertPlan(change: LocalChange): LocalRevertPlan {
	const path = validateDocumentPath(change.path);
	if (change.state === 'renamed') {
		const oldPath = change.oldPath ? validateDocumentPath(change.oldPath) : undefined;
		if (!oldPath) throw new Error('The original path for this rename is unavailable.');
		return {
			resetPaths: [oldPath, path],
			removePaths: [path],
			restorePaths: [oldPath],
		};
	}
	if (change.state === 'added') {
		return {
			resetPaths: change.untracked ? [] : [path],
			removePaths: [path],
			restorePaths: [],
		};
	}
	return {
		resetPaths: [path],
		removePaths: [],
		restorePaths: [path],
	};
}

export async function applyLocalRevert(
	change: LocalChange,
	git: LocalChangesGit,
	removePath: (path: string) => Promise<void>,
): Promise<void> {
	const plan = createLocalRevertPlan(change);
	if (plan.resetPaths.length > 0) {
		await git.raw(['--literal-pathspecs', 'reset', '--', ...plan.resetPaths]);
	}
	for (const path of plan.removePaths) await removePath(path);
	if (plan.restorePaths.length > 0) {
		await git.raw(['--literal-pathspecs', 'restore', '--source=HEAD', '--worktree', '--', ...plan.restorePaths]);
	}
}

export class LocalChangesService {
	constructor(private readonly git: LocalChangesGit) {}

	async load(renameHints: Record<string, string> = {}): Promise<LocalChangesSnapshot> {
		let branch = 'Current branch';
		try {
			branch = (await this.git.raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim() || branch;
		} catch {
			// An unborn or detached repository can still report its local files.
		}
		const status = await this.git.raw(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
		return { branch, changes: mergeLocalRenameHints(parseLocalChanges(status), renameHints) };
	}
}
