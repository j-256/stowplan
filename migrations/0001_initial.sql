PRAGMA foreign_keys = ON;

CREATE TABLE workspace_snapshots (
    workspace_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    state_json TEXT NOT NULL CHECK (json_valid(state_json)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE users (
    user_id TEXT PRIMARY KEY,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    display_name TEXT NOT NULL,
    global_role TEXT NOT NULL DEFAULT 'user' CHECK (global_role IN ('admin', 'user')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_seen_at TEXT
) STRICT;

CREATE TABLE identities (
    identity_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    provider_subject TEXT NOT NULL,
    email TEXT NOT NULL COLLATE NOCASE,
    created_at TEXT NOT NULL,
    last_used_at TEXT NOT NULL,
    UNIQUE (provider, provider_subject)
) STRICT;

CREATE INDEX identities_user_id_idx ON identities(user_id);

CREATE TABLE workspace_members (
    workspace_id TEXT NOT NULL REFERENCES workspace_snapshots(workspace_id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, user_id)
) STRICT;

CREATE INDEX workspace_members_user_id_idx ON workspace_members(user_id);

CREATE TABLE sessions (
    session_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    revoked_at TEXT,
    user_agent TEXT,
    ip_prefix TEXT
) STRICT;

CREATE INDEX sessions_user_id_idx ON sessions(user_id);
CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);

CREATE TABLE guest_links (
    guest_link_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspace_snapshots(workspace_id) ON DELETE CASCADE,
    created_by_user_id TEXT NOT NULL REFERENCES users(user_id),
    token_hash TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    revoked_at TEXT
) STRICT;

CREATE INDEX guest_links_workspace_id_idx ON guest_links(workspace_id);
CREATE INDEX guest_links_expires_at_idx ON guest_links(expires_at);

CREATE TABLE oauth_states (
    state_hash TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    verifier_ciphertext TEXT NOT NULL,
    return_to TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT
) STRICT;

CREATE INDEX oauth_states_expires_at_idx ON oauth_states(expires_at);

CREATE TABLE auth_audit_events (
    event_id TEXT PRIMARY KEY,
    actor_user_id TEXT REFERENCES users(user_id),
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT,
    detail_json TEXT NOT NULL CHECK (json_valid(detail_json)),
    created_at TEXT NOT NULL,
    ip_prefix TEXT
) STRICT;

CREATE INDEX auth_audit_created_at_idx ON auth_audit_events(created_at DESC);
CREATE INDEX auth_audit_actor_idx ON auth_audit_events(actor_user_id);
