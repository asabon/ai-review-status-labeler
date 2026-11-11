import { describe, expect, it } from 'vitest';
import { CodeRabbitProvider, extractEmbeddedCommitSha } from '../src/providers/coderabbit.js';
import { getProvider } from '../src/providers/index.js';
import { WebhookPayload } from '../src/types.js';

const provider = new CodeRabbitProvider();

describe('getProvider', () => {
  it('returns the coderabbit provider case-insensitively', () => {
    expect(getProvider(' CodeRabbit ').name).toBe('coderabbit');
  });

  it('throws on unsupported providers', () => {
    expect(() => getProvider('unknown-bot')).toThrow(/Unsupported provider/);
  });
});

describe('extractEmbeddedCommitSha', () => {
  it('extracts change_assessment_commit SHA', () => {
    const body = '<!-- change_assessment_commit:"8dcbf52251ea218e311c7636c8e840bd5c9850f8" -->';
    expect(extractEmbeddedCommitSha(body)).toBe('8dcbf52251ea218e311c7636c8e840bd5c9850f8');
  });

  it('extracts coveredCommitId from final_review_risk_coverage', () => {
    const body =
      '<!-- final_review_risk_coverage:{"sourceCommitId":"1111111","coveredCommitId":"9e45cdb954a36108fa7cad1b249fa4c164db97d0","kind":"reviewed"} -->';
    expect(extractEmbeddedCommitSha(body)).toBe('9e45cdb954a36108fa7cad1b249fa4c164db97d0');
  });
});

describe('CodeRabbitProvider check_run events', () => {
  it('marks skipped check_run as skipped', () => {
    const payload: WebhookPayload = {
      action: 'completed',
      check_run: {
        conclusion: 'skipped',
        head_sha: '4fafbef322e2430596f86b14447c2669e01c6b9d',
        app: { slug: 'coderabbitai' },
        output: {
          title: 'Review skipped',
          summary: 'Result: Skipped - Review skipped',
        },
      },
    };

    expect(provider.evaluate('check_run', payload)).toEqual({
      kind: 'matched',
      status: 'skipped',
      reason: 'CodeRabbit check_run concluded with "skipped"',
      targetCommitSha: '4fafbef322e2430596f86b14447c2669e01c6b9d',
    });
  });

  it('marks non-success check_run conclusion (failure) as skipped', () => {
    const payload: WebhookPayload = {
      action: 'completed',
      check_run: {
        conclusion: 'failure',
        head_sha: 'abc1234',
        app: { slug: 'coderabbitai' },
      },
    };

    const result = provider.evaluate('check_run', payload);
    expect(result.kind).toBe('matched');
    if (result.kind === 'matched') {
      expect(result.status).toBe('skipped');
    }
  });

  it('ignores successful check_run so it never overwrites review findings', () => {
    const payload: WebhookPayload = {
      action: 'completed',
      check_run: {
        conclusion: 'success',
        head_sha: '8dcbf52251ea218e311c7636c8e840bd5c9850f8',
        app: { slug: 'coderabbitai' },
      },
    };

    expect(provider.evaluate('check_run', payload).kind).toBe('ignored');
  });

  it('ignores check_run from other GitHub Apps', () => {
    const payload: WebhookPayload = {
      action: 'completed',
      check_run: {
        conclusion: 'failure',
        head_sha: 'abc1234',
        app: { slug: 'github-actions' },
      },
    };

    expect(provider.evaluate('check_run', payload).kind).toBe('ignored');
  });
});

describe('CodeRabbitProvider pull_request_review events', () => {
  it('marks COMMENTED review with Actionable comments posted as changes-requested', () => {
    const payload: WebhookPayload = {
      action: 'submitted',
      review: {
        state: 'commented',
        commit_id: 'eaeedae5b6232e83ee531513c97bbdfd8d14b15c',
        user: { login: 'coderabbitai[bot]' },
        body: [
          '<!-- coderabbit-ai-generated:v1 -->',
          '',
          '**Actionable comments posted: 1**',
          '',
          '<details><summary>Prompt to fix</summary></details>',
        ].join('\n'),
      },
    };

    expect(provider.evaluate('pull_request_review', payload)).toEqual({
      kind: 'matched',
      status: 'changes-requested',
      reason: 'CodeRabbit pull_request_review reported actionable findings',
      targetCommitSha: 'eaeedae5b6232e83ee531513c97bbdfd8d14b15c',
    });
  });

  it('marks CHANGES_REQUESTED review as changes-requested', () => {
    const payload: WebhookPayload = {
      action: 'submitted',
      review: {
        state: 'changes_requested',
        commit_id: 'abc1234',
        user: { login: 'coderabbitai[bot]' },
        body: 'Please address the comments.',
      },
    };

    const result = provider.evaluate('pull_request_review', payload);
    expect(result.kind).toBe('matched');
    if (result.kind === 'matched') {
      expect(result.status).toBe('changes-requested');
    }
  });

  it('marks APPROVED review as approved', () => {
    const payload: WebhookPayload = {
      action: 'submitted',
      review: {
        state: 'approved',
        commit_id: 'abc1234',
        user: { login: 'coderabbitai[bot]' },
        body: 'Looks good to me.',
      },
    };

    const result = provider.evaluate('pull_request_review', payload);
    expect(result.kind).toBe('matched');
    if (result.kind === 'matched') {
      expect(result.status).toBe('approved');
    }
  });

  it('ignores reviews from human authors', () => {
    const payload: WebhookPayload = {
      action: 'submitted',
      review: {
        state: 'changes_requested',
        user: { login: 'octocat' },
        body: 'Fix typo',
      },
    };

    expect(provider.evaluate('pull_request_review', payload).kind).toBe('ignored');
  });
});

