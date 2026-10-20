#!/bin/sh
# A real restore drill: dump a source database, restore the dump into a SEPARATE empty database and
# prove the restored copy is the same data and still obeys its rules. A backup is not counted as
# recoverable until this has passed.
#
#   SOURCE_URL=postgres://intuit_owner:...@host:5432/intuit2_dev \
#   TARGET_URL=postgres://intuit_owner:...@host:5432/intuit2_restore_drill \
#   sh deploy/restore-drill.sh
#
# The target database must already exist and be EMPTY, owned by (or usable by) intuit_owner. Creating
# it needs a PostgreSQL superuser, once:
#
#   psql -U postgres -c "CREATE DATABASE intuit2_restore_drill OWNER intuit_owner"
#
# Steps: pg_dump (custom format) -> pg_restore --list (table of contents) -> restore.sh into the
# target -> deploy/restore-validate.mjs (row counts of every table, ledger balance, inventory and
# row-level-security checks, migration checksums). Exit 0 only if everything matches.
set -eu
: "${SOURCE_URL:?set SOURCE_URL}"
: "${TARGET_URL:?set TARGET_URL (an empty database)}"
here=$(cd "$(dirname "$0")" && pwd)
dump="${DUMP_FILE:-${TMPDIR:-/tmp}/restore-drill-$(date +%Y%m%dT%H%M%S).dump}"
started=$(date +%s)
echo "1/4 dumping the source to $dump"
pg_dump --format=custom --no-owner --file="$dump" "$SOURCE_URL"
echo "2/4 verifying the dump's table of contents"
entries=$(pg_restore --list "$dump" | wc -l)
[ "$entries" -gt 100 ] || { echo "DRILL FAILED: the dump looks empty ($entries entries)" >&2; exit 1; }
echo "3/4 restoring into the target"
TARGET_URL="$TARGET_URL" sh "$here/restore.sh" "$dump"
echo "4/4 validating the restored database against the source"
SOURCE_URL="$SOURCE_URL" TARGET_URL="$TARGET_URL" node "$here/restore-validate.mjs"
echo "Restore drill PASSED in $(( $(date +%s) - started )) s (dump kept at $dump)"
