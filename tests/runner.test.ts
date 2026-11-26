import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as core from '@actions/core';
import { OctokitClient } from '../src/labels.js';
import { runAction } from '../src/runner.js';
import { ActionInputs, WebhookPayload } from '../src/types.js';

vi.mock('@actions/core', () => ({
  info: vi.fn(),
  warning: vi.fn(),
  setOutput: vi.fn(),
  setFailed: vi.fn(),
  getInput: vi.fn(),
  getBooleanInput: vi.fn(),
}));

function makeInputs(overrides?: Partial<ActionInputs>): ActionInputs {
  return {
    githubToken: 'test-token',
    provider: 'coderabbit',
    labels: {
      'not-reviewed': 'ai: not-reviewed',
      skipped: 'ai: skipped',
      'changes-requested': 'ai: changes-requested',
      approved: 'ai: approved',
    },
    autoCreateLabels: true,
    ...overrides,
  };
}

interface MockReview {
  user?: { login?: string } | null;
  state?: string | null;
  body?: string | null;
  commit_id?: string | null;
  submitted_at?: string | null;
}

interface MockOctokitOptions {
  existingRepoLabels?: string[];
  prLabels?: string[];
  prHeadSha?: string;
  associatedPrs?: Array<{ number: number; state: string; head: { sha: string; repo?: { fork?: boolean } } }>;
  reviews?: MockReview[];
  removeLabelError?: unknown;
  createLabelError?: unknown;
}

function createMockOctokit(options: MockOctokitOptions = {}) {
  const existingRepoLabels = new Set(options.existingRepoLabels ?? []);
  let prLabels = [...(options.prLabels ?? [])];

  const rest = {
    issues: {
      getLabel: vi.fn(async ({ name }: { name: string }) => {
        if (!existingRepoLabels.has(name)) {
          throw Object.assign(new Error('Not Found'), { status: 404 });
        }
        return { data: { name } };
      }),
      createLabel: vi.fn(async ({ name }: { name: string }) => {
        if (options.createLabelError) {
          throw options.createLabelError;
        }
        existingRepoLabels.add(name);
        return { data: { name } };
      }),
      listLabelsOnIssue: vi.fn(async () => ({
        data: prLabels.map((name) => ({ name })),
      })),
      removeLabel: vi.fn(async ({ name }: { name: string }) => {
        if (options.removeLabelError) {
          throw options.removeLabelError;
        }
        prLabels = prLabels.filter((l) => l !== name);
        return { data: {} };
      }),
      addLabels: vi.fn(async ({ labels }: { labels: string[] }) => {
        for (const label of labels) {
          if (!prLabels.includes(label)) {
            prLabels.push(label);
          }
        }
        return { data: prLabels.map((name) => ({ name })) };
      }),
    },
    pulls: {
      get: vi.fn(async ({ pull_number }: { pull_number: number }) => ({
        data: {
          number: pull_number,
          head: { sha: options.prHeadSha ?? 'head-sha-1' },
          labels: prLabels.map((name) => ({ name })),
        },
      })),
      listReviews: vi.fn(async () => ({
        data: options.reviews ?? [],
      })),
    },
    repos: {
      listPullRequestsAssociatedWithCommit: vi.fn(async () => ({
        data: options.associatedPrs ?? [],
      })),
    },
  };

  return {
    octokit: { rest } as unknown as OctokitClient,
    rest,
    getPrLabels: () => prLabels,
  };
}

