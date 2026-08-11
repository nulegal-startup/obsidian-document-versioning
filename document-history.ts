export type DocumentLocalState =
	| 'clean'
	| 'modified'
	| 'staged'
	| 'staged-and-modified'
	| 'untracked'
	| 'renamed'
	| 'conflicted';

export interface DocumentPatch {
	text: string;
	additions: number;
	deletions: number;
	binary: boolean;
	truncated: boolean;
}

export interface DocumentVersion {
	hash: string;
	author: string;
	timestamp: string;
	subject: string;
	path: string;
	previousPath?: string;
	additions: number;
	deletions: number;
	localOnly: boolean;
}

export interface DocumentHistorySnapshot {
	path: string;
	branch: string;
	local: {
		state: DocumentLocalState;
		patch: DocumentPatch;
	};
	versions: DocumentVersion[];
}

export interface DocumentHistoryGit {
	raw(args: string[]): Promise<string>;
}

interface DocumentHistoryOptions {
	maxPatchLines?: number;
	maxPatchBytes?: number;
	maxVersions?: number;
}

interface NumstatEntry {
	additions: number;
	deletions: number;
	binary: boolean;
	path?: string;
	oldPath?: string;
	newPath?: string;
}

interface DocumentStatusDetails {
	state: DocumentLocalState;
	oldPath?: string;
	newPath?: string;
}

const DEFAULT_MAX_PATCH_LINES = 1200;
const DEFAULT_MAX_PATCH_BYTES = 160_000;
const DEFAULT_MAX_VERSIONS = 50;

export function validateDocumentPath(value: string): string {
	const path = value.trim();
	if (!path || path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(path)) {
		throw new Error('The document must be inside the vault.');
	}
	if (/[\x00-\x1f\x7f]/.test(path)) {
		throw new Error('Document paths containing control characters are not supported.');
	}
	const segments = path.replace(/\\/g, '/').split('/');
	if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
		throw new Error('The document must be inside the vault.');
	}
	return segments.join('/');
}

export function validateCommitHash(value: string): string {
	const hash = value.trim();
	if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(hash)) throw new Error('Select a valid document commit.');
	return hash;
}

function classifyStatusCode(code: string): DocumentLocalState {
	if (code === '??') return 'untracked';
	if (code.includes('U') || ['DD', 'AA'].includes(code)) return 'conflicted';
	if (code.includes('R') || code.includes('C')) return 'renamed';
	const staged = code[0] !== ' ';
	const modified = code[1] !== ' ';
	if (staged && modified) return 'staged-and-modified';
	if (staged) return 'staged';
	if (modified) return 'modified';
	return 'clean';
}

function documentStatus(raw: string, requestedPath?: string): DocumentStatusDetails {
	if (!raw) return { state: 'clean' };
	const records = raw.split('\0');
	for (let index = 0; index < records.length; index += 1) {
		const record = records[index];
		if (record.length < 3) continue;
		const code = record.slice(0, 2);
		const newPath = record.slice(3);
		const isRename = code.includes('R') || code.includes('C');
		const oldPath = isRename ? records[index + 1] : undefined;
		if (isRename) index += 1;
		if (!requestedPath || requestedPath === newPath || requestedPath === oldPath) {
			return { state: classifyStatusCode(code), oldPath, newPath };
		}
	}
	return { state: 'clean' };
}

export function classifyDocumentStatus(raw: string): DocumentLocalState {
	return documentStatus(raw).state;
}

function parseCount(value: string): number {
	return /^\d+$/.test(value) ? Number(value) : 0;
}

function parseNumstats(parts: string[]): NumstatEntry[] {
	const entries: NumstatEntry[] = [];
	for (let index = 0; index < parts.length; index += 1) {
		const token = parts[index].replace(/^\n+/, '');
		if (!token) continue;
		const match = token.match(/^(-|\d+)\t(-|\d+)\t([\s\S]*)$/);
		if (!match) continue;
		const entry: NumstatEntry = {
			additions: parseCount(match[1]),
			deletions: parseCount(match[2]),
			binary: match[1] === '-' || match[2] === '-',
		};
		if (match[3]) {
			entry.path = match[3];
		} else {
			entry.oldPath = parts[index + 1];
			entry.newPath = parts[index + 2];
			index += 2;
		}
		entries.push(entry);
	}
	return entries;
}

