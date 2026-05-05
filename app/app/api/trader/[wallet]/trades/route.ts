import { NextRequest, NextResponse } from "next/server";
import { getServiceClient, getServerNetwork } from "@/lib/supabase";
import { PublicKey } from "@solana/web3.js";
import { validateNumericParam } from "@/lib/route-validators";
import { getClientIp } from "@/lib/get-client-ip";
import { createMemoryRateLimiter } from "@/lib/memory-rate-limit";

/**
 * GET /api/trader/:wallet/trades?limit=20&offset=0&slab=<optional>
 *
 * Returns paginated trade history for a specific wallet address.
 * Uses service_role client (bypasses RLS) — all on-chain trades are public.
 *
 * PERC-420: Trade history for portfolio page
 *
 * Security: IP-based in-memory rate limiter (60 req/min) guards against
 * unauthenticated enumeration / DB-scraping (see GitHub issue #700).
 */
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// 60 requests per minute per IP — shared rate limiter factory (lib/memory-rate-limit.ts).
// Resets on cold start (fine for serverless).
// ---------------------------------------------------------------------------
const RATE_LIMIT = 60;
const rateLimiter = createMemoryRateLimiter({ limit: RATE_LIMIT, windowMs: 60_000 });

export interface TraderTradeEntry {
  id: string;
  slab_address: string;
  trader: string;
  side: "long" | "short";
  size: string; // raw bigint as string
  price: number;
  fee: number;
  tx_signature: string | null;
  created_at: string;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ wallet: string }> },
) {
  // Rate limiting — 60 req/min per IP (fixes #700)
  const ip = getClientIp(_request);
  if (rateLimiter.isLimited(ip)) {
    return NextResponse.json(
      { error: "Too many requests — max 60 per minute" },
      {
        status: 429,
        headers: {
          "Retry-After": "60",
          "X-RateLimit-Limit": String(RATE_LIMIT),
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Window": "60s",
        },
      },
    );
  }

  const { wallet } = await params;
  const url = new URL(_request.url);

  // Validate wallet address
  let walletKey: string;
  try {
    walletKey = new PublicKey(wallet).toBase58();
  } catch {
    return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 });
  }

  // Pagination — use validateNumericParam for strict bounds checking
  // GH#1815: Prevent negative/huge limit and unbounded offset values.
  // limit: 1-100 (clamp to 100 if >100), default 20
  // offset: 0-1000000 (clamp to max if >max), default 0
  const MAX_LIMIT = 100;
  const MAX_OFFSET = 1_000_000;
  const DEFAULT_LIMIT = 20;

  const limitParam = url.searchParams.get("limit");
  const limitValidation = validateNumericParam(limitParam ?? String(DEFAULT_LIMIT), {
    min: 1,
    max: MAX_LIMIT,
  });
  const limit = !limitValidation.valid
    ? DEFAULT_LIMIT // non-numeric or out-of-bounds → use default
    : limitValidation.value;

  const offsetParam = url.searchParams.get("offset");
  const offsetValidation = validateNumericParam(offsetParam ?? "0", {
    min: 0,
    max: MAX_OFFSET,
  });
  const offset = !offsetValidation.valid ? 0 : offsetValidation.value;

  // Optional slab filter
  const slabFilter = url.searchParams.get("slab");

  try {
    const supabase = getServiceClient();

    // PERC-8195: filter by network so devnet/mainnet trades don't mix
    let query = supabase
      .from("trades")
      .select("id, slab_address, trader, side, size, price, fee, tx_signature, created_at", { count: "exact" })
      .eq("trader", walletKey)
      .eq("network", getServerNetwork())
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (slabFilter) {
      // Basic slab address validation (44 chars base58)
      const safeSlab = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(slabFilter) ? slabFilter : null;
      if (safeSlab) query = query.eq("slab_address", safeSlab);
    }

    let { data, error, count } = await query;

    // GH#1875: Graceful fallback — if the network column doesn't exist yet
    // (PERC-8215 migration not applied), retry without the network filter.
    if (error && error.message?.includes("network")) {
      console.warn(
        "[trader-trades] PERC-8215: network column missing on trades table — " +
        "falling back to unfiltered query. Apply 20260329180000_add_network_column.sql to fix."
      );
      let fallbackQuery = supabase
        .from("trades")
        .select("id, slab_address, trader, side, size, price, fee, tx_signature, created_at", { count: "exact" })
        .eq("trader", walletKey)
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1);

      if (slabFilter) {
        const safeSlab = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(slabFilter) ? slabFilter : null;
        if (safeSlab) fallbackQuery = fallbackQuery.eq("slab_address", safeSlab);
      }

      const fallback = await fallbackQuery;
      data = fallback.data;
      error = fallback.error;
      count = fallback.count;
    }

    if (error) throw error;

    const trades: TraderTradeEntry[] = (data ?? []).map((row) => ({
      id: String(row.id),
      slab_address: String(row.slab_address),
      trader: String(row.trader),
      side: row.side as "long" | "short",
      size: String(row.size),
      price: Number(row.price),
      fee: Number(row.fee),
      tx_signature: row.tx_signature ? String(row.tx_signature) : null,
      created_at: String(row.created_at),
    }));

    return NextResponse.json(
      {
        trades,
        total: count ?? 0,
        limit,
        offset,
      },
      {
        headers: {
          // Allow CDN/edge to cache per-wallet responses for 10s,
          // reducing repeat DB hits from the same request (fixes #700).
          "Cache-Control": "public, s-maxage=10, stale-while-revalidate=30",
          "X-RateLimit-Limit": String(RATE_LIMIT),
          "X-RateLimit-Remaining": String(rateLimiter.remaining(ip)),
          "X-RateLimit-Window": "60s",
        },
      },
    );
  } catch (err) {
    console.error("[trader-trades] error:", err);
    return NextResponse.json(
      {
        error: "Failed to fetch trade history",
        ...(process.env.NODE_ENV !== "production" && {
          details: err instanceof Error ? err.message : String(err),
        }),
      },
      { status: 500 },
    );
  }
}