describe('CodeRabbitProvider issue_comment events', () => {
  it('marks summary comment with No actionable comments as approved and extracts commit SHA', () => {
    const payload: WebhookPayload = {
      action: 'edited',
      issue: { number: 30, pull_request: {} },
      comment: {
        user: { login: 'coderabbitai[bot]' },
        body: [
          '<!-- coderabbit-ai-generated:v1 -->',
          '<!-- This is an auto-generated comment: summarize by coderabbit.ai -->',
          '<!-- recent_review_status_start -->',
          '',
          'No actionable comments were generated in the recent review.',
          '',
          '<!-- recent_review_status_end -->',
          '<!-- change_assessment_commit:"8dcbf52251ea218e311c7636c8e840bd5c9850f8" -->',
        ].join('\n'),
      },
    };

    expect(provider.evaluate('issue_comment', payload)).toEqual({
      kind: 'matched',
      status: 'approved',
      reason: 'CodeRabbit recent review status reported no actionable comments',
      targetCommitSha: '8dcbf52251ea218e311c7636c8e840bd5c9850f8',
    });
  });

  it('marks summary comment with skip review marker as skipped when not yet reviewed', () => {
    const payload: WebhookPayload = {
      action: 'created',
      issue: { number: 25, pull_request: {} },
      comment: {
        user: { login: 'coderabbitai[bot]' },
        body: [
          '<!-- coderabbit-ai-generated:v1 -->',
          '<!-- This is an auto-generated comment: summarize by coderabbit.ai -->',
          '<!-- This is an auto-generated comment: skip review by coderabbit.ai -->',
          '> This repository does not receive automatic reviews because it has fewer than 10 stars.',
          '<!-- end of auto-generated comment: skip review by coderabbit.ai -->',
        ].join('\n'),
      },
    };

    const result = provider.evaluate('issue_comment', payload);
    expect(result.kind).toBe('matched');
    if (result.kind === 'matched') {
      expect(result.status).toBe('skipped');
    }
  });

  it('ignores stale skip-review banner when summary comment already contains kind="reviewed"', () => {
    const payload: WebhookPayload = {
      action: 'edited',
      issue: { number: 21, pull_request: {} },
      comment: {
        user: { login: 'coderabbitai[bot]' },
        body: [
          '<!-- coderabbit-ai-generated:v1 -->',
          '<!-- This is an auto-generated comment: summarize by coderabbit.ai -->',
          '<!-- This is an auto-generated comment: skip review by coderabbit.ai -->',
          '> This repository does not receive automatic reviews because it has fewer than 10 stars.',
          '<!-- end of auto-generated comment: skip review by coderabbit.ai -->',
          '<!-- final_review_risk_coverage:{"sourceCommitId":"9e45cdb954a36108fa7cad1b249fa4c164db97d0","coveredCommitId":"9e45cdb954a36108fa7cad1b249fa4c164db97d0","kind":"reviewed"} -->',
        ].join('\n'),
      },
    };

    expect(provider.evaluate('issue_comment', payload).kind).toBe('ignored');
  });

  it('marks "Review rate limited." reply as skipped', () => {
    const payload: WebhookPayload = {
      action: 'created',
      issue: { number: 21, pull_request: {} },
      comment: {
        user: { login: 'coderabbitai[bot]' },
        body: [
          '<!-- This is an auto-generated reply by CodeRabbit -->',
          '<details><summary>⚠️ Action not completed</summary>',
          'Review rate limited.',
          '</details>',
        ].join('\n'),
      },
    };

    const result = provider.evaluate('issue_comment', payload);
    expect(result.kind).toBe('matched');
    if (result.kind === 'matched') {
      expect(result.status).toBe('skipped');
    }
  });

  it('does NOT misclassify "Reviews are available now." with rate-limits link as skipped', () => {
    const payload: WebhookPayload = {
      action: 'created',
      issue: { number: 30, pull_request: {} },
      comment: {
        user: { login: 'coderabbitai[bot]' },
        body: [
          '<!-- coderabbit-ai-generated:v1 -->',
          '<!-- This is an auto-generated reply by CodeRabbit -->',
          'Your [plan](https://docs.coderabbit.ai/management/plans) includes PR reviews subject to [rate limits](https://docs.coderabbit.ai/management/plans#rate-limits). Reviews are available now.',
        ].join('\n'),
      },
    };

    expect(provider.evaluate('issue_comment', payload).kind).toBe('ignored');
  });

  it('ignores plain command acknowledgements like "Review finished."', () => {
    const payload: WebhookPayload = {
      action: 'created',
      issue: { number: 30, pull_request: {} },
      comment: {
        user: { login: 'coderabbitai[bot]' },
        body: '<!-- This is an auto-generated reply by CodeRabbit -->\nReview finished.',
      },
    };

    expect(provider.evaluate('issue_comment', payload).kind).toBe('ignored');
  });

  it('ignores comments on regular issues (not PRs)', () => {
    const payload: WebhookPayload = {
      action: 'created',
      issue: { number: 5 },
      comment: {
        user: { login: 'coderabbitai[bot]' },
        body: 'Review rate limited.',
      },
    };

    expect(provider.evaluate('issue_comment', payload).kind).toBe('ignored');
  });
});

