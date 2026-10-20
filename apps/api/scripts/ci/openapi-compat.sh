#!/bin/sh
# Provider-neutral CI step: OpenAPI compatibility check (docs/openapi-compatibility.md).
#
#   BASE_REF=origin/main sh apps/api/scripts/ci/openapi-compat.sh
#
# BASE_REF is the revision the change will be merged into. The checkout must contain it (a shallow
# clone usually does not: fetch the base branch first). Exit codes: 0 compatible, 1 stale baseline
# or breaking change, 2 the check could not run. No CI provider is assumed or configured here.
set -eu

: "${BASE_REF:?Set BASE_REF to the target revision, for example origin/main}"

if ! git rev-parse --verify --quiet "${BASE_REF}^{commit}" >/dev/null; then
  echo "BASE_REF '${BASE_REF}' is not available in this checkout. Fetch it first (for example: git fetch origin main)." >&2
  exit 2
fi

pnpm install --frozen-lockfile
pnpm openapi:check -- --base-ref "${BASE_REF}"
