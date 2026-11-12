# Contributing to AI Review Status Labeler

Thank you for your interest in contributing! This guide covers local development, testing, bundling, adding new provider adapters, and the release workflow.

---

## 🛠️ Local Development Setup

### Prerequisites
- Node.js 24+ (or 20+ for local tooling; `action.yml` targets `node24`)
- npm

### Install & Verify
```bash
npm ci
npm run typecheck
npm test
npm run build
```

> [!IMPORTANT]
> GitHub Actions executes `dist/index.js` directly from the repository. Whenever you modify files under `src/`, run `npm run build` and include the updated `dist/` artifacts in your commit. CI checks `git diff --exit-code dist/` on every pull request.

---

## 🧩 Architecture Overview

- `src/index.ts` — Action entrypoint reading inputs and setting outputs via `@actions/core`.
- `src/runner.ts` — Event routing (`pull_request` / `pull_request_target` cleanup vs. provider evaluation), PR resolution (including `check_run.pull_requests` fallback via commit lookup), commit SHA staleness checks, and fork `403` handling.
- `src/labels.ts` — Octokit label engine (`syncStatusLabels`, `clearManagedLabels`, missing label creation with `422` concurrency handling).
- `src/providers/` — AI reviewer adapters implementing `ProviderAdapter` (`src/types.ts`).

### Adding a New Provider Adapter
1. Create `src/providers/<provider>.ts` implementing `ProviderAdapter` (`name` and `evaluate(eventName, payload)`).
2. Register the factory in `src/providers/index.ts`.
3. Add unit tests covering real webhook payload shapes and edge cases in `tests/`.
4. Run `npm run typecheck && npm test && npm run build`.

---

## 📦 Releasing & Tagging (Maintainers)

This repository keeps immutable SemVer tags (`vX.Y.Z`) and updates floating major tags (`v1`, `v2`, ...) on release:

1. Ensure all changes and updated `dist/` artifacts are merged into `main` with passing CI.
2. Create and publish a GitHub Release on a new SemVer tag (e.g., `v1.0.0`), optionally selecting **Publish this Action to the GitHub Marketplace**.
3. If using the major-tag automation workflow, the corresponding floating major tag (e.g., `v1`) is updated to point to the released commit.
