import { getOctokit } from '@actions/github';
import { LabelDefinition, LabelMap, ReviewStatus } from './types.js';

export type OctokitClient = ReturnType<typeof getOctokit>;

const DEFAULT_LABEL_STYLES: Record<ReviewStatus, { color: string; description: string }> = {
  skipped: {
    color: 'fbca04',
    description: 'AI code review was skipped or throttled due to rate limits',
  },
  'changes-requested': {
    color: 'd93f0b',
    description: 'AI code review posted actionable comments',
  },
  approved: {
    color: '0e8a16',
    description: 'AI code review completed with no actionable comments',
  },
};

export function getHttpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const maybeStatus = (error as { status?: unknown }).status;
  return typeof maybeStatus === 'number' ? maybeStatus : undefined;
}

export function buildLabelDefinitions(labels: LabelMap): Record<ReviewStatus, LabelDefinition> {
  return {
    skipped: {
      name: labels.skipped,
      ...DEFAULT_LABEL_STYLES.skipped,
    },
    'changes-requested': {
      name: labels['changes-requested'],
      ...DEFAULT_LABEL_STYLES['changes-requested'],
    },
    approved: {
      name: labels.approved,
      ...DEFAULT_LABEL_STYLES.approved,
    },
  };
}

/**
 * Create the label only if it does not exist yet so any user-customized
 * color or description on existing labels is preserved.
 */
async function ensureLabelExists(
  octokit: OctokitClient,
  owner: string,
  repo: string,
  definition: LabelDefinition,
): Promise<void> {
  try {
    await octokit.rest.issues.getLabel({
      owner,
      repo,
      name: definition.name,
    });
    return;
  } catch (error) {
    if (getHttpStatus(error) !== 404) {
      throw error;
    }
  }

  try {
    await octokit.rest.issues.createLabel({
      owner,
      repo,
      name: definition.name,
      color: definition.color,
      description: definition.description,
    });
  } catch (error) {
    // Another concurrent workflow run may have created the label first.
    if (getHttpStatus(error) !== 422) {
      throw error;
    }
  }
}

async function removeLabelIfPresent(
  octokit: OctokitClient,
  owner: string,
  repo: string,
  issueNumber: number,
  labelName: string,
): Promise<void> {
  try {
    await octokit.rest.issues.removeLabel({
      owner,
      repo,
      issue_number: issueNumber,
      name: labelName,
    });
  } catch (error) {
    if (getHttpStatus(error) !== 404) {
      throw error;
    }
  }
}

async function getCurrentLabelNames(
  octokit: OctokitClient,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<Set<string>> {
  const { data } = await octokit.rest.issues.listLabelsOnIssue({
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
  });
  return new Set(data.map((label) => label.name));
}

export async function syncStatusLabels(params: {
  octokit: OctokitClient;
  owner: string;
  repo: string;
  issueNumber: number;
  targetStatus: ReviewStatus;
  labels: LabelMap;
  autoCreateLabels: boolean;
}): Promise<string> {
  const {
    octokit,
    owner,
    repo,
    issueNumber,
    targetStatus,
    labels,
    autoCreateLabels,
  } = params;

  const definitions = buildLabelDefinitions(labels);
  const targetDef = definitions[targetStatus];

  if (autoCreateLabels) {
    await ensureLabelExists(octokit, owner, repo, targetDef);
  }

  // Always fetch live labels instead of trusting the event payload snapshot,
  // which can be stale when review/comment events fire close together.
  const currentLabels = await getCurrentLabelNames(octokit, owner, repo, issueNumber);

  const managedNames = Array.from(new Set(Object.values(labels)));
  const labelsToRemove = managedNames.filter(
    (name) => name !== targetDef.name && currentLabels.has(name),
  );

  for (const labelName of labelsToRemove) {
    await removeLabelIfPresent(octokit, owner, repo, issueNumber, labelName);
  }

  if (!currentLabels.has(targetDef.name)) {
    await octokit.rest.issues.addLabels({
      owner,
      repo,
      issue_number: issueNumber,
      labels: [targetDef.name],
    });
  }

  return targetDef.name;
}

export async function clearManagedLabels(params: {
  octokit: OctokitClient;
  owner: string;
  repo: string;
  issueNumber: number;
  labels: LabelMap;
}): Promise<string[]> {
  const { octokit, owner, repo, issueNumber, labels } = params;
  const currentLabels = await getCurrentLabelNames(octokit, owner, repo, issueNumber);

  const managedNames = Array.from(new Set(Object.values(labels)));
  const removed: string[] = [];

  for (const labelName of managedNames) {
    if (currentLabels.has(labelName)) {
      await removeLabelIfPresent(octokit, owner, repo, issueNumber, labelName);
      removed.push(labelName);
    }
  }

  return removed;
}
