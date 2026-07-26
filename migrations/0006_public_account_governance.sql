PRAGMA defer_foreign_keys = ON;

DROP TRIGGER workspace_members_insert_revisions;
DROP TRIGGER workspace_members_role_revisions;
DROP TRIGGER workspace_members_delete_revisions;
DROP TRIGGER workspace_snapshots_access_revision_insert_guard;
DROP TRIGGER workspace_snapshots_access_revision_update_guard;

CREATE TABLE stowplan_auth_audit_events_backup AS
SELECT * FROM auth_audit_events;

CREATE TABLE stowplan_guest_links_backup AS
SELECT * FROM guest_links;

CREATE TABLE stowplan_identities_backup AS
SELECT * FROM identities;

CREATE TABLE stowplan_sessions_backup AS
SELECT * FROM sessions;

CREATE TABLE stowplan_workspace_members_backup AS
SELECT * FROM workspace_members;

DROP TABLE auth_audit_events;
DROP TABLE guest_links;
DROP TABLE identities;
DROP TABLE sessions;
DROP TABLE workspace_members;

CREATE TABLE users_governance_new (
    user_id TEXT PRIMARY KEY,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    display_name TEXT NOT NULL,
    global_role TEXT NOT NULL DEFAULT 'user'
        CHECK (global_role IN ('admin', 'user')),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'banned', 'disabled')),
    account_revision INTEGER NOT NULL DEFAULT 0,
    membership_revision INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_seen_at TEXT,
    deleted_at TEXT
) STRICT;

INSERT INTO users_governance_new(
    user_id,
    email,
    display_name,
    global_role,
    status,
    account_revision,
    membership_revision,
    created_at,
    updated_at,
    last_seen_at,
    deleted_at
)
SELECT
    user_id,
    email,
    display_name,
    global_role,
    status,
    0,
    membership_revision,
    created_at,
    updated_at,
    last_seen_at,
    NULL
FROM users;

DROP TABLE users;
ALTER TABLE users_governance_new RENAME TO users;

CREATE UNIQUE INDEX users_email_idx
ON users(lower(email));

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

INSERT INTO identities
SELECT * FROM stowplan_identities_backup;

CREATE INDEX identities_user_id_idx ON identities(user_id);

CREATE UNIQUE INDEX identities_provider_subject_idx
ON identities(provider, provider_subject);

CREATE TABLE workspace_members (
    workspace_id TEXT NOT NULL
        REFERENCES workspace_snapshots(workspace_id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, user_id)
) STRICT;

INSERT INTO workspace_members
SELECT * FROM stowplan_workspace_members_backup;

CREATE INDEX workspace_members_user_id_idx
ON workspace_members(user_id);

CREATE TABLE sessions (
    session_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    revoked_at TEXT,
    user_agent TEXT,
    ip_prefix TEXT,
    replaced_by_session_id TEXT,
    reauthenticated_at TEXT,
    authentication_provider TEXT
) STRICT;

INSERT INTO sessions(
    session_id,
    user_id,
    token_hash,
    created_at,
    expires_at,
    last_seen_at,
    revoked_at,
    user_agent,
    ip_prefix,
    replaced_by_session_id,
    reauthenticated_at,
    authentication_provider
)
SELECT
    session_id,
    user_id,
    token_hash,
    created_at,
    expires_at,
    last_seen_at,
    revoked_at,
    user_agent,
    ip_prefix,
    NULL,
    NULL,
    NULL
FROM stowplan_sessions_backup;

CREATE INDEX sessions_user_id_idx ON sessions(user_id);
CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);

CREATE UNIQUE INDEX sessions_token_hash_idx
ON sessions(token_hash);

CREATE TABLE guest_links (
    guest_link_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL
        REFERENCES workspace_snapshots(workspace_id) ON DELETE CASCADE,
    created_by_user_id TEXT NOT NULL REFERENCES users(user_id),
    token_hash TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    revoked_at TEXT,
    redemption_id TEXT
) STRICT;

INSERT INTO guest_links
SELECT * FROM stowplan_guest_links_backup;

CREATE INDEX guest_links_workspace_id_idx
ON guest_links(workspace_id);

CREATE INDEX guest_links_expires_at_idx
ON guest_links(expires_at);

CREATE UNIQUE INDEX guest_links_token_hash_idx
ON guest_links(token_hash);

CREATE UNIQUE INDEX guest_links_redemption_id_idx
ON guest_links(redemption_id);

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

