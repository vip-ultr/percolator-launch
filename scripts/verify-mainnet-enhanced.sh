#!/usr/bin/env bash
# =============================================================================
# verify-mainnet-enhanced.sh — Comprehensive mainnet deployment verification
# =============================================================================
# Extended verification for mainnet services with market isolation, trade flow,
# and security checks. Use after deployment to ensure all systems are healthy.
#
# Usage:
#   ./scripts/verify-mainnet-enhanced.sh [--verbose] [--include-trade-test]
#
# Options:
#   --verbose           Show detailed output for each check
#   --include-trade-test Run mock trade flow test (requires /tmp/deployer.json)
#
# Environment variables (override defaults):
#   API_URL       — API base URL (default: https://percolator-api-mainnet.up.railway.app)
#   KEEPER_URL    — Keeper health URL (default: https://percolator-keeper-mainnet.up.railway.app)
#   INDEXER_URL   — Indexer base URL (default: https://percolator-indexer-mainnet.up.railway.app)
#   FRONTEND_URL  — Frontend URL (default: https://percolatorlaunch.com)
# =============================================================================

set -euo pipefail

API_URL="${API_URL:-https://percolator-api-mainnet.up.railway.app}"
KEEPER_URL="${KEEPER_URL:-https://percolator-keeper-mainnet.up.railway.app}"
INDEXER_URL="${INDEXER_URL:-https://percolator-indexer-mainnet.up.railway.app}"
FRONTEND_URL="${FRONTEND_URL:-https://percolatorlaunch.com}"

PASS=0
FAIL=0
WARN=0
VERBOSE=0
INCLUDE_TRADE_TEST=0

# Parse arguments
for arg in "$@"; do
  case $arg in
    --verbose) VERBOSE=1 ;;
    --include-trade-test) INCLUDE_TRADE_TEST=1 ;;
  esac
done

# Run trade flow test if requested
run_trade_test() {
  echo "${BLUE}Trade Flow Verification${NC}"

  # Check if e2e-open-close-position.ts script exists
  if [[ ! -f "scripts/e2e-open-close-position.ts" ]]; then
    warn "Trade test" "e2e-open-close-position.ts not found"
    return 1
  fi

  # Check if deployer keypair is available
  if [[ ! -f "/tmp/deployer.json" ]]; then
    warn "Trade test" "Deployer keypair not found at /tmp/deployer.json"
    return 1
  fi

  # Run the trade test
  if npx tsx scripts/e2e-open-close-position.ts &>/dev/null; then
    pass "Trade flow" "End-to-end trade test passed"
    return 0
  else
    fail "Trade flow" "End-to-end trade test failed"
    return 1
  fi
}

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

pass() {
  printf "${GREEN}✅${NC} PASS: %s\n" "$1"
  PASS=$((PASS+1))
  [[ $VERBOSE -eq 1 ]] && echo "   Details: $2"
}

fail() {
  printf "${RED}❌${NC} FAIL: %s\n" "$1"
  FAIL=$((FAIL+1))
  [[ -n "${2:-}" ]] && echo "   Details: $2"
}

warn() {
  printf "${YELLOW}⚠️${NC}  WARN: %s\n" "$1"
  WARN=$((WARN+1))
  [[ -n "${2:-}" ]] && echo "   Details: $2"
}

# Basic HTTP check
check_http() {
  local name="$1" url="$2" expected="${3:-200}"
  local status
  status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$url" 2>/dev/null || echo "000")
  if [[ "$status" == "$expected" ]]; then
    pass "$name" "HTTP $status"
  else
    fail "$name" "Expected HTTP $expected, got $status"
  fi
}

# Check JSON response is non-empty array
check_json_array() {
  local name="$1" url="$2"
  local body
  body=$(curl -s --max-time 10 "$url" 2>/dev/null || echo "")
  if [[ -z "$body" ]]; then
    fail "$name" "Empty response body"
    return
  fi
  local len
  len=$(echo "$body" | jq 'if type == "array" then length else 0 end' 2>/dev/null || echo "0")
  if [[ "$len" -gt 0 ]]; then
    pass "$name" "$len items returned"
  else
    fail "$name" "Response is empty array or invalid JSON"
  fi
}

