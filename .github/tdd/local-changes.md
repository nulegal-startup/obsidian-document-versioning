# Local changes TDD evidence

## User journeys

- See every modified, added, deleted, renamed, or conflicted vault file in one place.
- Find changes by folder, expand a bounded local diff, and open the file.
- Revert one selected file without touching other local work.
- Open Local changes automatically when local work blocks a branch switch.

## RED

- `node --test tests/local-changes.test.mjs` failed because `local-changes.ts` did not exist.
- Grouping test failed before `groupLocalChangesByFolder` was implemented.
- Binary-file test failed while new binary contents were rendered as text.
- Checkpoints: `b8a385b`, `1694565`.

## GREEN

- Model checkpoint: `0fb38f7`.
- Targeted behavior: 20/20 tests pass.
- Full suite: 75/75 tests pass.
- Coverage: 85.43% lines overall; `local-changes.mjs` 96.88% lines and 100% functions.
- Production TypeScript build and bundle pass.

## Safety evidence

- Revert behavior is covered against a real temporary Git repository.
- Every file operand uses literal Git pathspecs and validated vault-relative paths.
- History/diff work is local-only, bounded, and binary-safe.