export function parseDocumentLog(raw: string, requestedPath: string, localOnlyHashes: Set<string>): DocumentVersion[] {
	let trackedPath = validateDocumentPath(requestedPath);
	const versions: DocumentVersion[] = [];
	for (const record of raw.split('\x1e').slice(1)) {
		const parts = record.split('\0');
		const [hash, author, timestamp, subject] = parts;
		if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(hash ?? '')) continue;
		const stats = parseNumstats(parts.slice(4));
		const stat = stats.find((entry) => entry.path === trackedPath || entry.newPath === trackedPath || entry.oldPath === trackedPath)
			?? stats[0];
		const pathAtCommit = stat?.newPath || stat?.path || trackedPath;
		versions.push({
			hash,
			author: author || 'Unknown author',
			timestamp: timestamp || '',
			subject: subject || 'Saved version',
			path: pathAtCommit,
			previousPath: stat?.oldPath,
			additions: stat?.additions ?? 0,
			deletions: stat?.deletions ?? 0,
			localOnly: localOnlyHashes.has(hash),
		});
		if (stat?.oldPath && stat.newPath === trackedPath) trackedPath = stat.oldPath;
	}
	return versions;
}

export function toDocumentPatch(
	value: string,
	maxLines = DEFAULT_MAX_PATCH_LINES,
	maxBytes = DEFAULT_MAX_PATCH_BYTES,
): DocumentPatch {
	if (/^(?:Binary files .* differ|GIT binary patch)$/m.test(value)) {
		return {
			text: 'Binary document changed. Preview is unavailable.',
			additions: 0,
			deletions: 0,
			binary: true,
			truncated: false,
		};
	}
	const lines = value.replace(/\r\n?/g, '\n').split('\n');
	let additions = 0;
	let deletions = 0;
	for (const line of lines) {
		if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
		else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
	}

	const included: string[] = [];
	let bytes = 0;
	let truncated = false;
	for (const line of lines) {
		const lineBytes = new TextEncoder().encode(`${line}\n`).length;
		if (included.length >= maxLines || bytes + lineBytes > maxBytes) {
			truncated = true;
			break;
		}
		included.push(line);
		bytes += lineBytes;
	}
	if (truncated) included.push('… Preview shortened to keep Obsidian responsive.');
	return { text: included.join('\n'), additions, deletions, binary: false, truncated };
}

function oversizedPatch(additions: number, deletions: number): DocumentPatch {
	return {
		text: 'This change is too large to preview safely. Open the document or the repository history to inspect the complete change.',
		additions,
		deletions,
		binary: false,
		truncated: true,
	};
}

function binaryPatch(): DocumentPatch {
	return {
		text: 'Binary document changed. Preview is unavailable.',
		additions: 0,
		deletions: 0,
		binary: true,
		truncated: false,
	};
}

function countContentLines(contents: string): number {
	if (!contents) return 0;
	let lines = 1;
	for (let index = 0; index < contents.length; index += 1) {
		if (contents[index] === '\n') lines += 1;
	}
	return contents.endsWith('\n') ? lines - 1 : lines;
}

function addedFileDocumentPatch(path: string, contents: string, maxLines: number, maxBytes: number): DocumentPatch {
	const additions = countContentLines(contents);
	const exceedsBytes = contents.length > maxBytes
		|| new TextEncoder().encode(contents).length > maxBytes;
	if (exceedsBytes || additions + 5 > maxLines) return oversizedPatch(additions, 0);
	const normalized = contents.replace(/\r\n?/g, '\n');
	const lines = normalized.endsWith('\n') ? normalized.slice(0, -1).split('\n') : normalized.split('\n');
	const count = contents ? lines.length : 0;
	return toDocumentPatch([
		`diff --git a/${path} b/${path}`,
		'new file mode 100644',
		'--- /dev/null',
		`+++ b/${path}`,
		`@@ -0,0 +1,${count} @@`,
		...lines.map((line) => `+${line}`),
	].join('\n'), maxLines, maxBytes);
}