describe('runAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('swaps stale managed labels for the new label while preserving unrelated labels', async () => {
    const mock = createMockOctokit({
      existingRepoLabels: ['ai: approved'],
      prLabels: ['bug', 'ai: changes-requested', 'ai: skipped'],
      prHeadSha: '8dcbf52251ea218e311c7636c8e840bd5c9850f8',
    });

    const payload: WebhookPayload = {
      action: 'edited',
      repository: { owner: { login: 'asabon' }, name: 'test-repo' },
      issue: { number: 30, pull_request: {} },
      comment: {
        user: { login: 'coderabbitai[bot]' },
        body: [
          '<!-- recent_review_status_start -->',
          'No actionable comments were generated in the recent review.',
          '<!-- recent_review_status_end -->',
          '<!-- change_assessment_commit:"8dcbf52251ea218e311c7636c8e840bd5c9850f8" -->',
        ].join('\n'),
      },
    };

    const outcome = await runAction({
      eventName: 'issue_comment',
      payload,
      inputs: makeInputs(),
      octokit: mock.octokit,
    });

    expect(outcome).toEqual({
      status: 'approved',
      label: 'ai: approved',
      prNumber: 30,
    });
    expect(mock.getPrLabels()).toEqual(['bug', 'ai: approved']);
    expect(mock.rest.issues.createLabel).not.toHaveBeenCalled();
  });

  it('auto-creates missing label with default color and description', async () => {
    const mock = createMockOctokit({
      existingRepoLabels: [],
      prLabels: [],
    });

    const payload: WebhookPayload = {
      action: 'submitted',
      repository: { owner: { login: 'asabon' }, name: 'test-repo' },
      pull_request: {
        number: 21,
        head: { sha: 'eaeedae5b6232e83ee531513c97bbdfd8d14b15c' },
      },
      review: {
        state: 'commented',
        commit_id: 'eaeedae5b6232e83ee531513c97bbdfd8d14b15c',
        user: { login: 'coderabbitai[bot]' },
        body: '**Actionable comments posted: 1**',
      },
    };

    const outcome = await runAction({
      eventName: 'pull_request_review',
      payload,
      inputs: makeInputs(),
      octokit: mock.octokit,
    });

    expect(outcome.status).toBe('changes-requested');
    expect(mock.rest.issues.createLabel).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'ai: changes-requested',
        color: 'd93f0b',
      }),
    );
    expect(mock.getPrLabels()).toEqual(['ai: changes-requested']);
  });

  it('handles 422 race condition when another workflow creates the label first', async () => {
    const mock = createMockOctokit({
      existingRepoLabels: [],
      createLabelError: Object.assign(new Error('Validation Failed'), { status: 422 }),
    });

    const payload: WebhookPayload = {
      action: 'completed',
      repository: { owner: { login: 'asabon' }, name: 'test-repo' },
      check_run: {
        conclusion: 'skipped',
        head_sha: 'sha-1',
        app: { slug: 'coderabbitai' },
        pull_requests: [{ number: 25, head: { sha: 'sha-1' } }],
      },
    };

    const outcome = await runAction({
      eventName: 'check_run',
      payload,
      inputs: makeInputs(),
      octokit: mock.octokit,
    });

    expect(outcome).toEqual({ status: 'not-reviewed', label: 'ai: not-reviewed', prNumber: 25 });
    expect(mock.getPrLabels()).toEqual(['ai: not-reviewed']);
  });

  it('resolves PR via commit lookup when check_run.pull_requests is empty', async () => {
    const mock = createMockOctokit({
      existingRepoLabels: ['ai: not-reviewed'],
      associatedPrs: [
        { number: 42, state: 'open', head: { sha: 'sha-42' } },
      ],
    });

    const payload: WebhookPayload = {
      action: 'completed',
      repository: { owner: { login: 'asabon' }, name: 'test-repo' },
      check_run: {
        conclusion: 'skipped',
        head_sha: 'sha-42',
        app: { slug: 'coderabbitai' },
        pull_requests: [],
      },
    };

    const outcome = await runAction({
      eventName: 'check_run',
      payload,
      inputs: makeInputs(),
      octokit: mock.octokit,
    });

    expect(outcome).toEqual({ status: 'not-reviewed', label: 'ai: not-reviewed', prNumber: 42 });
    expect(mock.rest.repos.listPullRequestsAssociatedWithCommit).toHaveBeenCalledWith({
      owner: 'asabon',
      repo: 'test-repo',
      commit_sha: 'sha-42',
    });
  });

  it('ignores review results for an outdated commit SHA', async () => {
    const mock = createMockOctokit({
      existingRepoLabels: ['ai: approved'],
      prLabels: ['ai: changes-requested'],
      prHeadSha: '2222222222222222222222222222222222222222',
    });

    const payload: WebhookPayload = {
      action: 'edited',
      repository: { owner: { login: 'asabon' }, name: 'test-repo' },
      issue: { number: 30, pull_request: {} },
      comment: {
        user: { login: 'coderabbitai[bot]' },
        body: [
          '<!-- recent_review_status_start -->',
          'No actionable comments were generated in the recent review.',
          '<!-- recent_review_status_end -->',
          '<!-- change_assessment_commit:"1111111111111111111111111111111111111111" -->',
        ].join('\n'),
      },
    };

    const outcome = await runAction({
      eventName: 'issue_comment',
      payload,
      inputs: makeInputs(),
      octokit: mock.octokit,
    });

    expect(outcome).toEqual({ status: 'ignored', label: '', prNumber: 30 });
    expect(mock.getPrLabels()).toEqual(['ai: changes-requested']);
  });

  it('transitions existing managed labels to not-reviewed on pull_request synchronize', async () => {
    const mock = createMockOctokit({
      existingRepoLabels: ['ai: not-reviewed'],
      prLabels: ['enhancement', 'ai: approved'],
    });

    const payload: WebhookPayload = {
      action: 'synchronize',
      repository: { owner: { login: 'asabon' }, name: 'test-repo' },
      pull_request: {
        number: 10,
        head: { sha: 'new-sha', repo: { fork: false } },
      },
    };

    const outcome = await runAction({
      eventName: 'pull_request',
      payload,
      inputs: makeInputs(),
      octokit: mock.octokit,
    });

    expect(outcome).toEqual({
      status: 'not-reviewed',
      label: 'ai: not-reviewed',
      prNumber: 10,
    });
    expect(mock.getPrLabels()).toEqual(['enhancement', 'ai: not-reviewed']);
  });

  it('ignores pull_request synchronize when PR has no managed AI labels', async () => {
    const mock = createMockOctokit({
      prLabels: ['enhancement'],
    });

    const payload: WebhookPayload = {
      action: 'synchronize',
      repository: { owner: { login: 'asabon' }, name: 'test-repo' },
      pull_request: {
        number: 13,
        head: { sha: 'new-sha', repo: { fork: false } },
      },
    };

    const outcome = await runAction({
      eventName: 'pull_request',
      payload,
      inputs: makeInputs(),
      octokit: mock.octokit,
    });

    expect(outcome).toEqual({ status: 'ignored', label: '', prNumber: 13 });
    expect(mock.getPrLabels()).toEqual(['enhancement']);
    expect(mock.rest.issues.addLabels).not.toHaveBeenCalled();
  });

  it('keeps not-reviewed without redundant label writes on repeated synchronize', async () => {
    const mock = createMockOctokit({
      existingRepoLabels: ['ai: not-reviewed'],
      prLabels: ['ai: not-reviewed', 'bug'],
    });

    const payload: WebhookPayload = {
      action: 'synchronize',
      repository: { owner: { login: 'asabon' }, name: 'test-repo' },
      pull_request: {
        number: 14,
        head: { sha: 'new-sha', repo: { fork: false } },
      },
    };

    const outcome = await runAction({
      eventName: 'pull_request',
      payload,
      inputs: makeInputs(),
      octokit: mock.octokit,
    });

    expect(outcome).toEqual({
      status: 'not-reviewed',
      label: 'ai: not-reviewed',
      prNumber: 14,
    });
    expect(mock.getPrLabels()).toEqual(['ai: not-reviewed', 'bug']);
    expect(mock.rest.issues.removeLabel).not.toHaveBeenCalled();
    expect(mock.rest.issues.addLabels).not.toHaveBeenCalled();
  });

  it('preserves existing managed label if addLabels fails and completes transition on rerun', async () => {
    const mock = createMockOctokit({
      existingRepoLabels: ['ai: not-reviewed'],
      prLabels: ['ai: approved', 'bug'],
    });
    mock.rest.issues.addLabels.mockRejectedValueOnce(new Error('Transient API error'));

    const payload: WebhookPayload = {
      action: 'synchronize',
      repository: { owner: { login: 'asabon' }, name: 'test-repo' },
      pull_request: {
        number: 15,
        head: { sha: 'new-sha', repo: { fork: false } },
      },
    };

    await expect(
      runAction({
        eventName: 'pull_request',
        payload,
        inputs: makeInputs(),
        octokit: mock.octokit,
      }),
    ).rejects.toThrow('Transient API error');

    expect(mock.getPrLabels()).toEqual(['ai: approved', 'bug']);
    expect(mock.rest.issues.removeLabel).not.toHaveBeenCalled();

    const retryOutcome = await runAction({
      eventName: 'pull_request',
      payload,
      inputs: makeInputs(),
      octokit: mock.octokit,
    });

    expect(retryOutcome).toEqual({
      status: 'not-reviewed',
      label: 'ai: not-reviewed',
      prNumber: 15,
    });
    expect(mock.getPrLabels()).toEqual(['bug', 'ai: not-reviewed']);
  });

  it('warns and ignores 403 on fork PR pull_request synchronize', async () => {
    const mock = createMockOctokit({
      existingRepoLabels: ['ai: not-reviewed'],
      prLabels: ['ai: approved'],
      removeLabelError: Object.assign(new Error('Resource not accessible by integration'), {
        status: 403,
      }),
    });

    const payload: WebhookPayload = {
      action: 'synchronize',
      repository: { owner: { login: 'asabon' }, name: 'test-repo' },
      pull_request: {
        number: 11,
        head: { sha: 'fork-sha', repo: { fork: true } },
      },
    };

    const outcome = await runAction({
      eventName: 'pull_request',
      payload,
      inputs: makeInputs(),
      octokit: mock.octokit,
    });

    expect(outcome).toEqual({ status: 'ignored', label: '', prNumber: 11 });
    expect(core.warning).toHaveBeenCalledTimes(1);
  });

  it('transitions managed labels to not-reviewed on pull_request_target synchronize even for fork PRs', async () => {
    const mock = createMockOctokit({
      existingRepoLabels: ['ai: not-reviewed'],
      prLabels: ['ai: changes-requested', 'bug'],
    });

    const payload: WebhookPayload = {
      action: 'synchronize',
      repository: { owner: { login: 'asabon' }, name: 'test-repo' },
      pull_request: {
        number: 12,
        head: { sha: 'fork-sha', repo: { fork: true } },
      },
    };

    const outcome = await runAction({
      eventName: 'pull_request_target',
      payload,
      inputs: makeInputs(),
      octokit: mock.octokit,
    });

    expect(outcome).toEqual({
      status: 'not-reviewed',
      label: 'ai: not-reviewed',
      prNumber: 12,
    });
    expect(mock.getPrLabels()).toEqual(['bug', 'ai: not-reviewed']);
  });

  it('falls back to pulls.listReviews on check_run success when pull_request_review did not trigger', async () => {
    const headSha = 'b68d5f7bb13d934290c27d28977fa61bb0181292';
    const mock = createMockOctokit({
      existingRepoLabels: ['ai: skipped', 'ai: changes-requested'],
      prLabels: ['ai: skipped'],
      prHeadSha: headSha,
      reviews: [
        {
          user: { login: 'coderabbitai[bot]' },
          state: 'COMMENTED',
          commit_id: 'old-commit-sha',
          submitted_at: '2026-11-16T21:00:00Z',
          body: 'No actionable comments were generated in the recent review.',
        },
        {
          user: { login: 'coderabbitai[bot]' },
          state: 'COMMENTED',
          commit_id: headSha,
          submitted_at: '2026-11-16T22:35:25Z',
          body: '<!-- coderabbit-ai-generated:v1 -->\n\n**Actionable comments posted: 9**',
        },
      ],
    });

    const payload: WebhookPayload = {
      action: 'completed',
      repository: { owner: { login: 'asabon' }, name: 'vajra' },
      check_run: {
        conclusion: 'success',
        head_sha: headSha,
        app: { slug: 'coderabbitai' },
        pull_requests: [{ number: 6, head: { sha: headSha } }],
      },
    };

    const outcome = await runAction({
      eventName: 'check_run',
      payload,
      inputs: makeInputs(),
      octokit: mock.octokit,
    });

    expect(outcome).toEqual({
      status: 'changes-requested',
      label: 'ai: changes-requested',
      prNumber: 6,
    });
    expect(mock.getPrLabels()).toEqual(['ai: changes-requested']);
    expect(mock.rest.pulls.listReviews).toHaveBeenCalledTimes(1);
  });

  it('falls back to pulls.listReviews on reviewed summary issue_comment without inline verdict', async () => {
    const headSha = 'b68d5f7bb13d934290c27d28977fa61bb0181292';
    const mock = createMockOctokit({
      existingRepoLabels: ['ai: skipped', 'ai: approved'],
      prLabels: ['ai: skipped'],
      prHeadSha: headSha,
      reviews: [
        {
          user: { login: 'coderabbitai[bot]' },
          state: 'COMMENTED',
          commit_id: headSha,
          submitted_at: '2026-11-16T22:35:25Z',
          body: 'No actionable comments were generated in the recent review.',
        },
      ],
    });

    const payload: WebhookPayload = {
      action: 'edited',
      repository: { owner: { login: 'asabon' }, name: 'vajra' },
      issue: { number: 6, pull_request: {} },
      comment: {
        user: { login: 'coderabbitai[bot]' },
        body: [
          '<!-- coderabbit-ai-generated:v1 -->',
          `<!-- final_review_risk_coverage:{"sourceCommitId":"${headSha}","coveredCommitId":"${headSha}","kind":"reviewed"} -->`,
        ].join('\n'),
      },
    };

    const outcome = await runAction({
      eventName: 'issue_comment',
      payload,
      inputs: makeInputs(),
      octokit: mock.octokit,
    });

    expect(outcome).toEqual({
      status: 'approved',
      label: 'ai: approved',
      prNumber: 6,
    });
    expect(mock.getPrLabels()).toEqual(['ai: approved']);
  });

  it('keeps check_run success ignored when no matching review exists for head commit', async () => {
    const headSha = 'current-head-sha';
    const mock = createMockOctokit({
      prLabels: ['ai: skipped'],
      prHeadSha: headSha,
      reviews: [
        {
          user: { login: 'coderabbitai[bot]' },
          state: 'COMMENTED',
          commit_id: 'different-old-sha',
          submitted_at: '2026-11-16T20:00:00Z',
          body: '**Actionable comments posted: 3**',
        },
      ],
    });

    const payload: WebhookPayload = {
      action: 'completed',
      repository: { owner: { login: 'asabon' }, name: 'vajra' },
      check_run: {
        conclusion: 'success',
        head_sha: headSha,
        app: { slug: 'coderabbitai' },
        pull_requests: [{ number: 6, head: { sha: headSha } }],
      },
    };

    const outcome = await runAction({
      eventName: 'check_run',
      payload,
      inputs: makeInputs(),
      octokit: mock.octokit,
    });

    expect(outcome).toEqual({ status: 'ignored', label: '', prNumber: 6 });
    expect(mock.getPrLabels()).toEqual(['ai: skipped']);
  });

  it('ignores outdated check_run success without querying pulls.listReviews', async () => {
    const mock = createMockOctokit({
      prLabels: ['ai: skipped'],
      prHeadSha: 'newer-head-sha',
    });

    const payload: WebhookPayload = {
      action: 'completed',
      repository: { owner: { login: 'asabon' }, name: 'vajra' },
      check_run: {
        conclusion: 'success',
        head_sha: 'older-head-sha',
        app: { slug: 'coderabbitai' },
        pull_requests: [{ number: 6, head: { sha: 'newer-head-sha' } }],
      },
    };

    const outcome = await runAction({
      eventName: 'check_run',
      payload,
      inputs: makeInputs(),
      octokit: mock.octokit,
    });

    expect(outcome).toEqual({ status: 'ignored', label: '', prNumber: 6 });
    expect(mock.rest.pulls.listReviews).not.toHaveBeenCalled();
  });

  it('uses live PR head instead of stale check_run.pull_requests snapshot on fallback', async () => {
    const mock = createMockOctokit({
      prLabels: ['ai: skipped'],
      prHeadSha: 'newer-live-head-sha',
      reviews: [
        {
          user: { login: 'coderabbitai[bot]' },
          state: 'COMMENTED',
          commit_id: 'older-snapshot-sha',
          submitted_at: '2026-11-16T22:35:25Z',
          body: 'No actionable comments were generated in the recent review.',
        },
      ],
    });

    const payload: WebhookPayload = {
      action: 'completed',
      repository: { owner: { login: 'asabon' }, name: 'vajra' },
      check_run: {
        conclusion: 'success',
        head_sha: 'older-snapshot-sha',
        app: { slug: 'coderabbitai' },
        pull_requests: [{ number: 6, head: { sha: 'older-snapshot-sha' } }],
      },
    };

    const outcome = await runAction({
      eventName: 'check_run',
      payload,
      inputs: makeInputs(),
      octokit: mock.octokit,
    });

    expect(outcome).toEqual({ status: 'ignored', label: '', prNumber: 6 });
    expect(mock.rest.pulls.get).toHaveBeenCalledTimes(1);
    expect(mock.rest.pulls.listReviews).not.toHaveBeenCalled();
    expect(mock.getPrLabels()).toEqual(['ai: skipped']);
  });

  it('ignores fallback review if live PR head advances during listReviews', async () => {
    const mock = createMockOctokit({
      existingRepoLabels: ['ai: approved'],
      prLabels: [],
      prHeadSha: 'head-sha-a',
      reviews: [
        {
          user: { login: 'coderabbitai[bot]' },
          state: 'COMMENTED',
          commit_id: 'head-sha-a',
          submitted_at: '2026-11-16T22:35:25Z',
          body: 'No actionable comments were generated in the recent review.',
        },
      ],
    });

    mock.rest.pulls.get
      .mockResolvedValueOnce({
        data: {
          number: 6,
          head: { sha: 'head-sha-a' },
          labels: [],
        },
      })
      .mockResolvedValueOnce({
        data: {
          number: 6,
          head: { sha: 'head-sha-b' },
          labels: [],
        },
      });

    const payload: WebhookPayload = {
      action: 'completed',
      repository: { owner: { login: 'asabon' }, name: 'vajra' },
      check_run: {
        conclusion: 'success',
        head_sha: 'head-sha-a',
        app: { slug: 'coderabbitai' },
        pull_requests: [{ number: 6, head: { sha: 'head-sha-a' } }],
      },
    };

    const outcome = await runAction({
      eventName: 'check_run',
      payload,
      inputs: makeInputs(),
      octokit: mock.octokit,
    });

    expect(outcome).toEqual({ status: 'ignored', label: '', prNumber: 6 });
    expect(mock.rest.pulls.get).toHaveBeenCalledTimes(2);
    expect(mock.getPrLabels()).toEqual([]);
  });
});
