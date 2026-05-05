"use client";

import { useEffect, useState, useRef } from "react";
import { PublicKey } from "@solana/web3.js";
import { SUPPORTED_DEX_IDS } from "@/lib/dex-constants";

export interface DexPoolResult {
  poolAddress: string;
  dexId: string;       // "pumpswap" | "raydium" | "meteora"
  pairLabel: string;   // e.g. "SOL / USDC"
  /** Base token symbol from DexScreener (e.g. "SOL"). Used to build market symbol/name. */
  baseSymbol: string;
  /** Quote token symbol from DexScreener (e.g. "USDC"). Used to build market name. */
  quoteSymbol: string;
  liquidityUsd: number;
  priceUsd: number;
}

function isValidSolanaMint(mint: string): boolean {
  try {
    new PublicKey(mint);
    return true;
  } catch {
    return false;
  }
}

/**
 * Search DexScreener for DEX pools containing a given token mint.
 * Filters to supported DEXes (PumpSwap, Raydium, Meteora) and sorts by liquidity.
 *
 * Mint must be a valid Solana address before any browser fetch — avoids noisy calls
 * and leaking malformed input to a third-party API (Prompt 87).
 */
export function useDexPoolSearch(mint: string | null) {
  const [pools, setPools] = useState<DexPoolResult[]>([]);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setPools([]);
    const trimmed = mint?.trim() ?? "";
    if (!trimmed || !isValidSolanaMint(trimmed)) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);

    (async () => {
      try {
        const url = `https://api.dexscreener.com/latest/dex/tokens/${trimmed}`;
        const resp = await fetch(url, {
          signal: controller.signal,
          headers: { "User-Agent": "percolator-app/1.0" },
        });
        const json: { pairs?: Array<{
          chainId?: string;
          dexId?: string;
          pairAddress: string;
          baseToken?: { symbol?: string };
          quoteToken?: { symbol?: string };
          liquidity?: { usd?: number };
          priceUsd?: string;
        }> } = await resp.json();
        const pairs = json.pairs || [];

        const results: DexPoolResult[] = [];
        for (const pair of pairs) {
          if (pair.chainId !== "solana") continue;
          const dexId = (pair.dexId || "").toLowerCase();
          if (!SUPPORTED_DEX_IDS.has(dexId)) continue;

          const liquidity = pair.liquidity?.usd || 0;
          if (liquidity < 100) continue; // skip tiny pools

          const baseSymbol = pair.baseToken?.symbol || "?";
          const quoteSymbol = pair.quoteToken?.symbol || "?";
          results.push({
            poolAddress: pair.pairAddress,
            dexId,
            pairLabel: `${baseSymbol} / ${quoteSymbol}`,
            baseSymbol,
            quoteSymbol,
            liquidityUsd: liquidity,
            priceUsd: parseFloat(pair.priceUsd ?? "0") || 0,
          });
        }

        // Sort by liquidity descending
        results.sort((a, b) => b.liquidityUsd - a.liquidityUsd);

        if (!controller.signal.aborted) {
          setPools(results.slice(0, 10));
        }
      } catch {
        // ignore aborts and errors
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    })();

    return () => controller.abort();
  }, [mint]);

  return { pools, loading };
}
