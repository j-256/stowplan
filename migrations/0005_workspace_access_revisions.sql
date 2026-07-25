ALTER TABLE users
ADD COLUMN membership_revision INTEGER NOT NULL DEFAULT 0;

ALTER TABLE workspace_snapshots
ADD COLUMN access_revision INTEGER NOT NULL DEFAULT 0;

CREATE TABLE workspace_deletions (
    workspace_id TEXT PRIMARY KEY,
    deletion_id TEXT NOT NULL,
    deleted_at TEXT NOT NULL,
    deleted_by_user_id TEXT,
    final_snapshot_revision INTEGER NOT NULL
        CHECK (
            final_snapshot_revision >= 0
            AND final_snapshot_revision <= 9007199254740991
        ),
    final_access_revision INTEGER NOT NULL
        CHECK (
            final_access_revision >= 0
            AND final_access_revision <= 9007199254740991
        )
) STRICT;

CREATE UNIQUE INDEX workspace_deletions_deletion_id_idx
ON workspace_deletions(deletion_id);

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
WHEN typeof(NEW.membership_revision) <> 'integer'
    OR NEW.membership_revision < 0
    OR NEW.membership_revision > 9007199254740991
BEGIN
    SELECT RAISE(
        ABORT,
        'user membership revision must remain JavaScript-safe and monotonic'
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

CREATE TRIGGER workspace_members_identity_immutable
BEFORE UPDATE OF workspace_id, user_id ON workspace_members
WHEN OLD.workspace_id IS NOT NEW.workspace_id
    OR OLD.user_id IS NOT NEW.user_id
BEGIN
    SELECT RAISE(ABORT, 'workspace membership identity is immutable');
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
