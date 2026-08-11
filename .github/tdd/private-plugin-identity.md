# Private plugin identity TDD evidence

## Journey

- A NuLegal user sees only NuLegal ownership and release information in Obsidian, while existing private settings survive the identity migration.

## RED

- `node --test tests/plugin-identity.test.mjs` failed because the manifest still used the upstream public ID `github-sync`.
- Checkpoint: `f81a69e`.

## GREEN

- The manifest now uses `nulegal-document-versioning`, with NuLegal name, author, and repository URL.
- The Makefile replaces the legacy enabled ID, copies existing settings, installs the new ID, and removes the legacy manifest.
- Checkpoint: `309cdfb`.
- Targeted identity test: 1/1 passed.
- Full suite: 76/76 passed.
- Production build passed.
- Coverage: 85.43% lines overall.

## Installer validation

- Fresh and legacy community-plugin arrays both resolve to exactly one enabled `nulegal-document-versioning` entry.
- `auth`, `setup`, `doctor`, and `update` expand to valid Bash under macOS Make.
