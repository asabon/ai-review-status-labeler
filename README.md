# AI Review Status Labeler (`ai-review-status-labeler`)

[![CI](https://github.com/asabon/ai-review-status-labeler/actions/workflows/ci.yml/badge.svg)](https://github.com/asabon/ai-review-status-labeler/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 24](https://img.shields.io/badge/node-24-339933.svg?logo=node.js&logoColor=white)](action.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6.svg?logo=typescript&logoColor=white)](tsconfig.json)

A GitHub Action that automatically inspects AI code review results (e.g., CodeRabbit) and synchronizes pull request labels to reflect actionable comments, clean reviews, or skipped evaluations due to rate limits.

---

## 🎯 Motivation & Purpose

When managing multiple repositories simultaneously with AI reviewers like CodeRabbit:
1. **Hidden Rate Limits:** Reviews skipped due to rolling-window quotas (e.g., free tier limits) fail quietly via check runs or comment warnings, leaving PRs unnoticed in an unreviewed state.
2. **Review Visibility:** It is difficult to distinguish at a glance which PRs require developer fixes versus those that have already passed AI inspection.
3. **Multi-Repo Friction:** Checking the CodeRabbit web dashboard or running `@coderabbitai rate limits` across several repositories introduces cognitive context-switching.

This Action bridges that gap by parsing webhook payloads (`issue_comment`, `check_run`, etc.) and dynamically toggling exclusive status labels on PRs.

---

## 🏷️ Target State & Label Lifecycle

The Action manages a mutually exclusive set of status labels per PR:

| State | Default Label | Trigger Condition (CodeRabbit) |
| :--- | :--- | :--- |
| **Review Skipped / Throttled** | `ai: skipped` (or `レビュー未実施`) | Check run conclusion is not success, or comment text indicates rate limiting (e.g., `rate limit`). |
| **Actionable Findings** | `ai: changes-requested` (or `指摘あり`) | Review summary contains actionable feedback, changes requested, or inline critique comments. |
| **Review Approved / Clean** | `ai: approved` (or `レビューOK`) | Review completes with no actionable issues found, or summarizes changes as acceptable. |

*When moving between states, previously applied status labels managed by this action are automatically removed.*

---

## 📋 Requirements & Scope

### 1. Core Functional Requirements
- **Payload Parsing:**
  - Support `check_run` (`completed`) events from AI review apps (`coderabbitai`).
  - Support `issue_comment` (`created`, `edited`) and `pull_request_review` (`submitted`) events from AI reviewer bots (e.g., `coderabbitai[bot]`).
  - Support `pull_request` / `pull_request_target` (`synchronize`) to clear stale status labels when new commits are pushed.
- **Resilient Matching & Race-Condition Guards:**
  - Combine structured marker checks and regex patterns in the provider adapter (avoiding false positives such as `@coderabbitai rate limits` status replies).
  - Defer `approved` / `changes-requested` verdicts to review/comment events so a `check_run` (`success`) never overwrites actionable review findings.
  - Verify commit SHAs (`check_run.head_sha`, `review.commit_id`, and embedded CodeRabbit commit metadata) against the PR's current `head.sha` to ignore delayed results for superseded commits.
  - Fall back to commit-associated PR lookup when `check_run.pull_requests` is empty.
- **Label Management:**
  - Remove existing managed labels before applying the newly resolved label.
  - Optionally auto-create labels in the repository if they do not yet exist (with default colors/descriptions, preserving any user-customized colors/descriptions on existing labels).
  - On fork PR `pull_request (synchronize)` events where `GITHUB_TOKEN` is read-only (`403`), emit a warning and exit cleanly instead of failing CI.
- **Extensible Architecture:**
  - Initially targeted for CodeRabbit (`coderabbit`), structured with a `ProviderAdapter` interface so adapters for other AI review bots (GitHub Copilot PR Review, Qodo Merge, etc.) can be plugged in.

### 2. Technical Stack & Implementation Guidelines
- **Type:** TypeScript Action (`node24`) compiled via `@vercel/ncc` (`dist/index.js`), tested with Vitest.
- **Dependencies:** `@actions/core`, `@actions/github`.
- **Permissions Required:**
  - `pull-requests: write`
  - `issues: write`
  - `checks: read`

---

## ⚙️ Action Interface (`action.yml`)

```yaml
inputs:
  github-token:
    description: 'GitHub token for Octokit API operations'
    required: true
    default: ${{ github.token }}
  provider:
    description: 'AI review tool provider (default: coderabbit)'
    required: false
    default: 'coderabbit'
  label-skipped:
    description: 'Label to assign when review is skipped or throttled'
    required: false
    default: 'ai: skipped'
  label-actionable:
    description: 'Label to assign when actionable comments are found'
    required: false
    default: 'ai: changes-requested'
  label-approved:
    description: 'Label to assign when review passes with no issues'
    required: false
    default: 'ai: approved'
  auto-create-labels:
    description: 'Automatically create missing labels in the repository'
    required: false
    default: 'true'

outputs:
  status:
    description: 'Resolved action status (skipped, changes-requested, approved, cleared, or ignored)'
  label:
    description: 'Label applied to the pull request, or empty when cleared or ignored'
  pr-number:
    description: 'Target pull request number, or empty if not resolved'
```

---

## 🚀 Example Workflow Integration

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
    # Restrict execution to relevant AI review events or new commits
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
          label-skipped: 'ai: skipped'
          label-actionable: 'ai: changes-requested'
          label-approved: 'ai: approved'
```

> [!NOTE]
> For fork PRs, `pull_request` (`synchronize`) runs with a read-only `GITHUB_TOKEN`, so stale label cleanup is skipped with a warning (while `issue_comment`, `pull_request_review`, and `check_run` still run with write permissions). If you also want stale labels cleared on fork PR pushes, use `pull_request_target` (`types: [synchronize]`) in a dedicated job that does **not** check out or execute untrusted PR code.

---

## 🛠️ Development Milestones

- [x] **Phase 1 (Mock & Test):** Collect sample event payloads (`check_run`, `issue_comment`, `pull_request_review`) for CodeRabbit (rate limit / skip, review with issues, clean review).
- [x] **Phase 2 (Parser Engine):** Implement provider adapter (`CodeRabbitProvider`) with structured marker & regex matching and commit SHA staleness checks.
- [x] **Phase 3 (Label Engine):** Implement Octokit routines to swap managed labels, auto-create missing labels, and clear stale labels on `synchronize`.
- [ ] **Phase 4 (Packaging & Live Verification):** Bundle action code via `@vercel/ncc` (`dist/index.js` built) and verify against live pull requests.
- [ ] **Phase 5 (Marketplace Ready):** Finalize documentation, verify CI/test suite, and publish to GitHub Marketplace (`MIT` license and `action.yml` branding configured).

---

## ⚖️ Disclaimer

This is an independent community open-source project and is not affiliated with, sponsored by, or endorsed by CodeRabbit, Inc. or GitHub, Inc.
