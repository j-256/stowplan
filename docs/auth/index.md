# Authentication overview

Authentication is provider-neutral at the application boundary. A provider returns a stable subject, verified email, and display name. Stowplan links that identity to a user and issues its own opaque session.

Supported adapters:

| Adapter | Purpose | Production status |
|---|---|---|
| Google OAuth 2.0/OIDC | General household sign-in | Reference-tested to provider boundary |
| GitHub OAuth | Maintainer/self-hosted sign-in | Reference-tested to provider boundary |
| Cloudflare Access JWT | Existing Zero Trust identity | Reference-tested to signature/audience boundary |
| Invite URL | Enroll a persistent viewer or editor | Fully automated |
| Development | Local testing only | Explicitly disabled in production by default |

OAuth uses authorization code + PKCE and single-use, ten-minute state records. OAuth-start redirects are uncached. Return paths are bounded, decoded until stable for safety inspection, and rejected rather than persisted when they are malformed, excessively nested, cross-origin, or conceal an invitation route. Google ID tokens and Access assertions are signature-, issuer-, and audience-verified. Sessions are random opaque values; only a SHA-256 hash is stored. Cookies are `HttpOnly`, `Secure`, `SameSite=Lax`, revocable, and workspace authorization is checked on every protected API.

Signed-in users can review every retained app session for their own account from **Account**. The bounded list identifies the current session and shows creation, expiry, revocation, approximate last server activity, the browser-provided user agent, and an anonymized network prefix when available. Last activity is updated at most about once every five minutes while an authenticated device reaches the server. Offline and device-only use is not visible until that device makes another server request.

**Sign out this session** revokes the current app session and clears its cookie. A user can also revoke any other active session belonging to the same account. Revocation removes server access without deleting that device's local replicas, pending commands, or blocked commands. Disabling a user atomically revokes all of that user's active sessions and prevents another session from being issued; enabling the account permits a later sign-in but never revives revoked sessions.

The account session list never returns a raw cookie value or stored session hash. Revoked and expired session rows remain available for operational review until bounded cleanup removes rows whose original expiry is at least 30 days old.

Set `AUTH_ADMIN_EMAILS` before the first sign-in. The first user also becomes admin, but an allowlist makes bootstrap deterministic.

New invite URLs use `/guest` with the single-use token and optional workspace return path in the URL fragment after `#`. Browsers do not transmit the fragment in the HTTP request path, query string, or `Referer` header. Mail previews and security scanners can therefore inspect the fixed confirmation page without receiving or consuming the token.

If sign-in is required, the browser stores the fragment only in same-tab session storage. OAuth and Access continuation carry the fixed `/account?resume=invitation` route rather than the credential. After the recipient explicitly accepts, the browser sends the token in the bounded same-origin JSON body of `POST /api/auth/guest`. Confirmation atomically attaches a persistent viewer or editor membership to that signed-in account without replacing its session, then opens the exact shared workspace view carried by the invitation while preserving any other workspace already stored on that device. The membership remains until the member leaves, an owner removes it, or the workspace is deleted. The requested return path is accepted only when it belongs to the authorized workspace. Legacy token-path links remain readable and are canonicalized to the fragment form before authentication is checked.
