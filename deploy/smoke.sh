#!/bin/sh
# Post-deployment smoke test against a running instance.
#
#   BASE_URL=https://app.example.com sh deploy/smoke.sh
#
# Checks the health endpoint (database reachable), the security headers and that the SPA is served.
# It creates nothing. Exit 0 = all checks passed.
set -eu
: "${BASE_URL:?set BASE_URL}"
fail() { echo "SMOKE FAILED: $1" >&2; exit 1; }
health=$(curl -fsS "$BASE_URL/api/v1/health") || fail "health endpoint unreachable"
echo "$health" | grep -q '"database":"ok"' || fail "database is not ok: $health"
headers=$(curl -fsSI "$BASE_URL/") || fail "web app unreachable"
echo "$headers" | grep -qi 'x-frame-options: DENY' || fail "x-frame-options header missing"
curl -fsS "$BASE_URL/" | grep -qi '<div id="root"' || fail "the SPA shell is not served"
status=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/api/v1/organizations/current")
[ "$status" = "401" ] || fail "an unauthenticated API call answered $status, expected 401"
echo "Smoke test passed."
