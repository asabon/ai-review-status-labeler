import {
  EvaluationResult,
  ProviderAdapter,
  ProviderFallbackCheck,
  ProviderFallbackContext,
  WebhookPayload,
} from '../types.js';
import { commitShasMatch } from '../utils.js';

const CODERABBIT_APP_SLUG = 'coderabbitai';
const CODERABBIT_BOT_LOGINS = new Set(['coderabbitai[bot]', 'coderabbitai']);

const RECENT_REVIEW_STATUS_REGEX =
  /<!--\s*recent_review_status_start\s*-->([\s\S]*?)<!--\s*recent_review_status_end\s*-->/i;
const SKIP_REVIEW_MARKER_REGEX =
  /<!--\s*This is an auto-generated comment:\s*skip review by coderabbit\.ai\s*-->/i;
const SKIP_REVIEW_BLOCK_REGEX =
  /<!--\s*This is an auto-generated comment:\s*skip review by coderabbit\.ai\s*-->[\s\S]*?<!--\s*end of auto-generated comment:\s*skip review by coderabbit\.ai\s*-->/gi;
const REVIEWED_COVERAGE_MARKER_REGEX =
  /<!--\s*final_review_risk_coverage:\s*\{[^}]*"kind"\s*:\s*"reviewed"[^}]*\}\s*-->/i;

const CHANGE_ASSESSMENT_COMMIT_REGEX =
  /<!--\s*change_assessment_commit:"([0-9a-f]{7,40})"\s*-->/i;
const FINAL_RISK_COVERED_COMMIT_REGEX =
  /<!--\s*final_review_risk_coverage:\s*\{[^}]*"coveredCommitId"\s*:\s*"([0-9a-f]{7,40})"[^}]*\}\s*-->/i;
const FINAL_RISK_SOURCE_COMMIT_REGEX =
  /<!--\s*final_review_risk_coverage:\s*\{[^}]*"sourceCommitId"\s*:\s*"([0-9a-f]{7,40})"[^}]*\}\s*-->/i;

const ACTIONABLE_POSTED_REGEX = /\bActionable comments posted:\s*[1-9]\d*/i;
const ZERO_ACTIONABLE_REGEX = /\bActionable comments posted:\s*0\b/i;
const NO_ACTIONABLE_REGEX = /\bNo actionable comments were generated\b/i;

const REVIEWS_AVAILABLE_REGEX = /\bReviews are available now\b/i;
const REPLY_NOTE_REGEX =
  /^>?\s*Note:[^\n]*This command is applicable only when automatic reviews are paused\.?[^\n]*$/gim;
const NON_STATUS_SECTION_REGEXES: RegExp[] = [
  /<!--\s*walkthrough_start\s*-->[\s\S]*?<!--\s*walkthrough_end\s*-->/gi,
  /<!--\s*pre_merge_checks_walkthrough_start\s*-->[\s\S]*?<!--\s*pre_merge_checks_walkthrough_end\s*-->/gi,
  /<!--\s*tips_start\s*-->[\s\S]*?<!--\s*tips_end\s*-->/gi,
];
const RATE_LIMIT_PATTERNS: RegExp[] = [
  /\bReview rate limited\b/i,
  /\brate limit(?:ing)?\s+(?:exceeded|reached|hit)\b/i,
  /\bskip(?:ped)?\b[\s\S]{0,60}\brate limit/i,
  /\brate limit(?:s|ed|ing)?\b[\s\S]{0,60}\bskip(?:ped)?\b/i,
];
const AUTO_REVIEW_DISABLED_PATTERNS: RegExp[] = [
  /\bauto(?:matic)? reviews? (?:are|is) paused\b/i,
  /\bdoes not receive automatic reviews\b/i,
];

function isCodeRabbitBot(login?: string | null): boolean {
  if (!login) {
    return false;
  }
  return CODERABBIT_BOT_LOGINS.has(login.toLowerCase());
}

/**
 * Extract the commit SHA embedded in CodeRabbit summary comments when available
 * so delayed comment edits for an older commit do not overwrite newer state.
 */