function renamedDocumentPatch(
	oldPath: string,
	newPath: string,
	oldContents: string,
	newContents: string,
	maxLines: number,
	maxBytes: number,
): DocumentPatch {
	const renameHeader = [
		`diff --git a/${oldPath} b/${newPath}`,
		`rename from ${oldPath}`,
		`rename to ${newPath}`,
	];
	if (oldContents === newContents) return toDocumentPatch(renameHeader.join('\n'), maxLines, maxBytes);
	if (oldContents.includes('\0') || newContents.includes('\0')) return binaryPatch();

	const splitLines = (contents: string): string[] => {
		const normalized = contents.replace(/\r\n?/g, '\n');
		if (!normalized) return [];
		return (normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized).split('\n');
	};
	const oldLines = splitLines(oldContents);
	const newLines = splitLines(newContents);
	let prefix = 0;
	while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
	let suffix = 0;
	while (
		suffix < oldLines.length - prefix
		&& suffix < newLines.length - prefix
		&& oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
	) suffix += 1;
	const removed = oldLines.slice(prefix, oldLines.length - suffix);
	const added = newLines.slice(prefix, newLines.length - suffix);
	if (removed.length + added.length + renameHeader.length + 1 > maxLines) {
		return oversizedPatch(added.length, removed.length);
	}
	if (removed.length === 0 && added.length === 0) {
		return toDocumentPatch([
			...renameHeader,
			'Document content also changed (line endings only).',
		].join('\n'), maxLines, maxBytes);
	}
	return toDocumentPatch([
		...renameHeader,
		`@@ -${prefix + 1},${removed.length} +${prefix + 1},${added.length} @@`,
		...removed.map((line) => `-${line}`),
		...added.map((line) => `+${line}`),
	].join('\n'), maxLines, maxBytes);
}

function parseAddedAndDeletedPaths(raw: string): { added: string[]; deleted: string[] } {
	const parts = raw.split('\0');
	const added: string[] = [];
	const deleted: string[] = [];
	for (let index = 0; index + 1 < parts.length; index += 2) {
		const status = parts[index];
		const path = parts[index + 1];
		if (!path) continue;
		if (status === 'A') added.push(validateDocumentPath(path));
		else if (status === 'D') deleted.push(validateDocumentPath(path));
	}
	return { added, deleted };
}

function contentSimilarity(left: string, right: string): number {
	const lines = (value: string): string[] => value.replace(/\r\n?/g, '\n').split('\n').filter(Boolean);
	const leftLines = lines(left);
	const rightLines = lines(right);
	if (leftLines.length === 0 && rightLines.length === 0) return 1;
	const available = new Map<string, number>();
	for (const line of leftLines) available.set(line, (available.get(line) ?? 0) + 1);
	let common = 0;
	for (const line of rightLines) {
		const count = available.get(line) ?? 0;
		if (count > 0) {
			common += 1;
			available.set(line, count - 1);
		}
	}
	return (2 * common) / (leftLines.length + rightLines.length);
}

function preflightPatch(
	rawNumstat: string,
	blobSizes: number[],
	maxLines: number,
	maxBytes: number,
): DocumentPatch | undefined {
	const entries = parseNumstats(rawNumstat.split('\0'));
	if (entries.some((entry) => entry.binary)) return binaryPatch();
	const additions = entries.reduce((sum, entry) => sum + entry.additions, 0);
	const deletions = entries.reduce((sum, entry) => sum + entry.deletions, 0);
	if (additions + deletions > maxLines || blobSizes.some((size) => size > maxBytes)) {
		return oversizedPatch(additions, deletions);
	}
	return undefined;
}

export class DocumentHistoryService {
	private readonly maxPatchLines: number;
	private readonly maxPatchBytes: number;
	private readonly maxVersions: number;

	constructor(private readonly git: DocumentHistoryGit, options: DocumentHistoryOptions = {}) {
		this.maxPatchLines = options.maxPatchLines ?? DEFAULT_MAX_PATCH_LINES;
		this.maxPatchBytes = options.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES;
		this.maxVersions = options.maxVersions ?? DEFAULT_MAX_VERSIONS;
	}

	private async blobSize(revision: string, path: string): Promise<number | undefined> {
		try {
			const value = (await this.git.raw(['cat-file', '-s', `${revision}:${path}`])).trim();
			return /^\d+$/.test(value) ? Number(value) : undefined;
		} catch {
			return undefined;
		}
	}

