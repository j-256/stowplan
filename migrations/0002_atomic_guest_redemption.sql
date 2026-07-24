DROP INDEX IF EXISTS auth_audit_created_at_idx;

CREATE INDEX auth_audit_created_at_idx
ON auth_audit_events(created_at DESC);

ALTER TABLE guest_links ADD COLUMN redemption_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS guest_links_redemption_id_idx
ON guest_links(redemption_id);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx
ON users(lower(email));

CREATE UNIQUE INDEX IF NOT EXISTS identities_provider_subject_idx
ON identities(provider, provider_subject);

CREATE UNIQUE INDEX IF NOT EXISTS sessions_token_hash_idx
ON sessions(token_hash);

CREATE UNIQUE INDEX IF NOT EXISTS guest_links_token_hash_idx
ON guest_links(token_hash);