INSERT INTO auth_audit_events
SELECT * FROM stowplan_auth_audit_events_backup;

CREATE INDEX auth_audit_created_at_idx
ON auth_audit_events(created_at DESC);

CREATE INDEX auth_audit_actor_idx
ON auth_audit_events(actor_user_id);

DROP TABLE stowplan_auth_audit_events_backup;
DROP TABLE stowplan_guest_links_backup;
DROP TABLE stowplan_identities_backup;
DROP TABLE stowplan_sessions_backup;
DROP TABLE stowplan_workspace_members_backup;

ALTER TABLE workspace_snapshots
ADD COLUMN stored_bytes INTEGER NOT NULL DEFAULT 0
    CHECK (stored_bytes >= 0);

UPDATE workspace_snapshots
SET stored_bytes = length(CAST(state_json AS BLOB));

CREATE TABLE workspace_custody (
    workspace_id TEXT PRIMARY KEY
        REFERENCES workspace_snapshots(workspace_id) ON DELETE CASCADE,
    custodian_user_id TEXT NOT NULL REFERENCES users(user_id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX workspace_custody_user_id_idx
ON workspace_custody(custodian_user_id);

INSERT INTO workspace_custody(
    workspace_id,
    custodian_user_id,
    created_at,
    updated_at
)
SELECT
    snapshot.workspace_id,
    (
        SELECT owner.user_id
        FROM workspace_members owner
        WHERE owner.workspace_id = snapshot.workspace_id
          AND owner.role = 'owner'
        ORDER BY owner.created_at, owner.user_id
        LIMIT 1
    ),
    snapshot.created_at,
    snapshot.updated_at
FROM workspace_snapshots snapshot
WHERE EXISTS (
    SELECT 1
    FROM workspace_members owner
    WHERE owner.workspace_id = snapshot.workspace_id
      AND owner.role = 'owner'
);

CREATE TABLE creation_ledger (
    event_id TEXT PRIMARY KEY,
    scope_type TEXT NOT NULL
        CHECK (scope_type IN ('account', 'installation')),
    scope_id TEXT NOT NULL,
    resource TEXT NOT NULL
        CHECK (resource IN ('account', 'guest_link', 'session', 'workspace')),
    created_at TEXT NOT NULL
) STRICT;

CREATE INDEX creation_ledger_scope_resource_created_idx
ON creation_ledger(scope_type, scope_id, resource, created_at);

INSERT INTO creation_ledger(
    event_id,
    scope_type,
    scope_id,
    resource,
    created_at
)
SELECT
    'account:' || user_id,
    'installation',
    'installation',
    'account',
    created_at
FROM users;

INSERT INTO creation_ledger(
    event_id,
    scope_type,
    scope_id,
    resource,
    created_at
)
SELECT
    'workspace:' || workspace_id,
    'account',
    custodian_user_id,
    'workspace',
    created_at
FROM workspace_custody;

INSERT INTO creation_ledger(
    event_id,
    scope_type,
    scope_id,
    resource,
    created_at
)
SELECT
    'session:' || session_id,
    'account',
    user_id,
    'session',
    created_at
FROM sessions;

INSERT INTO creation_ledger(
    event_id,
    scope_type,
    scope_id,
    resource,
    created_at
)
SELECT
    'guest_link:' || guest_link_id,
    'account',
    created_by_user_id,
    'guest_link',
    created_at
FROM guest_links;

CREATE TABLE circuit_breakers (
    scope TEXT PRIMARY KEY
        CHECK (
            scope IN (
                'guest_links',
                'guest_redemptions',
                'new_accounts',
                'new_workspaces',
                'snapshot_growth'
            )
        ),
    state TEXT NOT NULL DEFAULT 'open'
        CHECK (state IN ('open', 'paused')),
    reason TEXT,
    updated_at TEXT NOT NULL,
    updated_by_user_id TEXT REFERENCES users(user_id),
    pause_kind TEXT NOT NULL DEFAULT 'security'
        CHECK (pause_kind IN ('capacity', 'security')),
    resume_at TEXT,
    trigger_count INTEGER NOT NULL DEFAULT 0
        CHECK (trigger_count >= 0)
) STRICT;

INSERT INTO circuit_breakers(
    scope,
    state,
    reason,
    updated_at,
    updated_by_user_id,
    pause_kind,
    resume_at,
    trigger_count
)
VALUES
    ('guest_links', 'open', NULL, '1970-01-01T00:00:00.000Z', NULL, 'security', NULL, 0),
    ('guest_redemptions', 'open', NULL, '1970-01-01T00:00:00.000Z', NULL, 'security', NULL, 0),
    ('new_accounts', 'open', NULL, '1970-01-01T00:00:00.000Z', NULL, 'security', NULL, 0),
    ('new_workspaces', 'open', NULL, '1970-01-01T00:00:00.000Z', NULL, 'capacity', NULL, 0),
    ('snapshot_growth', 'open', NULL, '1970-01-01T00:00:00.000Z', NULL, 'capacity', NULL, 0);

CREATE TABLE governance_limits (
    limit_key TEXT PRIMARY KEY
        CHECK (limit_key IN ('new_accounts_per_day')),
    limit_value INTEGER NOT NULL
        CHECK (limit_value >= 0 AND limit_value <= 1000000),
    updated_at TEXT NOT NULL,
    updated_by_user_id TEXT REFERENCES users(user_id)
) STRICT;

INSERT INTO governance_limits(
    limit_key,
    limit_value,
    updated_at,
    updated_by_user_id
)
VALUES (
    'new_accounts_per_day',
    25,
    '1970-01-01T00:00:00.000Z',
    NULL
);

CREATE TABLE identity_ban_digests (
    identity_digest TEXT PRIMARY KEY,
    source_user_id TEXT REFERENCES users(user_id),
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL,
    created_by_user_id TEXT REFERENCES users(user_id),
    lifted_at TEXT,
    lifted_by_user_id TEXT REFERENCES users(user_id)
) STRICT;

CREATE INDEX identity_ban_digests_source_user_idx
ON identity_ban_digests(source_user_id);

CREATE TABLE account_deletion_receipts (
    deletion_id TEXT PRIMARY KEY,
    account_digest TEXT NOT NULL,
    deleted_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX account_deletion_receipts_account_digest_idx
ON account_deletion_receipts(account_digest);

CREATE TRIGGER workspace_snapshots_access_revision_insert_guard
BEFORE INSERT ON workspace_snapshots
WHEN typeof(NEW.access_revision) <> 'integer'
    OR NEW.access_revision < 0
    OR NEW.access_revision > 9007199254740991
BEGIN
    SELECT RAISE(
        ABORT,
        'workspace access revision must remain JavaScript-safe and monotonic'
    );
END;

CREATE TRIGGER workspace_snapshots_access_revision_update_guard
BEFORE UPDATE OF access_revision ON workspace_snapshots
WHEN typeof(NEW.access_revision) <> 'integer'
    OR NEW.access_revision < 0
    OR NEW.access_revision < OLD.access_revision
    OR NEW.access_revision > 9007199254740991
BEGIN
    SELECT RAISE(
        ABORT,
        'workspace access revision must remain JavaScript-safe and monotonic'
    );
END;

CREATE TRIGGER users_membership_revision_insert_guard
BEFORE INSERT ON users
WHEN typeof(NEW.account_revision) <> 'integer'
    OR NEW.account_revision < 0
    OR NEW.account_revision > 9007199254740991
    OR typeof(NEW.membership_revision) <> 'integer'
    OR NEW.membership_revision < 0
    OR NEW.membership_revision > 9007199254740991
BEGIN
    SELECT RAISE(
        ABORT,
        'user membership revision must remain JavaScript-safe and monotonic'
    );
END;

CREATE TRIGGER users_account_revision_update_guard
BEFORE UPDATE OF account_revision ON users
WHEN typeof(NEW.account_revision) <> 'integer'
    OR NEW.account_revision < 0
    OR NEW.account_revision < OLD.account_revision
    OR NEW.account_revision > 9007199254740991
BEGIN
    SELECT RAISE(
        ABORT,
        'user account revision must remain JavaScript-safe and monotonic'
    );
END;

CREATE TRIGGER users_membership_revision_update_guard
BEFORE UPDATE OF membership_revision ON users
WHEN typeof(NEW.membership_revision) <> 'integer'
    OR NEW.membership_revision < 0
    OR NEW.membership_revision < OLD.membership_revision
    OR NEW.membership_revision > 9007199254740991
BEGIN
    SELECT RAISE(
        ABORT,
        'user membership revision must remain JavaScript-safe and monotonic'
    );
END;

CREATE TRIGGER users_account_revision_updates
AFTER UPDATE OF email, display_name, global_role, status, deleted_at ON users
WHEN OLD.email IS NOT NEW.email
    OR OLD.display_name IS NOT NEW.display_name
    OR OLD.global_role IS NOT NEW.global_role
    OR OLD.status IS NOT NEW.status
    OR OLD.deleted_at IS NOT NEW.deleted_at
BEGIN
    UPDATE users
    SET account_revision = account_revision + 1
    WHERE user_id = NEW.user_id;
END;

CREATE TRIGGER identities_insert_account_revision
AFTER INSERT ON identities
BEGIN
    UPDATE users
    SET account_revision = account_revision + 1
    WHERE user_id = NEW.user_id;
END;

CREATE TRIGGER identities_update_account_revision
AFTER UPDATE OF user_id, provider, provider_subject, email ON identities
WHEN OLD.user_id IS NOT NEW.user_id
    OR OLD.provider IS NOT NEW.provider
    OR OLD.provider_subject IS NOT NEW.provider_subject
    OR OLD.email IS NOT NEW.email
BEGIN
    UPDATE users
    SET account_revision = account_revision + 1
    WHERE user_id IN (OLD.user_id, NEW.user_id);
END;

CREATE TRIGGER identities_delete_account_revision
AFTER DELETE ON identities
BEGIN
    UPDATE users
    SET account_revision = account_revision + 1
    WHERE user_id = OLD.user_id;
END;

CREATE TRIGGER users_status_revisions
AFTER UPDATE OF status ON users
WHEN OLD.status IS NOT NEW.status
BEGIN
    UPDATE users
    SET membership_revision = membership_revision + 1
    WHERE user_id = NEW.user_id;

    UPDATE workspace_snapshots
    SET access_revision = access_revision + 1
    WHERE workspace_id IN (
        SELECT workspace_id
        FROM workspace_members
        WHERE user_id = NEW.user_id
    );
END;

CREATE TRIGGER workspace_members_insert_revisions
AFTER INSERT ON workspace_members
BEGIN
    UPDATE users
    SET membership_revision = membership_revision + 1
    WHERE user_id = NEW.user_id;

    UPDATE workspace_snapshots
    SET access_revision = access_revision + 1
    WHERE workspace_id = NEW.workspace_id;
END;

CREATE TRIGGER workspace_members_role_revisions
AFTER UPDATE OF role ON workspace_members
WHEN OLD.role IS NOT NEW.role
BEGIN
    UPDATE users
    SET membership_revision = membership_revision + 1
    WHERE user_id = NEW.user_id;

    UPDATE workspace_snapshots
    SET access_revision = access_revision + 1
    WHERE workspace_id = NEW.workspace_id;
END;

CREATE TRIGGER workspace_members_delete_revisions
AFTER DELETE ON workspace_members
BEGIN
    UPDATE users
    SET membership_revision = membership_revision + 1
    WHERE user_id = OLD.user_id;

    UPDATE workspace_snapshots
    SET access_revision = access_revision + 1
    WHERE workspace_id = OLD.workspace_id;
END;

CREATE TRIGGER guest_links_insert_access_revision
AFTER INSERT ON guest_links
BEGIN
    UPDATE workspace_snapshots
    SET access_revision = access_revision + 1
    WHERE workspace_id = NEW.workspace_id;
END;

CREATE TRIGGER guest_links_update_access_revision
AFTER UPDATE OF role, expires_at, consumed_at, revoked_at ON guest_links
WHEN OLD.role IS NOT NEW.role
    OR OLD.expires_at IS NOT NEW.expires_at
    OR OLD.consumed_at IS NOT NEW.consumed_at
    OR OLD.revoked_at IS NOT NEW.revoked_at
BEGIN
    UPDATE workspace_snapshots
    SET access_revision = access_revision + 1
    WHERE workspace_id = NEW.workspace_id;
END;

CREATE TRIGGER guest_links_delete_access_revision
AFTER DELETE ON guest_links
BEGIN
    UPDATE workspace_snapshots
    SET access_revision = access_revision + 1
    WHERE workspace_id = OLD.workspace_id;
END;

CREATE TRIGGER users_last_admin_role_guard
BEFORE UPDATE OF global_role ON users
WHEN OLD.global_role = 'admin'
    AND OLD.status = 'active'
    AND OLD.deleted_at IS NULL
    AND NEW.global_role <> 'admin'
    AND (
        SELECT COUNT(*)
        FROM users
        WHERE global_role = 'admin'
          AND status = 'active'
          AND deleted_at IS NULL
    ) <= 1
BEGIN
    SELECT RAISE(ABORT, 'the last active administrator must be retained');
END;

CREATE TRIGGER users_last_admin_status_guard
BEFORE UPDATE OF status, deleted_at ON users
WHEN OLD.global_role = 'admin'
    AND OLD.status = 'active'
    AND OLD.deleted_at IS NULL
    AND (
        NEW.status <> 'active'
        OR NEW.deleted_at IS NOT NULL
    )
    AND (
        SELECT COUNT(*)
        FROM users
        WHERE global_role = 'admin'
          AND status = 'active'
          AND deleted_at IS NULL
    ) <= 1
BEGIN
    SELECT RAISE(ABORT, 'the last active administrator must be retained');
END;

CREATE TRIGGER users_final_owner_status_guard
BEFORE UPDATE OF status, deleted_at ON users
WHEN OLD.status = 'active'
    AND OLD.deleted_at IS NULL
    AND (
        NEW.status <> 'active'
        OR NEW.deleted_at IS NOT NULL
    )
    AND EXISTS (
        SELECT 1
        FROM workspace_members owned
        WHERE owned.user_id = OLD.user_id
          AND owned.role = 'owner'
          AND NOT EXISTS (
              SELECT 1
              FROM workspace_deletions deleted
              WHERE deleted.workspace_id = owned.workspace_id
          )
          AND NOT EXISTS (
              SELECT 1
              FROM workspace_members other
              JOIN users other_user
                ON other_user.user_id = other.user_id
              WHERE other.workspace_id = owned.workspace_id
                AND other.user_id <> OLD.user_id
                AND other.role = 'owner'
                AND other_user.status = 'active'
                AND other_user.deleted_at IS NULL
          )
    )
BEGIN
    SELECT RAISE(ABORT, 'the last active workspace owner must be retained');
END;

CREATE TRIGGER users_last_admin_delete_guard
BEFORE DELETE ON users
WHEN OLD.global_role = 'admin'
    AND OLD.status = 'active'
    AND OLD.deleted_at IS NULL
    AND (
        SELECT COUNT(*)
        FROM users
        WHERE global_role = 'admin'
          AND status = 'active'
          AND deleted_at IS NULL
    ) <= 1
BEGIN
    SELECT RAISE(ABORT, 'the last active administrator must be retained');
END;

CREATE TRIGGER auth_audit_routine_detail_retention
AFTER INSERT ON auth_audit_events
BEGIN
    UPDATE auth_audit_events
    SET detail_json = '{}'
    WHERE event_id IN (
        SELECT event_id
        FROM auth_audit_events
        WHERE action IN ('session.issue', 'session.revoke')
          AND detail_json <> '{}'
          AND julianday(created_at) <= julianday(NEW.created_at) - 180
        ORDER BY created_at, event_id
        LIMIT 100
    );
END;

CREATE TRIGGER users_public_creation_guard
BEFORE INSERT ON users
WHEN julianday(NEW.created_at) >= julianday('now') - (1.0 / 24)
    AND (
    COALESCE(
        (
            SELECT CASE
                WHEN state = 'paused'
                    AND pause_kind = 'security'
                    AND resume_at IS NOT NULL
                    AND resume_at <= NEW.created_at
                THEN 'open'
                ELSE state
            END
            FROM circuit_breakers
            WHERE scope = 'new_accounts'
        ),
        'paused'
    ) <> 'open'
    OR (
        SELECT COUNT(*)
        FROM creation_ledger
        WHERE scope_type = 'installation'
          AND scope_id = 'installation'
          AND resource = 'account'
          AND date(created_at) = date(NEW.created_at)
    ) >= COALESCE(
        (
            SELECT limit_value
            FROM governance_limits
            WHERE limit_key = 'new_accounts_per_day'
        ),
        0
    )
    )
BEGIN
    SELECT RAISE(ABORT, 'new account creation is temporarily unavailable');
END;

CREATE TRIGGER users_public_creation_ledger
AFTER INSERT ON users
BEGIN
    INSERT INTO creation_ledger(
        event_id,
        scope_type,
        scope_id,
        resource,
        created_at
    )
    VALUES (
        'account:' || NEW.user_id,
        'installation',
        'installation',
        'account',
        NEW.created_at
    );
END;

CREATE TRIGGER workspace_snapshots_stored_bytes_insert
AFTER INSERT ON workspace_snapshots
BEGIN
    UPDATE workspace_snapshots
    SET stored_bytes = length(CAST(NEW.state_json AS BLOB))
    WHERE workspace_id = NEW.workspace_id;
END;

CREATE TRIGGER workspace_snapshots_growth_guard
BEFORE UPDATE OF state_json ON workspace_snapshots
WHEN length(CAST(NEW.state_json AS BLOB)) > OLD.stored_bytes
    AND COALESCE(
        (
            SELECT CASE
                WHEN state = 'paused'
                    AND pause_kind = 'security'
                    AND resume_at IS NOT NULL
                    AND resume_at <= NEW.updated_at
                THEN 'open'
                ELSE state
            END
            FROM circuit_breakers
            WHERE scope = 'snapshot_growth'
        ),
        'paused'
    ) <> 'open'
BEGIN
    SELECT RAISE(ABORT, 'snapshot growth is temporarily unavailable');
END;

CREATE TRIGGER workspace_snapshots_account_storage_guard
BEFORE UPDATE OF state_json ON workspace_snapshots
WHEN length(CAST(NEW.state_json AS BLOB)) > OLD.stored_bytes
    AND EXISTS (
        SELECT 1
        FROM workspace_custody custody
        WHERE custody.workspace_id = OLD.workspace_id
    )
    AND (
        SELECT COALESCE(SUM(snapshot.stored_bytes), 0)
        FROM workspace_custody custody
        JOIN workspace_snapshots snapshot
          ON snapshot.workspace_id = custody.workspace_id
        WHERE custody.custodian_user_id = (
            SELECT owner.custodian_user_id
            FROM workspace_custody owner
            WHERE owner.workspace_id = OLD.workspace_id
        )
    ) - OLD.stored_bytes + length(CAST(NEW.state_json AS BLOB)) > 8000000
BEGIN
    SELECT RAISE(ABORT, 'account snapshot storage quota exceeded');
END;

CREATE TRIGGER workspace_snapshots_stored_bytes_update
AFTER UPDATE OF state_json ON workspace_snapshots
BEGIN
    UPDATE workspace_snapshots
    SET stored_bytes = length(CAST(NEW.state_json AS BLOB))
    WHERE workspace_id = NEW.workspace_id;
END;

CREATE TRIGGER workspace_custody_insert_guard
BEFORE INSERT ON workspace_custody
WHEN COALESCE(
        (
            SELECT CASE
                WHEN state = 'paused'
                    AND pause_kind = 'security'
                    AND resume_at IS NOT NULL
                    AND resume_at <= NEW.created_at
                THEN 'open'
                ELSE state
            END
            FROM circuit_breakers
            WHERE scope = 'new_workspaces'
        ),
        'paused'
    ) <> 'open'
    OR NOT EXISTS (
        SELECT 1
        FROM users
        WHERE user_id = NEW.custodian_user_id
          AND status = 'active'
          AND deleted_at IS NULL
    )
    OR (
        SELECT COUNT(*)
        FROM workspace_custody
        WHERE custodian_user_id = NEW.custodian_user_id
    ) >= 5
    OR (
        SELECT COALESCE(SUM(snapshot.stored_bytes), 0)
        FROM workspace_custody custody
        JOIN workspace_snapshots snapshot
          ON snapshot.workspace_id = custody.workspace_id
        WHERE custody.custodian_user_id = NEW.custodian_user_id
    ) + COALESCE(
        (
            SELECT stored_bytes
            FROM workspace_snapshots
            WHERE workspace_id = NEW.workspace_id
        ),
        0
    ) > 8000000
    OR (
        SELECT COUNT(*)
        FROM creation_ledger
        WHERE scope_type = 'account'
          AND scope_id = NEW.custodian_user_id
          AND resource = 'workspace'
          AND date(created_at) = date(NEW.created_at)
    ) >= 5
    OR (
        SELECT COUNT(*)
        FROM creation_ledger
        WHERE scope_type = 'account'
          AND scope_id = NEW.custodian_user_id
          AND resource = 'workspace'
          AND julianday(created_at) >
              julianday(NEW.created_at) - 30
    ) >= 20
    OR (
        SELECT COUNT(*)
        FROM creation_ledger
        WHERE scope_type = 'account'
          AND scope_id = NEW.custodian_user_id
          AND resource = 'workspace'
    ) >= 100
BEGIN
    SELECT RAISE(ABORT, 'new workspace allocation is unavailable');
END;

CREATE TRIGGER workspace_custody_insert_ledger
AFTER INSERT ON workspace_custody
BEGIN
    INSERT INTO creation_ledger(
        event_id,
        scope_type,
        scope_id,
        resource,
        created_at
    )
    VALUES (
        'workspace:' || NEW.workspace_id,
        'account',
        NEW.custodian_user_id,
        'workspace',
        NEW.created_at
    );
END;

CREATE TRIGGER workspace_custody_transfer_guard
BEFORE UPDATE OF custodian_user_id ON workspace_custody
WHEN OLD.custodian_user_id IS NOT NEW.custodian_user_id
    AND (
        NOT EXISTS (
            SELECT 1
            FROM users
            WHERE user_id = NEW.custodian_user_id
              AND status = 'active'
              AND deleted_at IS NULL
        )
        OR (
            SELECT COUNT(*)
            FROM workspace_custody
            WHERE custodian_user_id = NEW.custodian_user_id
              AND workspace_id <> OLD.workspace_id
        ) >= 5
        OR (
            SELECT COALESCE(SUM(snapshot.stored_bytes), 0)
            FROM workspace_custody custody
            JOIN workspace_snapshots snapshot
              ON snapshot.workspace_id = custody.workspace_id
            WHERE custody.custodian_user_id = NEW.custodian_user_id
              AND custody.workspace_id <> OLD.workspace_id
        ) + (
            SELECT stored_bytes
            FROM workspace_snapshots
            WHERE workspace_id = OLD.workspace_id
        ) > 8000000
    )
BEGIN
    SELECT RAISE(ABORT, 'workspace custody recipient lacks capacity');
END;

CREATE TRIGGER workspace_members_account_quota_guard
BEFORE INSERT ON workspace_members
WHEN NOT EXISTS (
        SELECT 1
        FROM users
        WHERE user_id = NEW.user_id
          AND status = 'active'
          AND deleted_at IS NULL
    )
    OR (
        NOT EXISTS (
            SELECT 1
            FROM workspace_members existing
            WHERE existing.workspace_id = NEW.workspace_id
              AND existing.user_id = NEW.user_id
        )
        AND (
            SELECT COUNT(*)
            FROM workspace_members
            WHERE user_id = NEW.user_id
        ) >= 25
    )
BEGIN
    SELECT RAISE(ABORT, 'account membership quota exceeded');
END;

CREATE TRIGGER workspace_members_assign_initial_custody
AFTER INSERT ON workspace_members
WHEN NEW.role = 'owner'
    AND NOT EXISTS (
        SELECT 1
        FROM workspace_custody
        WHERE workspace_id = NEW.workspace_id
    )
BEGIN
    INSERT INTO workspace_custody(
        workspace_id,
        custodian_user_id,
        created_at,
        updated_at
    )
    VALUES (
        NEW.workspace_id,
        NEW.user_id,
        NEW.created_at,
        NEW.created_at
    );
END;

CREATE TRIGGER sessions_public_issuance_guard
BEFORE INSERT ON sessions
WHEN julianday(NEW.created_at) >= julianday('now') - (1.0 / 24)
    AND (
    NOT EXISTS (
        SELECT 1
        FROM users
        WHERE user_id = NEW.user_id
          AND status = 'active'
          AND deleted_at IS NULL
    )
    OR (
        SELECT COUNT(*)
        FROM creation_ledger
        WHERE scope_type = 'account'
          AND scope_id = NEW.user_id
          AND resource = 'session'
          AND date(created_at) = date(NEW.created_at)
    ) >= 12
    OR (
        SELECT COUNT(*)
        FROM creation_ledger
        WHERE scope_type = 'account'
          AND scope_id = NEW.user_id
          AND resource = 'session'
          AND julianday(created_at) >
              julianday(NEW.created_at) - 30
    ) >= 60
    )
BEGIN
    SELECT RAISE(ABORT, 'session issuance budget exceeded');
END;

CREATE TRIGGER sessions_public_issuance_ledger
AFTER INSERT ON sessions
BEGIN
    INSERT INTO creation_ledger(
        event_id,
        scope_type,
        scope_id,
        resource,
        created_at
    )
    VALUES (
        'session:' || NEW.session_id,
        'account',
        NEW.user_id,
        'session',
        NEW.created_at
    );

    DELETE FROM creation_ledger
    WHERE scope_type = 'account'
      AND scope_id = NEW.user_id
      AND resource = 'session'
      AND julianday(created_at) <= julianday(NEW.created_at) - 31;

    UPDATE sessions
    SET
        revoked_at = NEW.created_at,
        replaced_by_session_id = NEW.session_id
    WHERE session_id IN (
        SELECT session_id
        FROM sessions
        WHERE user_id = NEW.user_id
          AND session_id <> NEW.session_id
          AND revoked_at IS NULL
          AND expires_at > NEW.created_at
        ORDER BY created_at DESC, rowid DESC
        LIMIT -1 OFFSET 7
    );

    DELETE FROM sessions
    WHERE user_id = NEW.user_id
      AND session_id <> NEW.session_id
      AND (
          revoked_at IS NOT NULL
          OR expires_at <= NEW.created_at
      )
      AND (
          julianday(COALESCE(revoked_at, expires_at)) <=
              julianday(NEW.created_at) - 30
          OR session_id IN (
              SELECT terminal.session_id
              FROM sessions terminal
              WHERE terminal.user_id = NEW.user_id
                AND terminal.session_id <> NEW.session_id
                AND (
                    terminal.revoked_at IS NOT NULL
                    OR terminal.expires_at <= NEW.created_at
                )
              ORDER BY
                  COALESCE(terminal.revoked_at, terminal.expires_at) DESC,
                  terminal.session_id DESC
              LIMIT -1 OFFSET 32
          )
      );
END;

CREATE TRIGGER guest_links_public_creation_guard
BEFORE INSERT ON guest_links
WHEN julianday(NEW.created_at) >= julianday('now') - (1.0 / 24)
    AND (
    COALESCE(
        (
            SELECT CASE
                WHEN state = 'paused'
                    AND pause_kind = 'security'
                    AND resume_at IS NOT NULL
                    AND resume_at <= NEW.created_at
                THEN 'open'
                ELSE state
            END
            FROM circuit_breakers
            WHERE scope = 'guest_links'
        ),
        'paused'
    ) <> 'open'
    OR NOT EXISTS (
        SELECT 1
        FROM users
        WHERE user_id = NEW.created_by_user_id
          AND status = 'active'
          AND deleted_at IS NULL
    )
    OR (
        SELECT COUNT(*)
        FROM creation_ledger
        WHERE scope_type = 'account'
          AND scope_id = NEW.created_by_user_id
          AND resource = 'guest_link'
          AND date(created_at) = date(NEW.created_at)
    ) >= 10
    OR (
        SELECT COUNT(*)
        FROM creation_ledger
        WHERE scope_type = 'account'
          AND scope_id = NEW.created_by_user_id
          AND resource = 'guest_link'
          AND julianday(created_at) >
              julianday(NEW.created_at) - 30
    ) >= 50
    )
BEGIN
    SELECT RAISE(ABORT, 'guest link creation is temporarily unavailable');
END;

CREATE TRIGGER guest_links_public_creation_ledger
AFTER INSERT ON guest_links
BEGIN
    INSERT INTO creation_ledger(
        event_id,
        scope_type,
        scope_id,
        resource,
        created_at
    )
    VALUES (
        'guest_link:' || NEW.guest_link_id,
        'account',
        NEW.created_by_user_id,
        'guest_link',
        NEW.created_at
    );

    DELETE FROM creation_ledger
    WHERE scope_type = 'account'
      AND scope_id = NEW.created_by_user_id
      AND resource = 'guest_link'
      AND julianday(created_at) <= julianday(NEW.created_at) - 31;
END;

CREATE TRIGGER guest_links_public_redemption_guard
BEFORE UPDATE OF consumed_at ON guest_links
WHEN OLD.consumed_at IS NULL
    AND NEW.consumed_at IS NOT NULL
    AND COALESCE(
        (
            SELECT CASE
                WHEN state = 'paused'
                    AND pause_kind = 'security'
                    AND resume_at IS NOT NULL
                    AND resume_at <= NEW.consumed_at
                THEN 'open'
                ELSE state
            END
            FROM circuit_breakers
            WHERE scope = 'guest_redemptions'
        ),
        'paused'
    ) <> 'open'
BEGIN
    SELECT RAISE(ABORT, 'guest link redemption is temporarily unavailable');
END;
