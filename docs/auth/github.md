# GitHub OAuth is not supported

The public launch uses direct Google OIDC as its only ordinary-account provider. Stowplan does not advertise, configure, or accept GitHub OAuth for production sign-in, identity linking, or reauthentication.

Do not create a GitHub OAuth App, authorize a GitHub callback, or install GitHub client credentials for Stowplan. Existing experimental deployments must migrate each required account to a linked Google identity before removing any older provider integration. Cloudflare Access remains a separate administrator perimeter and cannot serve as the replacement ordinary-account identity.

See [Google sign-in and Turnstile setup](/auth/google) for the supported provider configuration and [Cloudflare Access administrator perimeter](/auth/cloudflare-access) for the independent admin gate.
