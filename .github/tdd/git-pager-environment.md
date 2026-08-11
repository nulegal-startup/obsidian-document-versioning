# Git pager environment TDD evidence

## Journey

- A user with `GIT_PAGER` configured can open Document Versioning without a false GitHub setup warning.

## RED

- `node --test tests/github-auth.test.mjs` failed because pager variables survived environment sanitization.
- Checkpoint: `f9fea61`.

## GREEN

- `GIT_PAGER` and `PAGER` are removed before Git and GitHub CLI subprocesses are created.
- Checkpoint: `7e0470b`.
- Targeted tests: 10/10 passed.
- Full suite: 76/76 passed.
- Production build passed.
- Targeted coverage: 84.67% lines and 100% functions.
