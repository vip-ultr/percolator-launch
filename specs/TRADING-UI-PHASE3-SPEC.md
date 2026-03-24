# Phase 3 — Trade UI Polish Spec
**Author:** designer  
**Date:** 2026-03-24  
**Status:** Ready for implementation  
**Target components:** MarketSelector, MarketBookCard, PositionPanel

---

## Scope

Three focused polish passes on the trade page. All changes are visual/UX only — no behaviour or data changes unless explicitly noted. Follow existing design tokens (`var(--accent)`, `var(--border)`, `var(--font-mono)`, etc.) and keep the sharp monospace aesthetic.

---

## 1. Market Selector / Symbol Switcher

**File:** `app/components/trade/MarketSelector.tsx`

### Current state
- Trigger: `{symbol}/USD PERP` with dropdown caret
- Dropdown: 340px wide, mono text list, 3 columns (market, price, 24h vol)
- No oracle status, no 24h change %, no logo

### Changes

#### 1.1 Trigger button — richer context
```
[LOGO 16px] SOL/USD  PERP  ▾
            $179.39  +3.24%
```
- Add `<MarketLogo>` at 16×16px to the left of the symbol text
- Show live price below symbol (use `useLivePrice` already in page scope — pass as prop or have selector pull `useAllMarketStats` price)
- 24h change % coloured: `var(--long)` for positive, `var(--short)` for negative, muted for zero/null
- Keep current click-to-open behaviour unchanged

#### 1.2 Dropdown rows — oracle & change badge
Each market row:
```
[LOGO] SOL/USD  10x    $179.39    +3.24%    $1.2K vol
                        (mono)    (green)   (dim)
```
- Add 14×14px `<MarketLogo>` before symbol
- Add 24h change % column (between price and vol), coloured green/red/dim
- If `m.oracle_available === false` (or equivalent flag): show `NO ORACLE` amber badge (`text-[8px] text-amber-400 border border-amber-400/30 px-1`) replacing the price cell
- Widen dropdown to `w-[380px]`
- Column headers: MARKET / PRICE / 24H / VOL

#### 1.3 Empty & loading states
- Loading: show 4 skeleton rows (`animate-pulse bg-[var(--border)]/20 h-6 rounded-none`) instead of centred text
- No results: keep current text but add a "Browse all markets →" link to `/markets`

---

## 2. OrderBook / Depth Card (MarketBookCard)

**File:** `app/components/trade/MarketBookCard.tsx`

### Current state
- 3-cell price ladder (Bid / Oracle / Ask) with fee-adjusted prices
- Two "depth" cells showing LP total capital for both sides (same number — not a real book)
- LP table below

### Changes

#### 2.1 Price ladder — bigger, cleaner
- Increase price font to `text-[13px]` (from 11px)
- Oracle cell: add subtle left+right border `border-x border-[var(--accent)]/20` and background `bg-[var(--accent)]/[0.03]`
- Label row: keep 8px uppercase tracking — no change

#### 2.2 Spread indicator
Between the Bid and Ask cells, or below the ladder, add a single-line spread row:
```
SPREAD   $0.0023  (0.001%)
```
- Compute: `spread = bestAsk - bestBid`; `spreadPct = (spread / bestAsk) * 100`
- Style: `text-[9px] text-[var(--text-dim)] font-mono`
- Show only when `oraclePrice > 0n`

