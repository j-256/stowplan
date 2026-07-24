UPDATE sessions
SET ip_prefix = NULL
WHERE ip_prefix IS NOT NULL;

UPDATE auth_audit_events
SET ip_prefix = NULL
WHERE ip_prefix IS NOT NULL;
