#!/bin/sh
# Restores a dump made by deploy/backup.sh into a TARGET database. It refuses to touch a database
# that already contains tables unless RESTORE_FORCE=yes, so a restore drill cannot overwrite live
# data by accident.
#
#   TARGET_URL=postgres://intuit_owner:...@host:5432/intuit2_restore \
#   sh deploy/restore.sh /backups/intuit2-20261017T000000Z.dump
#
# The target database and the roles intuit_owner / intuit_app must already exist (see
# apps/api/src/database/bootstrap.sql). After a restore, run the application's health check and
# `node dist/src/database/cli/migrate.js` (it applies nothing when the dump is current).
set -eu
dump=${1:?usage: restore.sh <dump file>}
: "${TARGET_URL:?set TARGET_URL (the owner role, on the database to restore into)}"
existing=$(psql -Atc "select count(*) from information_schema.tables where table_schema = 'public'" "$TARGET_URL")
if [ "$existing" != "0" ] && [ "${RESTORE_FORCE:-no}" != "yes" ]; then
  echo "The target database already has $existing tables. Use an empty database, or set RESTORE_FORCE=yes." >&2
  exit 2
fi
pg_restore --no-owner --role=intuit_owner --dbname="$TARGET_URL" "$dump"
psql -Atc "select 'migrations applied: ' || count(*) from schema_migrations" "$TARGET_URL"
echo "Restore finished."