export function extractEmbeddedCommitSha(body: string): string | undefined {
  const match =
    body.match(CHANGE_ASSESSMENT_COMMIT_REGEX) ??
    body.match(FINAL_RISK_COVERED_COMMIT_REGEX) ??
    body.match(FINAL_RISK_SOURCE_COMMIT_REGEX);
  return match?.[1];
}

function stripNonStatusSections(body: string): string {
  let cleaned = body.replace(REPLY_NOTE_REGEX, '');
  for (const sectionRegex of NON_STATUS_SECTION_REGEXES) {
    cleaned = cleaned.replace(sectionRegex, '');
  }
  return cleaned;
}

function evaluateSkipOrRateLimitText(body: string): 'skipped' | 'not-reviewed' | undefined {
  const cleaned = stripNonStatusSections(body);
  if (REVIEWS_AVAILABLE_REGEX.test(cleaned)) {
    return undefined;
  }
  if (RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(cleaned))) {
    return 'skipped';
  }
  if (AUTO_REVIEW_DISABLED_PATTERNS.some((pattern) => pattern.test(cleaned))) {
    return 'not-reviewed';
  }
  return undefined;
}

function evaluateCheckRun(payload: WebhookPayload): EvaluationResult {
  if (payload.action && payload.action !== 'completed') {
    return {
      kind: 'ignored',
      reason: `Ignoring check_run action "${payload.action}"`,
    };
  }

  const checkRun = payload.check_run;
  if (!checkRun) {
    return { kind: 'ignored', reason: 'Missing check_run payload' };
  }

  const appSlug = checkRun.app?.slug?.toLowerCase();
  if (appSlug !== CODERABBIT_APP_SLUG) {
    return {
      kind: 'ignored',
      reason: `Ignoring check_run from app "${checkRun.app?.slug ?? 'unknown'}"`,
    };
  }

  const conclusion = checkRun.conclusion?.toLowerCase() ?? '';
  if (conclusion === 'success') {
    return {
      kind: 'ignored',
      reason: 'CodeRabbit check_run succeeded; deferring verdict to review/comment events',
    };
  }

  if (conclusion === 'skipped') {
    const outputText = [checkRun.output?.title, checkRun.output?.summary, checkRun.output?.text]
      .filter((part): part is string => Boolean(part))
      .join('\n');
    const outputStatus = outputText ? evaluateSkipOrRateLimitText(outputText) : undefined;
    const status = outputStatus ?? 'not-reviewed';
    return {
      kind: 'matched',
      status,
      reason:
        status === 'skipped'
          ? 'CodeRabbit check_run was skipped due to rate limiting'
          : 'CodeRabbit check_run concluded with "skipped"',
      targetCommitSha: checkRun.head_sha,
    };
  }

  return {
    kind: 'matched',
    status: 'skipped',
    reason: `CodeRabbit check_run concluded with "${conclusion || 'unknown'}"`,
    targetCommitSha: checkRun.head_sha,
  };
}

function evaluateReviewObject(review: {
  state?: string | null;
  body?: string | null;
  commit_id?: string | null;
}): EvaluationResult {
  const state = review.state?.toLowerCase() ?? '';
  const body = review.body ?? '';
  const targetCommitSha = review.commit_id ?? undefined;

  if (state === 'changes_requested' || ACTIONABLE_POSTED_REGEX.test(body)) {
    return {
      kind: 'matched',
      status: 'changes-requested',
      reason: 'CodeRabbit pull_request_review reported actionable findings',
      targetCommitSha,
    };
  }

  const skipOrRateLimitStatus = evaluateSkipOrRateLimitText(body);
  if (skipOrRateLimitStatus) {
    return {
      kind: 'matched',
      status: skipOrRateLimitStatus,
      reason:
        skipOrRateLimitStatus === 'skipped'
          ? 'CodeRabbit pull_request_review indicated review was rate limited'
          : 'CodeRabbit pull_request_review indicated automatic reviews are disabled or paused',
      targetCommitSha,
    };
  }

  if (
    state === 'approved' ||
    NO_ACTIONABLE_REGEX.test(body) ||
    ZERO_ACTIONABLE_REGEX.test(body)
  ) {
    return {
      kind: 'matched',
      status: 'approved',
      reason: 'CodeRabbit pull_request_review reported no actionable findings',
      targetCommitSha,
    };
  }

  return {
    kind: 'ignored',
    reason: 'CodeRabbit pull_request_review did not contain a recognized review verdict',
  };
}