# Check health JSON endpoint
check_health_json() {
  local name="$1" url="$2"
  local body status status_lc
  body=$(curl -s --max-time 10 "$url" 2>/dev/null || echo "")
  if [[ -z "$body" ]]; then
    fail "$name" "No response from health endpoint"
    return
  fi
  status=$(echo "$body" | jq -r '.status // .ok // empty' 2>/dev/null || echo "")
  status_lc=$(echo "$status" | tr '[:upper:]' '[:lower:]')
  if [[ "$status_lc" == "ok" || "$status_lc" == "true" || "$status_lc" == "healthy" || "$status_lc" == "online" ]]; then
    pass "$name" "Status: $status"
  else
    warn "$name" "Status unclear: $(echo "$body" | head -c 100)"
  fi
}

# Check markets are mainnet only
check_market_network_isolation() {
  local url="$API_URL/api/markets"
  local body devnet_count total_count
  body=$(curl -s --max-time 10 "$url" 2>/dev/null || echo "[]")

  # Count total markets
  total_count=$(echo "$body" | jq 'length' 2>/dev/null || echo "0")

  # Count devnet markets (should be 0 on mainnet)
  devnet_count=$(echo "$body" | jq '[.[] | select(.network == "devnet")] | length' 2>/dev/null || echo "0")

  if [[ "$devnet_count" -eq 0 ]] && [[ "$total_count" -gt 0 ]]; then
    pass "Market isolation" "$total_count mainnet markets, 0 devnet"
  elif [[ "$total_count" -eq 0 ]]; then
    fail "Market isolation" "No markets returned"
  else
    fail "Market isolation" "$devnet_count devnet markets found in mainnet response"
  fi
}

# Check oracle prices are active (using index_price field)
check_oracle_prices() {
  local url="$API_URL/api/markets"
  local body active_oracle stale_oracle
  body=$(curl -s --max-time 10 "$url" 2>/dev/null || echo "[]")

  # Count markets with active index prices (primary oracle field)
  active_oracle=$(echo "$body" | jq '[.[] | select(.index_price != null and .index_price > 0)] | length' 2>/dev/null || echo "0")
  stale_oracle=$(echo "$body" | jq '[.[] | select(.index_price == null or .index_price == 0)] | length' 2>/dev/null || echo "0")

  if [[ "$active_oracle" -gt 0 ]]; then
    pass "Oracle prices" "$active_oracle markets with active prices"
  else
    fail "Oracle prices" "No markets with oracle prices (migration may not have run)"
  fi

  if [[ "$stale_oracle" -gt 0 ]]; then
    warn "Oracle prices" "$stale_oracle markets missing oracle prices"
  fi
}

# Check auth is required on protected endpoints
check_auth_guards() {
  local url="$API_URL/api/admin/bugs"
  local status
  status=$(curl -s -o /dev/null -w "%{http_code}" -X GET "$url" \
    -H "Content-Type: application/json" \
    --max-time 5 2>/dev/null || echo "000")

  if [[ "$status" == "401" || "$status" == "403" ]]; then
    pass "Auth guards" "Admin endpoints require authentication (HTTP $status)"
  else
    warn "Auth guards" "Admin endpoint returned HTTP $status (should be 401/403 without auth)"
  fi
}

# Check CORS headers
check_cors_headers() {
  local url="$API_URL/api/health"
  local cors_origin cors_methods
  cors_origin=$(curl -s -i --max-time 5 "$url" 2>/dev/null | grep -i "access-control-allow-origin" | head -1 || echo "")
  cors_methods=$(curl -s -i --max-time 5 "$url" 2>/dev/null | grep -i "access-control-allow-methods" | head -1 || echo "")

  if [[ -z "$cors_origin" ]]; then
    pass "CORS headers" "No CORS header present"
  elif echo "$cors_origin" | grep -qi '\*'; then
    fail "CORS headers" "Wildcard CORS detected: ${cors_origin:0:80}"
  else
    pass "CORS headers" "Restricted CORS origin configured: ${cors_origin:0:80}"
  fi
}