#### 2.3 Depth bars — visual fix
Current both sides show the same LP capital. Until real book data is available, show them as:
- Bid side: LP capital available to short sellers = `lpTotalCapital`
- Ask side: LP capacity net of open longs = `lpTotalCapital - openLongPositions` (clamp to 0)
- Use `useEngineState().engine` for `openLongPositions` (it's already imported)
- Add thin horizontal fill bar inside each cell: height `3px`, `bg-[var(--long)]/40` / `bg-[var(--short)]/40`, width proportional to pool utilisation

#### 2.4 LP table — polish
- Add a `UTILISATION` column (rightmost): `(positionSize / capital) * 100` formatted as `XX.X%`
- Colour: `>80%` → `text-[var(--short)]`, `>50%` → `text-amber-400`, else `text-[var(--text-dim)]`
- Cap table to first 5 LPs; if more exist show `+N more` dim text row at bottom

---

## 3. Position Card (PositionPanel)

**File:** `app/components/trade/PositionPanel.tsx`

### Current state
- Shows position size, entry price, PnL, liq price, funding
- Has a close button that opens `ClosePositionModal`
- Shows "No open position" empty state

### Changes

#### 3.1 Position header bar
When a position is open, add a coloured header strip:
```
▲ LONG  SOL/USD    10.00x    [CLOSE ×]
```
- Background: `bg-[var(--long)]/[0.06]` for long, `bg-[var(--short)]/[0.06]` for short
- Left border: `border-l-2 border-[var(--long)]` / `border-[var(--short)]`
- Direction arrow: `▲` in `text-[var(--long)]`, `▼` in `text-[var(--short)]`
- Leverage badge: `{leverage}x` in `text-[8px] bg-[var(--accent)]/10 text-[var(--accent)] px-1`
- CLOSE button: stays right-aligned as a compact `×` text button

#### 3.2 PnL — live colour animation
- When PnL crosses zero: animate background flash (100ms `bg-[var(--long)]/10` or `bg-[var(--short)]/10`, then fade to transparent via `transition-colors duration-500`)
- Use `useRef` to track previous PnL sign and trigger the flash on sign change

#### 3.3 ROE badge
Next to the PnL value, show ROE %:
```
+$12.34  (+18.4% ROE)
```
- `computePnlPercent` is already imported — use it
- Style ROE in the same green/red as PnL but at `text-[10px]` opacity `0.8`

#### 3.4 Funding rate inline
Below entry price, add one line:
```
Funding/8h   +0.0023%   (next in 2h 14m)
```
- `fundingRate` already available from `useEngineState()`
- Countdown: compute `secondsUntilNextFunding` from block time (or static 8h from last crank — estimate is fine)
- If funding is negative (paying): colour `text-[var(--short)]`; if positive (receiving): `text-[var(--long)]`

#### 3.5 Empty state — CTA improvement
When no position:
```
No open position
Connect wallet and trade to get started.
[Trade Now →]  (links to #trade-form or scrolls to TradeForm)
```
- Add a small primary button styled `border border-[var(--accent)]/40 text-[var(--accent)] text-[10px] px-3 py-1 hover:bg-[var(--accent)]/[0.06]`
- Only show if wallet not connected: "Connect wallet" text; if wallet connected but no position: "Open a position"

---

## Token colours (reference)
| Token | Value |
|-------|-------|
| `--long` | `#22c55e` (green) |
| `--short` | `#ef4444` (red) |
| `--accent` | `#7c3aed` (purple) |
| `--border` | `rgba(255,255,255,0.08)` |
| `--text-dim` | `rgba(255,255,255,0.25)` |
| `--text-muted` | `rgba(255,255,255,0.40)` |
| `--text-secondary` | `rgba(255,255,255,0.65)` |
| `--text` | `rgba(255,255,255,0.90)` |
| `--font-mono` | `var(--font-geist-mono)` |

---

## Acceptance criteria
- [ ] MarketSelector trigger shows logo + price + 24h %
- [ ] MarketSelector dropdown shows oracle badge for no-oracle markets
- [ ] MarketBookCard shows spread row when oracle price > 0
- [ ] MarketBookCard LP table has utilisation column, capped at 5 rows
- [ ] PositionPanel shows coloured header strip for open positions
- [ ] PositionPanel shows ROE % alongside PnL
- [ ] PositionPanel shows funding rate / next crank countdown
- [ ] No TypeScript errors; all existing tests pass
- [ ] Visual tested at 375px (mobile) and 1440px (desktop)
