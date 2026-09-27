-- Intuit 2.0 — local database bootstrap (run ONCE as a PostgreSQL superuser, e.g. `postgres`).
--
-- Creates the approved database roles and the development database:
--   intuit_owner  owns the schema and runs migrations
--   intuit_app    runtime application role (least privilege; no UPDATE/DELETE on audit tables)
--
-- Passwords are supplied as psql variables and are never stored in this file:
--   psql -U postgres -h localhost -v db_name=intuit2_dev \
--        -v owner_password=... -v app_password=... -f bootstrap.sql
-- `pnpm db:bootstrap` runs this for you using the values in your git-ignored .env.
--
-- Idempotent: safe to run again (it resets the two role passwords to the supplied values).

\set ON_ERROR_STOP on

SELECT format('CREATE ROLE intuit_owner LOGIN PASSWORD %L', :'owner_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'intuit_owner') \gexec
SELECT format('ALTER ROLE intuit_owner WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD %L', :'owner_password') \gexec

SELECT format('CREATE ROLE intuit_app LOGIN PASSWORD %L', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'intuit_app') \gexec
SELECT format('ALTER ROLE intuit_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD %L', :'app_password') \gexec

SELECT format('CREATE DATABASE %I OWNER intuit_owner ENCODING ''UTF8''', :'db_name')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db_name') \gexec
SELECT format('ALTER DATABASE %I OWNER TO intuit_owner', :'db_name') \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'db_name') \gexec
SELECT format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO intuit_app', :'db_name') \gexec
SELECT format('GRANT CONNECT, TEMPORARY, CREATE ON DATABASE %I TO intuit_owner', :'db_name') \gexec

\connect :db_name

ALTER SCHEMA public OWNER TO intuit_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO intuit_owner;
GRANT USAGE ON SCHEMA public TO intuit_app;

\echo 'Bootstrap complete.'
