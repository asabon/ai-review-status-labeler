export type ReviewStatus = 'skipped' | 'changes-requested' | 'approved';

export type ActionStatus = ReviewStatus | 'cleared' | 'ignored';

export type LabelMap = Record<ReviewStatus, string>;

export interface LabelDefinition {
  name: string;
  color: string;
  description: string;
}

export interface ActionInputs {
  githubToken: string;
  provider: string;
  labels: LabelMap;
  autoCreateLabels: boolean;
}

export type EvaluationResult =
  | {
      kind: 'matched';
      status: ReviewStatus;
      reason: string;
      targetCommitSha?: string;
    }
  | {
      kind: 'ignored';
      reason: string;
    };

export interface WebhookUser {
  login?: string;
}

export interface WebhookLabel {
  name?: string;
}

export interface WebhookRepo {
  fork?: boolean;
}

export interface WebhookPullRequestRef {
  number?: number;
  head?: {
    sha?: string;
    repo?: WebhookRepo | null;
  };
  labels?: WebhookLabel[];
}

export interface WebhookPayload {
  action?: string;
  repository?: {
    owner?: {
      login?: string;
    };
    name?: string;
  };
  pull_request?: WebhookPullRequestRef;
  issue?: {
    number?: number;
    pull_request?: unknown;
    labels?: WebhookLabel[];
  };
  comment?: {
    body?: string | null;
    user?: WebhookUser | null;
  };
  review?: {
    state?: string | null;
    body?: string | null;
    commit_id?: string | null;
    user?: WebhookUser | null;
  };
  check_run?: {
    conclusion?: string | null;
    head_sha?: string;
    app?: {
      slug?: string | null;
    } | null;
    output?: {
      title?: string | null;
      summary?: string | null;
      text?: string | null;
    } | null;
    pull_requests?: Array<{
      number?: number;
      head?: {
        sha?: string;
      };
    }>;
  };
}

export interface ProviderAdapter {
  readonly name: string;
  evaluate(eventName: string, payload: WebhookPayload): EvaluationResult;
}

