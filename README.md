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
- Refuse to switch branches when local or remote work is not synchronized.
- Stop on merge conflicts and open each conflicting note for resolution.
- Prevent overlapping manual, startup, and scheduled Git operations.
- Reject credential-bearing remote URLs and redact common GitHub tokens from errors.

## Documentation workflow

1. Click **Git: main** in the status bar or the branch ribbon icon to open the branch manager.
2. Enter a short change name, such as `Next sprint billing`.
3. Edit notes normally in Obsidian.
4. Choose **GitHub Sync: Sync current branch** or click the GitHub ribbon icon.
5. Open a pull request on GitHub when the change is ready for review.
6. After the pull request is merged, use **Return to main** in the branch manager.

The branch manager also lists existing local and GitHub branches. Switching is allowed only when the current branch is clean and synchronized, preventing uncommitted edits from being silently carried between changes.

If files were edited while still on protected `main`, clicking Sync does not commit them to `main`. It opens the branch manager; **Start change** creates the new branch and commits those edits there.

Git operations run in the background with a non-blocking activity card. Completed stages receive check marks, the active stage appears in both the card and status bar, and the final state clearly reports success, required action, or failure. The progress is stage-based because Git does not expose a reliable percentage for every operation.

The default accepted branch is `main`, and the default change prefix is `changes`.

## Setup

Your Obsidian vault must already be a Git repository with an `origin` remote. Configure these plugin settings:

- **Remote URL:** an HTTPS URL without credentials, or an SSH URL.
- **Base branch:** normally `main`.
- **Protect base branch:** keep enabled to prevent direct commits to `main`.
- **Change branch prefix:** normally `changes`.
- **Git binary location:** leave empty when Git is available on your system path.

Examples of accepted remotes:

```text
https://github.com/your-organization/docs.git
git@github.com:your-organization/docs.git
```

Do not embed a GitHub token in the remote URL. Use SSH or Git Credential Manager.

## Conflict behavior

The plugin automatically merges non-overlapping changes. If Git reports a conflict, the plugin:

- does not push;
- lists the conflicting files;
- opens those notes in Obsidian; and
- requires the conflict to be resolved before synchronization can continue.

It never silently selects one version of a conflicted note.

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
- Production dependencies and the development toolchain are checked with `npm audit`.

See [SECURITY_REVIEW.md](SECURITY_REVIEW.md) for the focused review performed for this fork.

## Attribution

Maintained by [NuLegal](https://github.com/nulegal-startup). Originally created by [Kevin Chin](https://github.com/kevinmkchin); this fork remains under the repository's MIT license.
