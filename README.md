# GitHub Sync for Obsidian — Branch Workflow Fork

This fork adds a non-technical, branch-based documentation workflow to Kevin Chin's original [Obsidian GitHub Sync](https://github.com/kevinmkchin/Obsidian-GitHub-Sync) plugin.

## What this fork adds

- Start a documentation change from the latest accepted branch.
- Generate safe branch names such as `changes/next-sprint-billing` from human-readable titles.
- Synchronize the current branch instead of always pushing to `main`.
- Return safely to the configured base branch after a change is merged.
- Protect the accepted branch from direct commits by default.
- Open a branch manager from the status bar or branch ribbon icon.
- Display, switch, and synchronize the explicitly selected current branch.
- Carry edits accidentally made on `main` into a new change branch before committing them.
- Show a live operation timeline while Git is checking, fetching, merging, switching, or pushing.
- Mirror the current operation in the status bar and temporarily disable conflicting ribbon actions.
- Keep errors and action-needed states visible long enough to understand what happened.
- Follow Obsidian's live light/dark appearance when its base color scheme adapts to the system.
- Show the current branch as a clickable badge in the active note header and status bar.
- Display deterministic `ahead`, `behind`, `diverged`, `up to date`, and `not published` branch states.
- Fast-forward clean remote-only updates through an explicit **Update branch** action.
- Require **Sync current** when local edits or commits must be saved, merged, or pushed.
- Refuse to switch branches when local or remote work is not synchronized.
- Pause on merge conflicts and show each conflicting section directly in the note.
- Keep a workspace-wide Conflict Center with document and section counts.
- Offer review-only Codex, Ollama, or LM Studio suggestions for one conflict at a time.
- Create or reuse a draft GitHub pull request when a change branch is published.
- Attach selected-text comments to that review without changing the Markdown document.
- Support collaborator mentions, replies, resolve/reopen, and a workspace Review Center.
- Prevent overlapping manual, startup, and scheduled Git operations.
- Reject credential-bearing remote URLs and redact common GitHub tokens from errors.

## Documentation workflow

1. Click **Git: main** in the status bar or the branch ribbon icon to open the branch manager.
2. Enter a short change name, such as `Next sprint billing`.
3. Edit notes normally in Obsidian.
4. Choose **GitHub Sync: Sync current branch** or click the GitHub ribbon icon.
5. Select text and use **Comment on selected text** when a decision needs discussion; the draft review is created automatically.
6. After the pull request is merged, use **Return to main** in the branch manager.

The branch manager also lists existing local and GitHub branches. Switching is allowed only when the current branch is clean and synchronized, preventing uncommitted edits from being silently carried between changes.

If files were edited while still on protected `main`, clicking Sync does not commit them to `main`. It opens the branch manager; **Start change** creates the new branch and commits those edits there.

Git operations run in the background with a non-blocking activity card. Completed stages receive check marks, the active stage appears in both the card and status bar, and the final state clearly reports success, required action, or failure. The progress is stage-based because Git does not expose a reliable percentage for every operation.

The branch badge uses `↓N` for remote commits not yet pulled, `↑N` for local commits not yet pushed, and both when histories have diverged. Opening the Branch Manager refreshes this state from GitHub. A clean branch that is only behind can be fast-forwarded with **Update branch**; branches with local work use **Sync current** so the remote history is merged without force-pushing.

The default accepted branch is `main`, and the default change prefix is `changes`.

## Setup

Your Obsidian vault must already be a Git repository with an `origin` remote. Configure these plugin settings:

- **Remote URL:** an HTTPS URL without credentials, or an SSH URL.
- **Base branch:** normally `main`.
- **Protect base branch:** keep enabled to prevent direct commits to `main`.
- **Change branch prefix:** normally `changes`.
- **Git binary location:** leave empty when Git is available on your system path.
- **Create draft review automatically:** keep enabled to connect each published change branch to one draft pull request.
- **GitHub CLI executable:** leave empty when `gh` is on `PATH`; run `gh auth login` once on each editor's computer.
- **AI provider:** optional; disabled by default. Codex uses the local Codex CLI login, while Ollama and LM Studio use a local model server through the Codex CLI.
- **Codex executable:** optional full path; leave empty to use the ChatGPT app copy or `codex` on `PATH`.

Examples of accepted remotes:

```text
https://github.com/your-organization/docs.git
git@github.com:your-organization/docs.git
```

Do not embed a GitHub token in the remote URL. Use SSH or Git Credential Manager.

## Selected-text review behavior

Select text in a Markdown note and use the editor context menu or command palette action **Comment on selected text**. The plugin records a deterministic text anchor (file, line range, selected text, and bounded surrounding context) in hidden metadata on the branch's draft pull request. The Markdown file itself remains unchanged.

The **Documentation review** side panel groups replies into threads and lets editors navigate back to the note, reply, resolve, or reopen a discussion. `@mentions` use GitHub identities and normal GitHub notifications. If the selected wording moves, the bounded context lets the plugin re-identify it; if it is deleted, the thread remains available in the Review Center as historical discussion.

Review comments require a GitHub account with repository access and an authenticated GitHub CLI. The plugin never stores a GitHub token. Failure to create or refresh a review does not block Git commits, pulls, or pushes.

## Conflict behavior

The plugin automatically merges non-overlapping changes. If Git reports a conflict, the plugin:

- does not push;
- opens the first affected note and the workspace-wide **Conflict Center** after a user-triggered sync;
- shows persistent conflict counts without opening a surprise modal on startup;
- replaces raw Git markers with a side-by-side review block for each conflicting section;
- lets the user keep the current text, keep the GitHub text, keep both, or edit the final wording;
- optionally asks Codex, Ollama, or LM Studio for a structured suggestion that remains review-only;
- rejects an AI response if the underlying conflict changed while the provider was working; and
- stages a document only after every section is reviewed and the user clicks **Mark resolved**.

It never silently selects one version, applies AI text, stages a document, commits, or pushes a conflict resolution.

## Installation for development

```bash
npm ci
npm test
npm run build
```

Copy `main.js`, `manifest.json`, and `styles.css` into:

```text
<vault>/.obsidian/plugins/github-sync/
```

Then reload Obsidian and enable **GitHub Sync** under Community Plugins.

## Security notes

- This is a desktop-only plugin because it invokes the local Git executable.
- The vault's `.gitignore` should exclude private files that must never reach the documentation repository.
- The plugin settings file should remain ignored if you maintain a custom Obsidian configuration policy.
- AI conflict suggestions are disabled by default. The first request to a selected provider discloses the exact data scope and requires consent.
- The AI subprocess uses argument arrays instead of a shell, an isolated temporary directory, a read-only Codex sandbox, ephemeral sessions, bounded input, and a strict JSON output schema.
- GitHub review requests also use argument arrays without a shell; comment content is bounded and credentials are delegated to the GitHub CLI.
- Production dependencies and the development toolchain are checked with `npm audit`.

See [SECURITY_REVIEW.md](SECURITY_REVIEW.md) for the focused review performed for this fork.

## Attribution

Maintained by [NuLegal](https://github.com/nulegal-startup). Originally created by [Kevin Chin](https://github.com/kevinmkchin); this fork remains under the repository's MIT license.
