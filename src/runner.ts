import * as core from '@actions/core';
import { getOctokit } from '@actions/github';
import { clearManagedLabels, getHttpStatus, OctokitClient, syncStatusLabels } from './labels.js';
import { getProvider } from './providers/index.js';
import { ActionInputs, ActionStatus, WebhookPayload } from './types.js';

export interface RunOutcome {
  status: ActionStatus;
  label: string;
  prNumber?: number;
}

interface ResolvedPullRequest {
  number: number;
  headSha?: string;
  isFork?: boolean;
}

function commitShasMatch(expectedSha: string, actualSha: string): boolean {
  const a = expectedSha.toLowerCase();
  const b = actualSha.toLowerCase();
  return a === b || a.startsWith(b) || b.startsWith(a);
}

async function resolvePullRequest(
  octokit: OctokitClient,
  owner: string,
  repo: string,
  eventName: string,
  payload: WebhookPayload,
): Promise<ResolvedPullRequest | undefined> {
  if (payload.pull_request?.number) {
    return {
      number: payload.pull_request.number,
      headSha: payload.pull_request.head?.sha,
      isFork: payload.pull_request.head?.repo?.fork,
    };
  }

  if (eventName === 'issue_comment' && payload.issue?.number && payload.issue.pull_request) {
    return {
      number: payload.issue.number,
    };
  }

  if (eventName === 'check_run' && payload.check_run) {
    const firstPr = payload.check_run.pull_requests?.find((pr) => typeof pr.number === 'number');
    if (firstPr?.number) {
      return {
        number: firstPr.number,
        headSha: firstPr.head?.sha,
      };
    }

    const headSha = payload.check_run.head_sha;
    if (headSha) {
      const { data: prs } = await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
        owner,
        repo,
        commit_sha: headSha,
      });
      const matchingPr = prs.find((pr) => pr.state === 'open') ?? prs[0];
      if (matchingPr) {
        return {
          number: matchingPr.number,
          headSha: matchingPr.head.sha,
          isFork: matchingPr.head.repo?.fork,
        };
      }
    }
  }

  return undefined;
}

export async function runAction(params: {
  eventName: string;
  payload: WebhookPayload;
  inputs: ActionInputs;
  octokit?: OctokitClient;
}): Promise<RunOutcome> {
  const { eventName, payload, inputs } = params;
  const owner = payload.repository?.owner?.login;
  const repo = payload.repository?.name;

  if (!owner || !repo) {
    throw new Error('Missing repository owner or name in webhook payload');
  }

  const octokit = params.octokit ?? getOctokit(inputs.githubToken);

  if (eventName === 'pull_request' || eventName === 'pull_request_target') {
    if (payload.action !== 'synchronize') {
      core.info(`Ignoring ${eventName} action "${payload.action ?? 'unknown'}"`);
      return { status: 'ignored', label: '' };
    }

    const pr = await resolvePullRequest(octokit, owner, repo, eventName, payload);
    if (!pr) {
      core.info(`Could not resolve pull request number for ${eventName} event`);
      return { status: 'ignored', label: '' };
    }

    try {
      const removed = await clearManagedLabels({
        octokit,
        owner,
        repo,
        issueNumber: pr.number,
        labels: inputs.labels,
      });
      core.info(
        removed.length > 0
          ? `Cleared stale AI review labels on PR #${pr.number}: ${removed.join(', ')}`
          : `No AI review labels to clear on PR #${pr.number}`,
      );
      return { status: 'cleared', label: '', prNumber: pr.number };
    } catch (error) {
      if (eventName === 'pull_request' && pr.isFork && getHttpStatus(error) === 403) {
        core.warning(
          `Skipping label cleanup on fork PR #${pr.number} because GITHUB_TOKEN lacks write permission on pull_request events.`,
        );
        return { status: 'ignored', label: '', prNumber: pr.number };
      }
      throw error;
    }
  }

  const provider = getProvider(inputs.provider);
  const evaluation = provider.evaluate(eventName, payload);

  if (evaluation.kind === 'ignored') {
    core.info(evaluation.reason);
    return { status: 'ignored', label: '' };
  }

  const pr = await resolvePullRequest(octokit, owner, repo, eventName, payload);
  if (!pr) {
    core.info(`No pull request associated with ${eventName} event; skipping`);
    return { status: 'ignored', label: '' };
  }

  let currentHeadSha = pr.headSha;
  if (evaluation.targetCommitSha && !currentHeadSha) {
    const { data: prData } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: pr.number,
    });
    currentHeadSha = prData.head.sha;
  }

  if (
    evaluation.targetCommitSha &&
    currentHeadSha &&
    !commitShasMatch(evaluation.targetCommitSha, currentHeadSha)
  ) {
    core.info(
      `Ignoring outdated ${eventName} result for commit ${evaluation.targetCommitSha} (PR #${pr.number} head is ${currentHeadSha})`,
    );
    return { status: 'ignored', label: '', prNumber: pr.number };
  }

  const appliedLabel = await syncStatusLabels({
    octokit,
    owner,
    repo,
    issueNumber: pr.number,
    targetStatus: evaluation.status,
    labels: inputs.labels,
    autoCreateLabels: inputs.autoCreateLabels,
  });

  core.info(`Applied label "${appliedLabel}" (${evaluation.status}) to PR #${pr.number}: ${evaluation.reason}`);

  return {
    status: evaluation.status,
    label: appliedLabel,
    prNumber: pr.number,
  };
}
