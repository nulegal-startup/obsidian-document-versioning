# GitHub Sync for Obsidian — Branch Workflow Fork

This fork adds a non-technical, branch-based documentation workflow to Kevin Chin's original [Obsidian GitHub Sync](https://github.com/kevinmkchin/Obsidian-GitHub-Sync) plugin.

## What this fork adds

- Start a documentation change from the latest accepted branch.
- Generate safe branch names such as `changes/next-sprint-billing` from human-readable titles.
- Synchronize the current branch instead of always pushing to `main`.
- Return safely to the configured base branch after a change is merged.
- Display the current branch in Obsidian's status bar.
- Refuse to switch branches when local or remote work is not synchronized.
- Stop on merge conflicts and open each conflicting note for resolution.
- Prevent overlapping manual, startup, and scheduled Git operations.
- Reject credential-bearing remote URLs and redact common GitHub tokens from errors.

## Documentation workflow

1. Open the command palette and choose **GitHub Sync: Start a change branch**.
2. Enter a short change name, such as `Next sprint billing`.
3. Edit notes normally in Obsidian.
4. Choose **GitHub Sync: Sync current branch** or click the GitHub ribbon icon.
5. Open a pull request on GitHub when the change is ready for review.
6. After the pull request is merged, choose **GitHub Sync: Return to base branch**.

The default accepted branch is `main`, and the default change prefix is `changes`.

## Setup

Your Obsidian vault must already be a Git repository with an `origin` remote. Configure these plugin settings:

- **Remote URL:** an HTTPS URL without credentials, or an SSH URL.
- **Base branch:** normally `main`.
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
