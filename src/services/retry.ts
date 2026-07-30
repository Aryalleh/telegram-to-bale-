import { ApiError } from "./bot-api.js";

/**
 * Exponential backoff schedule (seconds) for the async retry queue.
 * Attempt 1 is immediate; subsequent attempts wait progressively longer.
 */
export function backoffSeconds(attempt: number): number {
  // attempt: 1 -> 0s (immediate, handled inline), 2 -> 5s, 3 -> 30s, 4 -> 120s
  const schedule = [0, 5, 30, 120, 600];
  return schedule[Math.min(attempt, schedule.length - 1)];
}

/** Whether an error should be retried at all. */
export function isRetryable(err: unknown): boolean {
  if (err instanceof ApiError) {
    if (err.permanent) return false;
    // Rate limits and 5xx are retryable.
    if (err.code === 429) return true;
    if (err.code >= 500) return true;
    return false;
  }
  // Network/timeout errors (fetch throws TypeError) are retryable.
  return true;
}

/**
 * Run an async operation with a small number of inline retries for transient
 * failures. For durable retries across requests, enqueue a sync_job instead.
 */
export async function withInlineRetry<T>(
  fn: () => Promise<T>,
  opts: { maxAttempts?: number } = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === maxAttempts) throw err;
      const retryAfter = err instanceof ApiError && err.retryAfter ? err.retryAfter : Math.min(attempt * 2, 8);
      await sleep(retryAfter * 1000);
    }
  }
  throw lastErr;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
