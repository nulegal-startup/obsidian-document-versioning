# Security Review

Review scope: branch workflow fork of Obsidian GitHub Sync, including Git command construction, vault changes, remote configuration, credentials, dependencies, and conflict behavior.

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

## Residual risks

- The plugin executes the Git binary configured by the local user. A malicious person who can alter Obsidian plugin settings already has access equivalent to that desktop user.
- Git authentication remains delegated to SSH or the operating system's Git credential manager.
- The plugin commits all non-ignored vault changes. Repository owners must maintain an appropriate `.gitignore` and avoid storing secrets in notes.
- Git provides asynchronous collaboration, not live co-editing. Simultaneous changes to the same lines can still require human conflict resolution.
- Pull-request creation and merge authorization remain on GitHub and are not implemented in this plugin.

## Verification

- TypeScript production build
- Unit tests for branch normalization, reference validation, remote validation, and secret redaction
- Production dependency audit
- Full dependency audit
- Manual review of every Git invocation and all user-controlled arguments
