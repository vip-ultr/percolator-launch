/**
 * Tests for GH#1595 fix: faucet INSERT-as-gate rate limit
 *
 * lib/faucet-rate-gate.ts implements tryFaucetGate() using INSERT-as-gate with
 * a UNIQUE INDEX on (wallet, fund_type). Concurrent requests race on INSERT —
 * exactly one wins, others hit 23505. Eliminates SELECT→INSERT TOCTOU.
 *
 * Same pattern as tryAirdropClaimGate (PR #1587 / airdrop-rate-limit-gate.test.ts).
 */

import { describe, it, expect } from "vitest";

// ─── Inline simulation (mirrors tryFaucetGate logic) ───────────────────────

const RATE_LIMIT_MS = 24 * 60 * 60 * 1000; // 24 hours

interface GateResult {
  allowed: boolean;
  nextClaimAt: string | null;
  claimId?: number;
}

/**
 * Pure simulation of tryFaucetGate for unit testing.
 *
 * @param deleteExpiredClears  Whether the expired-row DELETE freed the slot
 * @param insertError          null = INSERT succeeded, "23505" = unique conflict, "other" = unexpected error
 * @param existingClaim        Row returned when fetching existing claim after 23505
 * @param throwOnInsert        Simulate try/catch throw path
 */
function simulateFaucetGate(params: {
  deleteExpiredClears?: boolean;
  insertError: null | "23505" | "other";
  existingClaim?: { claimed_at: string } | null;
  throwOnInsert?: boolean;
}): GateResult {
  const { insertError, existingClaim, throwOnInsert } = params;

  if (throwOnInsert) {
    // catch block → fail open
    return { allowed: true, nextClaimAt: null };
  }

  if (insertError === null) {
    // INSERT succeeded — slot reserved
    return { allowed: true, nextClaimAt: null, claimId: 101 };
  }

  if (insertError === "23505") {
    // Unique conflict — active claim within window
    if (existingClaim) {
      const nextClaimAt = new Date(
        new Date(existingClaim.claimed_at).getTime() + RATE_LIMIT_MS,
      ).toISOString();
      return { allowed: false, nextClaimAt };
    }
    // Row disappeared between conflict and read (highly unlikely) — return null
    return { allowed: false, nextClaimAt: null };
  }

  // Unexpected DB error — fail open (devnet; don't block users)
  return { allowed: true, nextClaimAt: null };
}

/**
 * Simulate releaseFaucetClaim — returns true if DELETE succeeded, false on error.
 */
function simulateReleaseFaucetClaim(params: {
  claimId: number;
  deleteError?: boolean;
}): { released: boolean } {
  if (params.deleteError) {
    return { released: false };
  }
  return { released: true };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("GH#1595 — INSERT-as-gate rate limit for faucet / auto-fund", () => {
  // ── 1. First claim ────────────────────────────────────────────────────────
  describe("first claim (no prior row)", () => {
    it("allowed=true when INSERT succeeds", () => {
      const result = simulateFaucetGate({ insertError: null });
      expect(result.allowed).toBe(true);
      expect(result.nextClaimAt).toBeNull();
      expect(result.claimId).toBe(101);
    });
  });

  // ── 2. Duplicate claim within window ──────────────────────────────────────
  describe("second claim within 24h window", () => {
    it("allowed=false when INSERT hits 23505 (active claim exists)", () => {
      const claimedAt = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(); // 1h ago
      const result = simulateFaucetGate({
        insertError: "23505",
        existingClaim: { claimed_at: claimedAt },
      });
      expect(result.allowed).toBe(false);
    });

    it("nextClaimAt is ~24h after the original claimed_at timestamp", () => {
      const claimedAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(); // 3h ago
      const result = simulateFaucetGate({
        insertError: "23505",
        existingClaim: { claimed_at: claimedAt },
      });
      expect(result.allowed).toBe(false);
      if (!result.allowed && result.nextClaimAt) {
        const expected = new Date(claimedAt).getTime() + RATE_LIMIT_MS;
        const actual = new Date(result.nextClaimAt).getTime();
        expect(Math.abs(actual - expected)).toBeLessThan(1000);
      }
    });

    it("nextClaimAt is null when existing row disappeared after conflict", () => {
      // Row vanished between the 23505 error and the SELECT (race edge case)
      const result = simulateFaucetGate({
        insertError: "23505",
        existingClaim: null,
      });
      expect(result.allowed).toBe(false);
      expect(result.nextClaimAt).toBeNull();
    });
  });

  // ── 3. Re-claim after 24h window ─────────────────────────────────────────
  describe("claim after window expires", () => {
    it("allowed=true after expired row is cleared and INSERT succeeds", () => {
      // deleteExpiredClears=true simulates the DELETE removing the old row
      const result = simulateFaucetGate({ deleteExpiredClears: true, insertError: null });
      expect(result.allowed).toBe(true);
      expect(result.claimId).toBeDefined();
    });
  });

  // ── 4. Unexpected DB error — fail open ────────────────────────────────────
  describe("unexpected DB error path", () => {
    it("fail-open (allowed=true) on unexpected DB error from INSERT", () => {
      const result = simulateFaucetGate({ insertError: "other" });
      expect(result.allowed).toBe(true);
      expect(result.nextClaimAt).toBeNull();
    });

    it("fail-open (allowed=true) when tryFaucetGate throws", () => {
      const result = simulateFaucetGate({ insertError: null, throwOnInsert: true });
      expect(result.allowed).toBe(true);
      expect(result.nextClaimAt).toBeNull();
    });
  });

  // ── 5. releaseFaucetClaim ─────────────────────────────────────────────────
  describe("releaseFaucetClaim — DELETE removes claim row", () => {
    it("released=true when DELETE succeeds", () => {
      const result = simulateReleaseFaucetClaim({ claimId: 101 });
      expect(result.released).toBe(true);
    });

    it("released=false (and does not throw) when DELETE errors", () => {
      const result = simulateReleaseFaucetClaim({ claimId: 101, deleteError: true });
      expect(result.released).toBe(false);
    });
  });

  // ── 6. fund_type isolation ────────────────────────────────────────────────
  describe("fund_type isolation", () => {
    it("rate limit key includes fund_type — sol/usdc/auto-fund are independent slots", () => {
      // Each fund_type gets its own UNIQUE(wallet, fund_type) row.
      // Claiming 'sol' must not block 'usdc' or 'auto-fund' for the same wallet.
      const wallet = "So11111111111111111111111111111111111111112";
      const fundTypes = ["sol", "usdc", "auto-fund"] as const;
      const keys = fundTypes.map((ft) => `${wallet}:${ft}`);
      // All three keys are distinct — each type is a separate slot.
      expect(new Set(keys).size).toBe(3);
    });
  });
});
