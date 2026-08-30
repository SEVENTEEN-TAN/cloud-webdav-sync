export interface HeadReplanRetryDecision {
  readonly shouldRetry: boolean;
  readonly retryNumber: number;
  readonly maxRetries: number;
}

export function decideHeadReplanRetry(
  completedAttemptIndex: number,
  maxRetries: number,
): HeadReplanRetryDecision {
  const retryNumber = completedAttemptIndex + 1;
  return {
    shouldRetry: retryNumber <= maxRetries,
    retryNumber,
    maxRetries,
  };
}
