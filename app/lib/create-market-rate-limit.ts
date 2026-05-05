/**
 * Rate limiter for market-creation–adjacent POST routes:
 * `/api/mobile/create-market` and `/api/launch` (prep / pool detection).
 *
 * Thin wrapper around the shared Upstash rate limiter factory.
 * Limit: 5 requests per minute per route bucket.
 */

import {
  createUpstashRateLimiter,
  type RateLimitResult,
} from "./upstash-rate-limit";

export type { RateLimitResult };

export const CREATE_MARKET_RATE_LIMIT = 5;
export const CREATE_MARKET_RATE_WINDOW_MS = 60_000;

const createMarketLimiter = createUpstashRateLimiter({
  limit: CREATE_MARKET_RATE_LIMIT,
  windowMs: CREATE_MARKET_RATE_WINDOW_MS,
  prefix: "rl:create-market",
});

const launchLimiter = createUpstashRateLimiter({
  limit: CREATE_MARKET_RATE_LIMIT,
  windowMs: CREATE_MARKET_RATE_WINDOW_MS,
  prefix: "rl:launch",
});

/** POST /api/mobile/create-market — 5 req/min per IP (bucket separate from launch). */
export async function checkCreateMarketRateLimit(
  ip: string
): Promise<RateLimitResult> {
  return createMarketLimiter.check(`create-market:${ip}`);
}

/** POST /api/launch — same numeric limit, independent bucket (RPC + DexScreener cost). */
export async function checkLaunchRateLimit(
  ip: string
): Promise<RateLimitResult> {
  return launchLimiter.check(`launch:${ip}`);
}