	private async discoverPreviousPath(hash: string, path: string): Promise<string | undefined> {
		try {
			const safeHash = validateCommitHash(hash);
			const safePath = validateDocumentPath(path);
			const changes = parseAddedAndDeletedPaths(await this.git.raw([
				'diff-tree', '--root', '--no-commit-id', '--name-status', '-z', '--no-renames', '--diff-filter=AD',
				'--no-ext-diff', '--no-textconv', '-r', safeHash,
			]));
			if (!changes.added.includes(safePath)) return undefined;
			const currentSize = await this.blobSize(safeHash, safePath);
			if (currentSize === undefined || currentSize > this.maxPatchBytes) return undefined;
			const currentContents = await this.git.raw(['show', '--format=', `${safeHash}:${safePath}`]);
			let best: { path: string; similarity: number } | undefined;
			for (const candidate of changes.deleted.slice(0, 20)) {
				const oldSize = await this.blobSize(`${safeHash}^`, candidate);
				if (oldSize === undefined || oldSize > this.maxPatchBytes) continue;
				const oldContents = await this.git.raw(['show', '--format=', `${safeHash}^:${candidate}`]);
				const similarity = contentSimilarity(oldContents, currentContents);
				if (!best || similarity > best.similarity) best = { path: candidate, similarity };
			}
			return best && best.similarity >= 0.5 ? best.path : undefined;
		} catch {
			// Rename discovery is a bounded compatibility fallback. The visible history remains usable if Git cannot infer a rename.
			return undefined;
		}
	}

	async load(pathValue: string, currentContents = '', previousPathValues: string[] = []): Promise<DocumentHistorySnapshot> {
		const path = validateDocumentPath(pathValue);
		const hintedPaths = previousPathValues.map(validateDocumentPath).filter((candidate) => candidate !== path);
		let branch = 'Current branch';
		try {
			branch = (await this.git.raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim() || branch;
		} catch {
			try {
				branch = (await this.git.raw(['symbolic-ref', '--short', 'HEAD'])).trim() || branch;
			} catch {
				// An unborn or detached repository can still show an empty local history.
			}
		}
		const statusRaw = await this.git.raw(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
		let status = documentStatus(statusRaw, path);
		let hintedRename = false;
		const hintedOldPath = hintedPaths[0];
		if ((status.state === 'untracked' || status.state === 'staged') && hintedOldPath) {
			const oldStatus = documentStatus(statusRaw, hintedOldPath);
			if (oldStatus.state !== 'clean' && oldStatus.state !== 'untracked') {
				status = { state: 'renamed', oldPath: hintedOldPath, newPath: path };
				hintedRename = true;
			}
		}
		const state = status.state;
		const historyPath = status.oldPath && status.newPath === path ? validateDocumentPath(status.oldPath) : path;
		const previousPaths = hintedPaths.filter((candidate) => candidate !== historyPath);
		const patchPaths = status.oldPath && status.newPath
			? [validateDocumentPath(status.oldPath), validateDocumentPath(status.newPath)]
			: [path];
		let hasHead = true;
		try {
			await this.git.raw(['rev-parse', '--verify', 'HEAD']);
		} catch {
			hasHead = false;
		}

		let localPatch = toDocumentPatch('', this.maxPatchLines, this.maxPatchBytes);
		if (state === 'untracked') {
			localPatch = addedFileDocumentPatch(path, currentContents, this.maxPatchLines, this.maxPatchBytes);
		} else if (state !== 'clean' && hasHead) {
			const oldSize = await this.blobSize('HEAD', historyPath);
			const currentSize = currentContents.length > this.maxPatchBytes
				? currentContents.length
				: new TextEncoder().encode(currentContents).length;
			if ([oldSize ?? 0, currentSize].some((size) => size > this.maxPatchBytes)) {
				localPatch = oversizedPatch(0, 0);
			} else if (hintedRename && status.oldPath && status.newPath) {
				const oldContents = await this.git.raw(['show', '--format=', `HEAD:${status.oldPath}`]);
				localPatch = renamedDocumentPatch(
					status.oldPath,
					status.newPath,
					oldContents,
					currentContents,
					this.maxPatchLines,
					this.maxPatchBytes,
				);
			} else {
				const rawNumstat = await this.git.raw([
					'--literal-pathspecs', 'diff', '--numstat', '-z', '--no-ext-diff', '--no-textconv', 'HEAD', '--', ...patchPaths,
				]);
				localPatch = preflightPatch(rawNumstat, [oldSize ?? 0, currentSize], this.maxPatchLines, this.maxPatchBytes)
					?? toDocumentPatch(await this.git.raw([
					'--literal-pathspecs', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--find-renames', '--unified=3',
					'HEAD', '--', ...patchPaths,
					]), this.maxPatchLines, this.maxPatchBytes);
			}
		}

		let versions: DocumentVersion[] = [];
		if (hasHead) {
			let localOnly = new Set<string>();
			try {
				const hashes = await this.git.raw(['rev-list', '--max-count', String(this.maxVersions * 4), 'HEAD', '--not', '--remotes=origin']);
				localOnly = new Set(hashes.split(/\r?\n/).filter((hash) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(hash)));
			} catch {
				// A repository without an origin can still show its local document history.
			}
			const historyPaths = Array.from(new Set([historyPath, ...previousPaths])).slice(0, 8);
			const versionsByHash = new Map<string, DocumentVersion>();
			const hashesByPath = new Map<string, Set<string>>();
			for (let pathIndex = 0; pathIndex < historyPaths.length && pathIndex < 8; pathIndex += 1) {
				const historicalPath = historyPaths[pathIndex];
				const rawLog = await this.git.raw([
					'--literal-pathspecs', 'log', '--no-color', '--no-ext-diff', '--no-textconv', '-n', String(this.maxVersions),
					'--format=%x1e%H%x00%an%x00%aI%x00%s%x00', '-z', '--', historicalPath,
				]);
				const pathVersions = parseDocumentLog(rawLog, historicalPath, localOnly);
				hashesByPath.set(historicalPath, new Set(pathVersions.map((version) => version.hash)));
				for (const version of pathVersions) {
					if (!versionsByHash.has(version.hash)) versionsByHash.set(version.hash, version);
				}
				if (pathIndex + 1 >= historyPaths.length && pathVersions.length > 0 && versionsByHash.size < this.maxVersions) {
					const boundaryVersion = pathVersions[pathVersions.length - 1];
					const discoveredPath = await this.discoverPreviousPath(boundaryVersion.hash, historicalPath);
					if (discoveredPath && !historyPaths.includes(discoveredPath)) {
						boundaryVersion.previousPath = discoveredPath;
						historyPaths.push(discoveredPath);
					}
				}
			}
			for (let index = 0; index + 1 < historyPaths.length; index += 1) {
				const currentPath = historyPaths[index];
				const previousPath = historyPaths[index + 1];
				const previousHashes = hashesByPath.get(previousPath);
				const renameVersion = Array.from(versionsByHash.values()).find((version) =>
					version.path === currentPath && previousHashes?.has(version.hash));
				if (renameVersion) renameVersion.previousPath = previousPath;
			}
			versions = Array.from(versionsByHash.values())
				.sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp))
				.slice(0, this.maxVersions);
		}

		return { path, branch, local: { state, patch: localPatch }, versions };
	}

