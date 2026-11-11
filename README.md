# AI Review Status Labeler (`ai-review-status-labeler`)

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
  - Support `check_run` (`completed`) events from AI review apps.
  - Support `issue_comment` (`created`) events from AI reviewer bots (e.g., `coderabbitai[bot]`).
- **Resilient Matching:**
  - Avoid fragile string matching. Provide flexible regex-based criteria for matching rate limits, actionable comments, and passes.
  - All matching patterns and label names must be customizable via action inputs (`with:`).
- **Label Management:**
  - Remove existing managed labels before applying the newly resolved label.
  - Optionally auto-create labels in the repository if they do not yet exist (with configurable color and description).
- **Extensible Architecture:**
  - Initially targeted for CodeRabbit, but structured so that adapters/parsers for other AI review bots (GitHub Copilot PR Review, Qodo Merge, etc.) can be plugged in.

### 2. Technical Stack & Implementation Guidelines
- **Type:** JavaScript / TypeScript Action (`node20`) compiled via `@vercel/ncc`, or a clean Composite Action wrapping `actions/github-script`.
- **Dependencies:** `@actions/core`, `@actions/github`.
- **Permissions Required:**
  - `pull-requests: write`
  - `issues: write`
  - `checks: read`

---

## ⚙️ Proposed Action Interface (`action.yml` Draft)

```yaml
inputs:
  github-token:
    description: 'GitHub token for Octokit API operations'
    required: true
    default: ${{ github.token }}
  provider:
    description: 'AI Review tool provider (default: coderabbit)'
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
```

---

## 🚀 Example Workflow Integration

```yaml
name: AI Review Status Sync

on:
  issue_comment:
    types: [created]
  check_run:
    types: [completed]

permissions:
  pull-requests: write
  issues: write
  contents: read
  checks: read

jobs:
  label-sync:
    # Restrict execution to relevant AI review events
    if: >
      (github.event_name == 'issue_comment' && github.event.issue.pull_request && github.event.comment.user.login == 'coderabbitai[bot]') ||
      (github.event_name == 'check_run' && github.event.check_run.app.slug == 'coderabbitai')
    runs-on: ubuntu-latest
    steps:
      - name: Sync AI Review Status
        uses: ./ # When building locally, or your-user/ai-review-status-labeler@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          provider: 'coderabbit'
          label-skipped: 'レビュー未実施'
          label-actionable: '指摘あり'
          label-approved: 'レビューOK'
```

---

## 🛠️ Development Milestones

- [ ] **Phase 1 (Mock & Test):** Collect sample event payloads (`check_run` and `issue_comment`) for CodeRabbit (rate limit skip, review with issues, clean review).
- [ ] **Phase 2 (Parser Engine):** Implement parser functions that inspect payload body/output text against regex patterns.
- [ ] **Phase 3 (Label Engine):** Implement Octokit routines to atomically swap labels and auto-create missing labels.
- [ ] **Phase 4 (Packaging):** Bundle action code via `@vercel/ncc` and test against real multi-repo pull requests.
- [ ] **Phase 5 (Marketplace Ready):** Add test suite, documentation, and metadata for GitHub Marketplace release.

---

## ⚖️ Disclaimer

This is an independent community open-source project and is not affiliated with, sponsored by, or endorsed by CodeRabbit, Inc. or GitHub, Inc.
