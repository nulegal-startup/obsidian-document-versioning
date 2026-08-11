# First-run workflow defaults TDD evidence

## Journey

- A NuLegal user opens the plugin for the first time and can start working without entering a repository URL, base branch, or branch prefix.

## RED

- `node --test tests/workflow-defaults.test.mjs` failed because the plugin had no centralized NuLegal workflow defaults.
- Checkpoint: `3937ec4`.

## GREEN

- First run now uses the private `nulegal-startup/docs` repository, `main` base branch, `changes/*` branches, base-branch protection, and draft reviews.
- Blank legacy repository values are repaired automatically; an existing nonempty repository value is preserved.
- The repository URL field was removed from the regular settings UI.
- Checkpoint: `94b1f9f`.
- Targeted test: 2/2 passed.
- Full suite: 78/78 passed.
- Production build passed.
- Targeted coverage: 100% lines, branches, and functions.
