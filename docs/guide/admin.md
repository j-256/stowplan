# Administration

`/admin` is a server-enforced control plane. Client-side navigation is not the security boundary.

Admins can inspect users, linked provider identities, workspace memberships, sessions, guest links, and auth audit events. The control plane can assign global admin scope, disable or enable users, unlink redundant identities, change/remove workspace roles, and revoke sessions or links. The first successfully created account—or any email in `AUTH_ADMIN_EMAILS`—receives admin scope.

For a single-owner installation, protect `/admin*` with Cloudflare Access as a second gate. Stowplan still verifies its own app session and admin role. Access alone does not grant workspace rights.

Stowplan refuses to remove or disable the final active administrator, demote/remove a workspace’s final owner, or unlink a user’s final sign-in identity. Add and verify a replacement first. All mutations are audited with actor, action, target, time, and non-secret details.