function evaluatePullRequestReview(payload: WebhookPayload): EvaluationResult {
  if (payload.action && payload.action !== 'submitted') {
    return {
      kind: 'ignored',
      reason: `Ignoring pull_request_review action "${payload.action}"`,
    };
  }

  const review = payload.review;
  if (!review) {
    return { kind: 'ignored', reason: 'Missing review payload' };
  }

  if (!isCodeRabbitBot(review.user?.login)) {
    return {
      kind: 'ignored',
      reason: `Ignoring pull_request_review from "${review.user?.login ?? 'unknown'}"`,
    };
  }

  return evaluateReviewObject(review);
}

function evaluateIssueComment(payload: WebhookPayload): EvaluationResult {
  if (payload.action && payload.action !== 'created' && payload.action !== 'edited') {
    return {
      kind: 'ignored',
      reason: `Ignoring issue_comment action "${payload.action}"`,
    };
  }

  if (!payload.issue?.pull_request) {
    return { kind: 'ignored', reason: 'Ignoring issue_comment not on a pull request' };
  }

  const comment = payload.comment;
  if (!comment) {
    return { kind: 'ignored', reason: 'Missing comment payload' };
  }

  if (!isCodeRabbitBot(comment.user?.login)) {
    return {
      kind: 'ignored',
      reason: `Ignoring issue_comment from "${comment.user?.login ?? 'unknown'}"`,
    };
  }

  const body = comment.body ?? '';
  const targetCommitSha = extractEmbeddedCommitSha(body);

  const recentStatusMatch = body.match(RECENT_REVIEW_STATUS_REGEX);
  if (recentStatusMatch) {
    const recentStatusText = recentStatusMatch[1];
    if (ACTIONABLE_POSTED_REGEX.test(recentStatusText)) {
      return {
        kind: 'matched',
        status: 'changes-requested',
        reason: 'CodeRabbit recent review status reported actionable comments',
        targetCommitSha,
      };
    }
    if (
      NO_ACTIONABLE_REGEX.test(recentStatusText) ||
      ZERO_ACTIONABLE_REGEX.test(recentStatusText)
    ) {
      return {
        kind: 'matched',
        status: 'approved',
        reason: 'CodeRabbit recent review status reported no actionable comments',
        targetCommitSha,
      };
    }
  }

  if (ACTIONABLE_POSTED_REGEX.test(body)) {
    return {
      kind: 'matched',
      status: 'changes-requested',
      reason: 'CodeRabbit comment reported actionable comments',
      targetCommitSha,
    };
  }

  if (NO_ACTIONABLE_REGEX.test(body) || ZERO_ACTIONABLE_REGEX.test(body)) {
    return {
      kind: 'matched',
      status: 'approved',
      reason: 'CodeRabbit comment reported no actionable comments',
      targetCommitSha,
    };
  }

  // CodeRabbit may keep the initial skip-review banner in a summary comment even after
  // a manual review adds final_review_risk_coverage with kind="reviewed".
  const hasReviewedCoverage = REVIEWED_COVERAGE_MARKER_REGEX.test(body);
  const bodyWithoutStaleSkipBanner = hasReviewedCoverage
    ? body.replace(SKIP_REVIEW_BLOCK_REGEX, '')
    : body;

  const textStatus = evaluateSkipOrRateLimitText(bodyWithoutStaleSkipBanner);
  if (textStatus === 'skipped') {
    return {
      kind: 'matched',
      status: 'skipped',
      reason: 'CodeRabbit comment indicated review was rate limited',
      targetCommitSha,
    };
  }

  if (SKIP_REVIEW_MARKER_REGEX.test(body) && !hasReviewedCoverage) {
    return {
      kind: 'matched',
      status: 'not-reviewed',
      reason: 'CodeRabbit summary comment indicated automatic review was skipped',
      targetCommitSha,
    };
  }

  if (textStatus === 'not-reviewed') {
    return {
      kind: 'matched',
      status: 'not-reviewed',
      reason: 'CodeRabbit comment indicated automatic reviews are disabled or paused',
      targetCommitSha,
    };
  }

  return {
    kind: 'ignored',
    reason: 'CodeRabbit comment did not contain a recognized review status',
  };
}

