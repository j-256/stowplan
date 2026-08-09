# Google sign-in and Turnstile setup

Google is the ordinary-account identity provider. Cloudflare Turnstile protects the same-origin request that starts Google OAuth, while Google remains the authority that authenticates the person.

## Values to decide first

```text
Production origin: https://stowplan.lasers.app
Production callback: https://stowplan.lasers.app/api/auth/google/callback
Node and OpenNext local callback: http://localhost:3000/api/auth/google/callback
Sites/Vite local callback, when used: http://localhost:5173/api/auth/google/callback
Scopes: openid email profile
Client type: Web application
Turnstile action: oauth_start
```

Authorize the production and port `3000` callbacks. Add the port `5173` callback only when testing Google through the Sites/Vite development server. Each callback must match its request exactly by scheme, hostname, port, path, and absence of a trailing slash. This server-side authorization-code flow does not use an authorized JavaScript origin.

## Google project setup

```bash
gcloud auth login
gcloud projects create YOUR_PROJECT_ID --name="Stowplan"
gcloud config set project YOUR_PROJECT_ID
```

No People API call is needed because Stowplan reads the signed OIDC ID token and requests only `openid email profile`.

Open **Google Cloud Console > Google Auth Platform**:

1. **Branding:** enter the app name, support email, homepage, Privacy Policy, Terms of Service, and authorized domain.
2. **Audience:** choose Internal only for a suitable Workspace organization; otherwise choose External.
3. **Data Access:** request only `openid`, `email`, and `profile`.
4. **Clients > Create client > Web application:** add the exact production and port `3000` callback URIs, plus the optional port `5173` callback when that preview needs real Google sign-in. Leave authorized JavaScript origins empty because the browser never receives or exchanges the OAuth client secret.

## Turnstile widget setup

Create a Managed Turnstile widget in Cloudflare and restrict its hostname list to the exact production hostname. Do not add localhost to the production widget. Stowplan validates the Siteverify `hostname` against `AUTH_BASE_URL` and validates the action as `oauth_start`, so a token minted for another host or action is refused.

The account page uses Turnstile's interaction-only appearance. The normal browser check stays out of view, while a visitor can complete an interactive check when Cloudflare requires one. The Content Security Policy admits only `https://challenges.cloudflare.com` for the Turnstile script and frame.

Install the provider and Turnstile secrets without putting them in a file:

```bash
npx wrangler secret put AUTH_GOOGLE_CLIENT_ID
npx wrangler secret put AUTH_GOOGLE_CLIENT_SECRET
npx wrangler secret put AUTH_TURNSTILE_SECRET_KEY
```

Set the public Turnstile site key as `AUTH_TURNSTILE_SITE_KEY`. Set `AUTH_IDENTITY_DIGEST_KEY` to an independently generated secret of at least 32 bytes through the secret manager so banned provider identities can be recognized without retaining a raw provider subject after deletion. For Node, set the same names in the process or service secret manager. Set `AUTH_BASE_URL` to the exact public origin.

## Security boundary

The server accepts only a same-origin form POST to start OAuth. Every Google start, including ordinary sign-in, identity linking, and reauthentication, requires a fresh Turnstile result. Ordinary sign-in first requires an explicit agreement to the linked Terms and a separate session-persistence choice. The client does not choose the Terms version: the server adds its current version and binds it, along with the persistence choice, into the browser-bound, single-use transaction containing PKCE, an OIDC nonce, and the explicit intent. Identity linking and reauthentication reject sign-in-only legal or persistence fields. The transaction envelope is stored in the existing OAuth credential field and is not encrypted; it is cleared atomically when the callback claims the state.

The callback validates Google's signature, issuer, audience, token time, nonce, stable subject, and verified-email claim. It records the bound Terms version and acceptance time for a successful ordinary sign-in, then issues either a browser-session cookie or a persistent cookie as bound at OAuth start. The server session expires independently in both cases. Google's `azp` authorized-presenter claim is optional for a single-audience web token: when present it must match the configured client, and a multi-audience token is accepted only with a matching `azp`. Email is display and contact data, not an account-linking key. A new provider subject creates an ordinary account only when its email is not already assigned to another Stowplan account. Linking a first or additional Google identity requires an explicit OAuth transaction bound to the active Stowplan user and session, recent authentication through that account's existing sign-in method, and Google account selection. A newly issued app session counts as recent; otherwise the user must sign in again before linking. An account without Google is told to refresh its existing recovery or development sign-in rather than attempt impossible Google reauthentication. Once Google is linked, reauthentication requires explicit account selection and a Google subject already belonging to that exact user, then records a fresh proof timestamp on that exact active app session. It does not issue another session or consume the ordinary session-issuance budget. Google's documented web OIDC parameters do not provide a portable force-password prompt, so Stowplan does not claim that this flow proves a new password entry.

The Account page reads only a server-computed boolean for Google-link state. It labels the first action **Link Google identity** and later actions **Link another Google identity** without receiving provider subjects, identity IDs, linked emails, or an identity count.

## Testing versus production

Use Cloudflare's [documented Turnstile test credentials](https://developers.cloudflare.com/turnstile/troubleshooting/testing/) in local, CI, and isolated test deployments. Cloudflare's dummy token can return a provider-owned placeholder hostname and omit the action requested by the page. Stowplan accepts that test metadata only when both configured Turnstile values are recognized official test credentials and both the request origin and `AUTH_BASE_URL` pass the isolated-host guard. It still calls Siteverify and requires a successful result with a fresh challenge time. Any known test site or secret key makes Google unavailable on a public host, including `stowplan.lasers.app`, before Siteverify is called. Stowplan's development provider accepts synthetic personas only on loopback, reserved `.test` hosts, or hosts explicitly named in `AUTH_DEV_ALLOWED_HOSTS`; it always refuses `stowplan.lasers.app`.

Stowplan does not request offline access or store Google access or refresh tokens after the callback, so it cannot revoke Google consent on the user's behalf during account deletion. A user who wants to remove that consent must also remove Stowplan from the connections page in their Google Account. Publish and verify the Google app according to the console's production requirements before launch.

## Troubleshooting

| Symptom | Check |
|---|---|
| `redirect_uri_mismatch` | Compare the callback character-for-character and confirm the correct client ID is deployed. |
| `access_denied` | Verify the audience type and confirm the user did not deny consent. |
| Unverified-app warning | Finish branding and domain verification and publish the app. |
| Callback loops to the wrong host | Set `AUTH_BASE_URL` and check reverse-proxy forwarded host and protocol settings. |
| State invalid or expired | Retry from Stowplan; state lasts ten minutes and is single-use. Check clock skew and cookie handling. |
| Browser verification unavailable | Confirm both Turnstile keys, the widget hostname, CSP delivery, and access to `challenges.cloudflare.com`. |
| Browser verification refused after completion | Confirm the widget action is `oauth_start` and `AUTH_BASE_URL` has the exact public hostname. |
| Works locally but not in production | Confirm production secrets, callback, cookie HTTPS, and that the deployments use the intended database. |

Never copy a Google client secret, Turnstile secret, OAuth transaction, authorization code, token, or assertion into `wrangler.jsonc`, `.env.example`, documentation, screenshots, logs, or issue reports.
