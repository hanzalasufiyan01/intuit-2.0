-- 0064_storage_provider_s3 — files may be stored in an S3-compatible object store (FP-19).
--
-- The provider that holds a file is recorded on each file row. This migration only widens the
-- allowed values; existing rows stay 'local'. The storage key format (org/{org}/{yyyy}/{mm}/{id})
-- is unchanged, so a deployment can move files between providers by copying objects and updating
-- the provider column.

ALTER TABLE files DROP CONSTRAINT files_storage_provider_check;
ALTER TABLE files ADD CONSTRAINT files_storage_provider_check
  CHECK (storage_provider IN ('local', 's3'));