	async loadVersionPatch(hashValue: string, pathValue: string, previousPathValue?: string): Promise<DocumentPatch> {
		const hash = validateCommitHash(hashValue);
		const path = validateDocumentPath(pathValue);
		const previousPath = previousPathValue ? validateDocumentPath(previousPathValue) : path;
		const patchPaths = Array.from(new Set([previousPath, path]));
		const [currentSize, previousSize] = await Promise.all([
			this.blobSize(hash, path),
			this.blobSize(`${hash}^`, previousPath),
		]);
		if ([currentSize ?? 0, previousSize ?? 0].some((size) => size > this.maxPatchBytes)) {
			return oversizedPatch(0, 0);
		}
		const rawNumstat = await this.git.raw([
			'--literal-pathspecs', 'show', '--numstat', '-z', '--format=', '--find-renames', '--no-ext-diff', '--no-textconv',
			hash, '--', ...patchPaths,
		]);
		const preflight = preflightPatch(rawNumstat, [currentSize ?? 0, previousSize ?? 0], this.maxPatchLines, this.maxPatchBytes);
		if (preflight) return preflight;
		return toDocumentPatch(await this.git.raw([
			'--literal-pathspecs', 'show', '--format=', '--find-renames', '--no-color', '--no-ext-diff', '--no-textconv', '--unified=3',
			hash, '--', ...patchPaths,
		]), this.maxPatchLines, this.maxPatchBytes);
	}
}
