#!/bin/sh
# Logical backup of the Intuit 2.0 database and the stored files.
#
#   DATABASE_MIGRATION_URL=postgres://intuit_owner:...@host:5432/intuit2 \
#   FILES_DIR=/data/storage BACKUP_DIR=/backups sh deploy/backup.sh
#
# Writes <BACKUP_DIR>/intuit2-<UTC timestamp>.dump (pg_dump custom format) and, when FILES_DIR is
# set, <BACKUP_DIR>/intuit2-files-<timestamp>.tar.gz. Keep them off the database host. A backup is
# only a backup once a restore has been tested: run deploy/restore.sh against a scratch database.
set -eu
: "${DATABASE_MIGRATION_URL:?set DATABASE_MIGRATION_URL (the owner role)}"
: "${BACKUP_DIR:?set BACKUP_DIR}"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$BACKUP_DIR"
umask 077
pg_dump --format=custom --no-owner --file="$BACKUP_DIR/intuit2-$stamp.dump" "$DATABASE_MIGRATION_URL"
if [ -n "${FILES_DIR:-}" ]; then
  tar -czf "$BACKUP_DIR/intuit2-files-$stamp.tar.gz" -C "$FILES_DIR" .
fi
# Verify the archive is readable (catches a truncated dump).
pg_restore --list "$BACKUP_DIR/intuit2-$stamp.dump" > /dev/null
echo "Backup written: $BACKUP_DIR/intuit2-$stamp.dump"
# Retention: keep BACKUP_KEEP_DAYS days (default 14) of dumps in this directory.
find "$BACKUP_DIR" -name 'intuit2-*' -mtime +"${BACKUP_KEEP_DAYS:-14}" -delete
