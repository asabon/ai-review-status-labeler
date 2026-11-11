import * as core from '@actions/core';
import * as github from '@actions/github';
import { runAction } from './runner.js';
import { ActionInputs, WebhookPayload } from './types.js';

function readInputs(): ActionInputs {
  return {
    githubToken: core.getInput('github-token', { required: true }),
    provider: core.getInput('provider') || 'coderabbit',
    labels: {
      skipped: core.getInput('label-skipped') || 'ai: skipped',
      'changes-requested': core.getInput('label-actionable') || 'ai: changes-requested',
      approved: core.getInput('label-approved') || 'ai: approved',
    },
    autoCreateLabels: core.getBooleanInput('auto-create-labels'),
  };
}

async function main(): Promise<void> {
  try {
    const inputs = readInputs();
    const outcome = await runAction({
      eventName: github.context.eventName,
      payload: github.context.payload as WebhookPayload,
      inputs,
    });

    core.setOutput('status', outcome.status);
    core.setOutput('label', outcome.label);
    core.setOutput('pr-number', outcome.prNumber ? String(outcome.prNumber) : '');
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}

void main();

