# AI Review Status Labeler (`ai-review-status-labeler`)

[![CI](https://github.com/asabon/ai-review-status-labeler/actions/workflows/ci.yml/badge.svg)](https://github.com/asabon/ai-review-status-labeler/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 24](https://img.shields.io/badge/node-24-339933.svg?logo=node.js&logoColor=white)](action.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6.svg?logo=typescript&logoColor=white)](tsconfig.json)

A GitHub Action that inspects AI code review results (e.g., CodeRabbit) and synchronizes mutually exclusive status labels on pull requests so you can see at a glance which PRs were skipped due to rate limits, require changes, or passed AI review.

---

## ✨ Features & Safeguards

- **Mutually Exclusive Status Labels:** Automatically removes stale managed labels before applying the newly resolved label.
- **Rate-Limit & Skip Detection:** Surfaces quiet skips (e.g., `check_run` `skipped`/non-success conclusions, `< 10 stars` skip banners, or `Review rate limited.` replies) without false-positiving on informational replies like `@coderabbitai rate limits` (`Reviews are available now.`).
- **Race-Condition Safe:** Defers `approved` / `changes-requested` verdicts to review and summary comment events so a `check_run` (`success`) never overwrites actionable review findings.
- **Outdated-Commit Guard:** Verifies `check_run.head_sha`, `review.commit_id`, and embedded CodeRabbit commit metadata against the PR's current `head.sha` to ignore delayed results from superseded commits.
- **Stale Label Cleanup on Push:** Supports `pull_request` / `pull_request_target` (`synchronize`) to clear old status labels when new commits are pushed.
- **Auto-Create Missing Labels:** Creates missing status labels with default colors and descriptions while preserving any user-customized colors or descriptions on existing labels.
- **Fork PR Friendly:** Gracefully logs a warning and exits cleanly if a fork PR's `pull_request (synchronize)` event runs with a read-only `GITHUB_TOKEN` (`403`), while `issue_comment`, `pull_request_review`, and `check_run` continue to synchronize labels normally.

---

## 🏷️ Status Labels

| State | Default Label | Default Color | When Applied (`coderabbit`) |
| :--- | :--- | :--- | :--- |
| **Skipped / Throttled** | `ai: skipped` | `#fbca04` | `check_run` concludes with non-`success` (e.g., `skipped`, `failure`), summary comment shows an active skip banner, or reply indicates rate limiting (`Review rate limited.`). |
| **Actionable Findings** | `ai: changes-requested` | `#d93f0b` | `pull_request_review` has state `changes_requested` or `Actionable comments posted: N` (`N > 0`), or review summary reports actionable comments. |
| **Approved / Clean** | `ai: approved` | `#0e8a16` | Review summary reports `No actionable comments were generated` / `Actionable comments posted: 0`, or `pull_request_review` has state `approved`. |

---

## 🚀 Quick Start

Create `.github/workflows/ai-review-status.yml` in your repository:

```yaml
name: AI Review Status Sync

on:
  issue_comment:
    types: [created, edited]
  pull_request_review:
    types: [submitted]
  check_run:
    types: [completed]
  pull_request:
    types: [synchronize]

permissions:
  pull-requests: write
  issues: write
  contents: read
  checks: read

jobs:
  label-sync:
    if: >
      (github.event_name == 'issue_comment' && github.event.issue.pull_request && github.event.comment.user.login == 'coderabbitai[bot]') ||
      (github.event_name == 'pull_request_review' && github.event.review.user.login == 'coderabbitai[bot]') ||
      (github.event_name == 'check_run' && github.event.check_run.app.slug == 'coderabbitai') ||
      (github.event_name == 'pull_request' && github.event.action == 'synchronize')
    runs-on: ubuntu-latest
    steps:
      - name: Sync AI Review Status
        uses: asabon/ai-review-status-labeler@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          provider: 'coderabbit'
```

> [!NOTE]
> For fork PRs, `pull_request` (`synchronize`) receives a read-only `GITHUB_TOKEN`, so stale label cleanup is skipped with a warning (while `issue_comment`, `pull_request_review`, and `check_run` still run with write permissions). If you also want stale labels cleared when external contributors push to fork PRs, handle `pull_request_target` (`types: [synchronize]`) in a dedicated job that does **not** check out or execute untrusted PR code.

### Required Permissions

| Permission | Reason |
| :--- | :--- |
| `pull-requests: write` | Read PR head SHA / labels and add or remove status labels |
| `issues: write` | Create missing repository labels and manage issue/PR labels |
| `checks: read` | Read `check_run` event metadata and associated commits |

---

## ⚙️ Inputs & Outputs

### Inputs

| Input | Required | Default | Description |
| :--- | :--- | :--- | :--- |
| `github-token` | Yes | `${{ github.token }}` | GitHub token used for Octokit REST API operations. |
| `provider` | No | `'coderabbit'` | AI review tool provider (`coderabbit`). |
| `label-skipped` | No | `'ai: skipped'` | Label to assign when review is skipped or throttled. |
| `label-actionable` | No | `'ai: changes-requested'` | Label to assign when actionable comments are found. |
| `label-approved` | No | `'ai: approved'` | Label to assign when review passes with no actionable issues. |
| `auto-create-labels` | No | `'true'` | Automatically create missing labels in the repository (`'true'` / `'false'`). Existing labels keep their current colors and descriptions. |

### Outputs

| Output | Description |
| :--- | :--- |
| `status` | Resolved status (`skipped`, `changes-requested`, `approved`, `cleared`, or `ignored`). |
| `label` | Label applied to the pull request, or empty string when `cleared` or `ignored`. |
| `pr-number` | Target pull request number, or empty string if not resolved. |

---

## 🔌 Supported Providers

| Provider | `provider` value | Supported Events |
| :--- | :--- | :--- |
| **CodeRabbit** | `coderabbit` | `check_run` (`completed`), `issue_comment` (`created`, `edited`), `pull_request_review` (`submitted`) |

Additional adapters can be added via [`ProviderAdapter`](src/types.ts). See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

---

## 📄 License & Disclaimer

Released under the [MIT License](LICENSE).

This is an independent community open-source project and is not affiliated with, sponsored by, or endorsed by CodeRabbit, Inc. or GitHub, Inc.
