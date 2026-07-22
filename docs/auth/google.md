# Google OAuth setup

Google’s console is the authoritative setup surface; `gcloud` can create/select the project and enable APIs, but Google still requires browser work for OAuth branding, audience, and web-client redirect URIs.

## Values to decide first

```text
Production origin: https://stowplan.example.com
Production callback: https://stowplan.example.com/api/auth/google/callback
Local callback: http://localhost:3000/api/auth/google/callback
Scopes: openid email profile
Client type: Web application
```

The callback must match **exactly**: scheme, hostname, port, path, and trailing slash.

## CLI-assisted project setup

```bash
gcloud auth login
gcloud projects create YOUR_PROJECT_ID --name="Stowplan"
gcloud config set project YOUR_PROJECT_ID
```

No People API call is needed: Stowplan reads the signed OIDC ID token and requests only `openid email profile`.

Then open **Google Cloud Console → Google Auth Platform**:

1. **Branding:** enter app name, support email, homepage, privacy policy, and authorized domain.
2. **Audience:** choose Internal only for a suitable Workspace organization; otherwise External. While testing, add every test-user email explicitly.
3. **Data Access:** request only `openid`, `email`, and `profile`.
4. **Clients → Create client → Web application.** Add the exact local and production callback URIs above. JavaScript origins are not used by the server flow but may be entered for clarity.

Install Cloudflare secrets without putting them in a file:

```bash
npx wrangler secret put AUTH_GOOGLE_CLIENT_ID
npx wrangler secret put AUTH_GOOGLE_CLIENT_SECRET
```

For Node, set the same names in your process/service secret manager. Also set `AUTH_BASE_URL` to the public origin.

## Testing versus production

An External app in testing mode accepts only listed test users and may impose shorter refresh behavior. Stowplan does not request offline access or store Google refresh tokens. Publish the app when ready; Google may request domain or branding verification even though the scopes are basic.

## Troubleshooting

| Symptom | Check |
|---|---|
| `redirect_uri_mismatch` | Compare the callback character-for-character and confirm the correct client ID is deployed. |
| “Access blocked” or `access_denied` | Add the account as a test user; verify audience type; ensure the user did not deny consent. |
| Unverified-app warning | Finish branding/domain verification and publish, or remain in a controlled test audience. |
| Callback loops to the wrong host | Set `AUTH_BASE_URL`; check reverse-proxy forwarded host/proto settings. |
| State invalid/expired | Retry from Stowplan; state lasts ten minutes and is single-use. Check clock skew. |
| Works locally, not production | Confirm production secrets, callback, cookie HTTPS, and that two deployments are not using different databases. |

Never copy a client secret into `wrangler.jsonc`, `.env.example`, documentation, screenshots, or issue reports.
