# Security Review

Review scope: branch workflow fork of Obsidian GitHub Sync, including Git and GitHub CLI command construction, vault changes, remote configuration, credentials, dependencies, selected-text reviews, conflict behavior, and optional AI conflict suggestions.

## Resolved findings

### Critical — vulnerable Git execution dependency

The original repository used `simple-git` 3.22.0, which is affected by published command-execution advisories. It was upgraded to 3.36.0. `npm audit --omit=dev` and the full `npm audit` now report zero known vulnerabilities.

### High — credential disclosure through remote URLs and errors

The original documentation allowed a personal access token inside an HTTPS remote URL. Plugin settings live in the vault configuration and may be synchronized accidentally. Credential-bearing HTTPS URLs are now rejected, SSH or a credential manager is recommended, and common token formats are redacted from displayed errors.

### High — unsafe conflict guidance

The original plugin told users that another sync might push unresolved conflicts. The fork blocks commits and pushes while conflicts exist, reports the affected files, and requires explicit resolution.

### Medium — concurrent Git operations

Manual sync, startup sync, and scheduled sync could overlap. Git operations now use an in-process lock and `simple-git` is limited to one concurrent process.

### Medium — branch switching could strand work

Switching with a clean working tree can still abandon unpublished commits. Before switching, the fork now verifies that the current branch exists remotely and is neither ahead nor behind.

### Medium — incomplete staging

The original `git add ./*` did not reliably include deletions or hidden files. Synchronization now uses `git add -A` so the commit matches the vault working tree. Teams must still use `.gitignore` for files that should never be versioned.

### Low — unvalidated branch and remote input

Branch names are generated from a restricted slug and validated as Git references. Base branches and branch prefixes are also validated. Remote URLs are restricted to HTTPS and SSH and reject control characters.

### High — AI subprocess and document data exposure

AI suggestions are disabled by default and run only after the user clicks the suggestion action. The first request for a selected provider shows the exact data scope and requires consent. Requests include one conflict, bounded nearby context, the file path, and branch name; the rest of the vault is not included. Document content is explicitly delimited as untrusted data to reduce prompt-injection risk.

The Codex process is started with an argument array and no shell. It uses an isolated temporary directory, ephemeral mode, ignored repository rules and user configuration, a read-only sandbox, no approval prompts, a strict JSON output schema, bounded output, and a timeout. Temporary files use owner-only permissions and are removed in a `finally` block. Provider errors redact common GitHub and OpenAI token forms.

AI output is never written, staged, committed, or pushed automatically. The user must review and apply it. A content-derived conflict identifier rejects stale suggestions when the underlying conflict changes during inference.

### Medium — conflict resolution could stage unintended content

Raw conflict ranges are parsed deterministically and resolved one section at a time. **Mark resolved** refuses to stage while any complete conflict marker remains, rechecks Git's conflicted-file list, and stages only the explicitly selected path using `git add -- <path>`. File paths are normalized and prevented from escaping the vault.

### High — review comments could introduce command or UI injection

GitHub review operations invoke the authenticated `gh` executable with argument arrays and never use a shell. Branch, repository, executable, path, selection, comment, and metadata lengths or formats are validated or bounded. Remote comment text, authors, quotes, and errors are rendered as text rather than HTML. Hidden metadata is versioned, size-bounded, structurally validated, and rejects absolute or parent-traversal paths before a note can be opened.

The plugin delegates credentials to GitHub CLI and never reads or stores its token. Draft review creation is fail-open only with respect to Git synchronization: a GitHub review API or authentication failure is reported but cannot prevent the already-authorized branch push from completing.

## Residual risks

- The plugin executes the Git binary configured by the local user. A malicious person who can alter Obsidian plugin settings already has access equivalent to that desktop user.
- Git authentication remains delegated to SSH or the operating system's Git credential manager.
- The plugin commits all non-ignored vault changes. Repository owners must maintain an appropriate `.gitignore` and avoid storing secrets in notes.
- Git provides asynchronous collaboration, not live co-editing. Simultaneous changes to the same lines can still require human conflict resolution.
- Draft pull-request creation and comments use the permissions of the locally authenticated GitHub CLI account. Repository owners remain responsible for access control, branch protection, retention, and merge authorization.
- Selected text and bounded surrounding context are stored in hidden GitHub comment metadata. They are visible to repository collaborators who can read the pull request and must be treated as repository data, not local-only notes.
- Codex may send the selected conflict to OpenAI under the user's configured Codex account. Ollama and LM Studio keep inference local only when the user's local provider configuration does so. Users remain responsible for provider data-retention and model policies.
- Delimiting note content reduces prompt-injection risk but cannot guarantee that every model ignores adversarial document text. Suggestions remain untrusted until reviewed.

## Verification

- TypeScript production build
- Unit tests for branch normalization, reference validation, remote validation, secret redaction, multi-hunk parsing, per-hunk resolution, bounded AI prompt scope, deterministic text anchors, review metadata validation, draft PR reuse, shell-free comment arguments, and structured-output rejection
- Production dependency audit
- Full dependency audit
- Manual review of every Git, GitHub CLI, and Codex invocation and user-controlled argument
- Obsidian 1.13.6 runtime verification with an existing unresolved conflict and zero console errors after a clean reload
