/**
 * PERC-799 / GH#1124: Rate limiter for POST /api/oracle/advance-phase.
 *
 * Thin wrapper around the shared Upstash rate limiter factory.
 * Limit: 60 requests per IP per minute.
 */

import {
  createUpstashRateLimiter,
  type RateLimitResult,
} from "./upstash-rate-limit";

export type { RateLimitResult };

export const ADVANCE_PHASE_RATE_LIMIT = 60;
export const ADVANCE_PHASE_RATE_WINDOW_MS = 60_000;

const limiter = createUpstashRateLimiter({
  limit: ADVANCE_PHASE_RATE_LIMIT,
  windowMs: ADVANCE_PHASE_RATE_WINDOW_MS,
  prefix: "rl:advance-phase",
});

export async function checkAdvancePhaseRateLimit(
  ip: string
): Promise<RateLimitResult> {
  return limiter.check(ip);
}
