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

OAuth uses authorization code + PKCE and single-use, ten-minute state records. Google ID tokens and Access assertions are signature-, issuer-, and audience-verified. Sessions are random opaque values; only a SHA-256 hash is stored. Cookies are `HttpOnly`, `Secure`, `SameSite=Lax`, revocable, and workspace authorization is checked on every protected API.

Set `AUTH_ADMIN_EMAILS` before the first sign-in. The first user also becomes admin, but an allowlist makes bootstrap deterministic.

Invite URLs open a confirmation page before the single-use token is consumed. Mail previews and security scanners can inspect the URL without burning it. The recipient signs in, returns to the confirmation page, and explicitly accepts. Confirmation atomically attaches a persistent viewer or editor membership to that signed-in account without replacing its session, then opens the exact shared workspace view carried by the invitation while preserving any other workspace already stored on that device. The membership remains until the member leaves, an owner removes it, or the workspace is deleted. The requested return path is accepted only when it belongs to the authorized workspace.
