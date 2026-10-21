#!/bin/sh
# First start of the PostgreSQL container (docker-entrypoint-initdb.d, empty data volume only):
# creates the intuit_owner and intuit_app roles and the application database by running the
# unchanged apps/api/src/database/bootstrap.sql, which needs its values as psql variables.
#
# Values come from the container environment (see deploy/docker-compose.prod.yml):
#   INTUIT_DB_NAME, INTUIT_OWNER_PASSWORD, INTUIT_APP_PASSWORD
# They must be the same database name and passwords as in DATABASE_URL (intuit_app) and
# DATABASE_MIGRATION_URL (intuit_owner). Nothing is echoed; do not enable shell tracing here.
#
# The entrypoint may source this file instead of executing it, so it does not change shell
# options. bootstrap.sql is idempotent: re-running it (for example to create a restore target with
# INTUIT_DB_NAME overridden) resets the two role passwords to the same values.

psql -v ON_ERROR_STOP=1 \
  --username "${POSTGRES_USER:-postgres}" \
  --dbname postgres \
  -v db_name="${INTUIT_DB_NAME:?INTUIT_DB_NAME is not set}" \
  -v owner_password="${INTUIT_OWNER_PASSWORD:?INTUIT_OWNER_PASSWORD is not set}" \
  -v app_password="${INTUIT_APP_PASSWORD:?INTUIT_APP_PASSWORD is not set}" \
  -f /intuit-bootstrap/bootstrap.sql