# Check rate limiting headers
check_rate_limiting() {
  local url="$API_URL/api/markets"
  local rate_limit rate_limit_remaining

  for i in {1..5}; do
    rate_limit=$(curl -s -i --max-time 5 "$url" 2>/dev/null | grep -i "ratelimit-limit" | head -1 || echo "")
    if [[ -n "$rate_limit" ]]; then
      pass "Rate limiting" "Rate limit headers present"
      return
    fi
  done

  warn "Rate limiting" "No rate limit headers detected (may be using IP-based limiting)"
}

# WebSocket connectivity
check_websocket() {
  if command -v websocat &>/dev/null; then
    local ws_url="${API_URL/https:/wss:}/ws"
    if timeout 5 websocat -1 "$ws_url" </dev/null &>/dev/null 2>&1; then
      pass "WebSocket" "WebSocket endpoint responds"
    else
      warn "WebSocket" "WebSocket connection failed (may require authentication)"
    fi
  else
    warn "WebSocket" "websocat not installed — skipping test"
  fi
}

# Main verification flow
echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║   Percolator Mainnet Enhanced Verification                ║"
echo "║   $(date -u '+%Y-%m-%d %H:%M:%S UTC')                            ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# --- 1. Frontend ---
echo "${BLUE}1. Frontend Verification${NC}"
check_http "Frontend loads" "$FRONTEND_URL"
echo ""

# --- 2. API Service ---
echo "${BLUE}2. API Service Verification${NC}"
check_http "API /api/health" "$API_URL/api/health"
check_json_array "API /api/markets" "$API_URL/api/markets"
check_market_network_isolation
check_oracle_prices
check_auth_guards
check_cors_headers
check_rate_limiting
echo ""

# --- 3. Keeper Service ---
echo "${BLUE}3. Keeper Service Verification${NC}"
check_http "Keeper health endpoint" "$KEEPER_URL/health"
check_health_json "Keeper health status" "$KEEPER_URL/health"
echo ""

# --- 4. Indexer Service ---
echo "${BLUE}4. Indexer Service Verification${NC}"
check_http "Indexer health endpoint" "$INDEXER_URL/health"
check_health_json "Indexer health status" "$INDEXER_URL/health"
echo ""

# --- 5. WebSocket ---
echo "${BLUE}5. WebSocket Connectivity${NC}"
check_websocket
echo ""

# --- 6. Trade Flow Test (optional) ---
if [[ $INCLUDE_TRADE_TEST -eq 1 ]]; then
  echo "${BLUE}6. Trade Flow Test${NC}"
  run_trade_test || exit 1
  echo ""
fi

# --- Summary ---
echo "╔════════════════════════════════════════════════════════════╗"
printf "║  Results: ${GREEN}$PASS passed${NC}, ${YELLOW}$WARN warnings${NC}, ${RED}$FAIL failed${NC}\n"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

if [[ $FAIL -gt 0 ]]; then
  echo "${RED}⛔ VERIFICATION FAILED${NC} — $FAIL check(s) failed"
  echo "Review errors above. Check Railway logs and service health."
  exit 1
fi

if [[ $WARN -gt 0 ]]; then
  echo "${YELLOW}⚠️  VERIFICATION OK WITH WARNINGS${NC} — Review warnings above"
  exit 0
fi

echo "${GREEN}🎉 All checks passed! Mainnet services are healthy.${NC}"
echo ""
echo "Next steps:"
echo "  1. Execute end-to-end trade test: npx tsx scripts/e2e-open-close-position.ts"
echo "  2. Monitor Sentry for errors: https://sentry.io/organizations/dcc-pz/"
echo "  3. Check keeper logs: railway logs -n 50 --service percolator-keeper-mainnet"
exit 0