export class CodeRabbitProvider implements ProviderAdapter {
  public readonly name = 'coderabbit';

  public evaluate(eventName: string, payload: WebhookPayload): EvaluationResult {
    switch (eventName) {
      case 'check_run':
        return evaluateCheckRun(payload);
      case 'pull_request_review':
        return evaluatePullRequestReview(payload);
      case 'issue_comment':
        return evaluateIssueComment(payload);
      default:
        return {
          kind: 'ignored',
          reason: `Unsupported event "${eventName}" for provider "${this.name}"`,
        };
    }
  }

  /**
   * When pull_request_review workflows cannot run (e.g., workflow only exists on
   * the default branch while the PR targets another branch), check_run(success)
   * and reviewed summary comments can still fall back to querying PR reviews.
   */
  public shouldAttemptFallback(eventName: string, payload: WebhookPayload): ProviderFallbackCheck {
    if (eventName === 'check_run') {
      if (payload.action && payload.action !== 'completed') {
        return { eligible: false };
      }
      const checkRun = payload.check_run;
      if (
        checkRun &&
        checkRun.app?.slug?.toLowerCase() === CODERABBIT_APP_SLUG &&
        checkRun.conclusion?.toLowerCase() === 'success'
      ) {
        return {
          eligible: true,
          targetCommitSha: checkRun.head_sha,
        };
      }
      return { eligible: false };
    }

    if (eventName === 'issue_comment') {
      if (payload.action && payload.action !== 'created' && payload.action !== 'edited') {
        return { eligible: false };
      }
      if (!payload.issue?.pull_request || !isCodeRabbitBot(payload.comment?.user?.login)) {
        return { eligible: false };
      }
      const body = payload.comment?.body ?? '';
      if (REVIEWED_COVERAGE_MARKER_REGEX.test(body)) {
        return {
          eligible: true,
          targetCommitSha: extractEmbeddedCommitSha(body),
        };
      }
      return { eligible: false };
    }

    return { eligible: false };
  }

  public async evaluateFallback(context: ProviderFallbackContext): Promise<EvaluationResult> {
    const reviews: Array<{
      user?: { login?: string } | null;
      state?: string | null;
      body?: string | null;
      commit_id?: string | null;
      submitted_at?: string | null;
    }> = [];

    for (let page = 1; page <= 10; page += 1) {
      const { data } = await context.octokit.rest.pulls.listReviews({
        owner: context.owner,
        repo: context.repo,
        pull_number: context.prNumber,
        per_page: 100,
        page,
      });
      reviews.push(...data);
      if (data.length < 100) {
        break;
      }
    }

    const matchingReviews = reviews
      .map((review, index) => ({ review, index }))
      .filter(
        ({ review }) =>
          isCodeRabbitBot(review.user?.login) &&
          Boolean(review.commit_id) &&
          commitShasMatch(review.commit_id!, context.headSha),
      )
      .sort((a, b) => {
        const timeA = a.review.submitted_at ? Date.parse(a.review.submitted_at) : Number.NaN;
        const timeB = b.review.submitted_at ? Date.parse(b.review.submitted_at) : Number.NaN;
        if (!Number.isNaN(timeA) && !Number.isNaN(timeB) && timeA !== timeB) {
          return timeB - timeA;
        }
        return b.index - a.index;
      });

    for (const { review } of matchingReviews) {
      const result = evaluateReviewObject(review);
      if (result.kind === 'matched') {
        return result;
      }
    }

    return {
      kind: 'ignored',
      reason: 'No CodeRabbit pull_request_review with a recognized verdict found for current head commit',
    };
  }
}
