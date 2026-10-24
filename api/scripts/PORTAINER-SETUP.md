# Portainer preparation (no deployment)

Use the updated root `compose.portainer-api.yml` with an API image built from
the Piper changes. Import/merge `portainer.piper.env.example` into its stack
environment. It contains only server model paths and verified SHA256 values,
not passwords. The image supplies the Linux engine; the host supplies voices.
The Whisper cache stays in its separate named volume at `/models` and the
read-only Piper mount occupies `/models/piper`.

Do not import the local Windows `.env` wholesale. Preserve or provision the
server's DB credentials, token signing key and OAuth secrets separately. Never
paste those secrets into chat, Git, or documentation. Applying a stack update
can recreate its containers: preparing files is not the same as deploying.

## Public origin and OAuth

Choose a real DNS hostname and configure a valid TLS certificate at the reverse
proxy before using remote OAuth or microphone recording. Values for a hostname
you control (replace `YOUR_DOMAIN`, do not deploy this literal placeholder):

```text
LINGUALOOP_WEB_ORIGIN=https://YOUR_DOMAIN
GOOGLE_CALLBACK_URL=https://YOUR_DOMAIN/auth/google/callback
MICROSOFT_CALLBACK_URL=https://YOUR_DOMAIN/auth/microsoft/callback
```

Register these exact redirect URLs in the Google OAuth web client and Microsoft
Entra application (Web platform). Keep localhost redirects too if local testing
is still needed. Existing provider client IDs can be reused if their registered
redirects and supported account types permit it; do not guess new secrets.

The intended single-origin route is TLS reverse proxy -> `lingualoop-web-1:80`
on `proxy-network`. The web Nginx forwards `/api/` and `/auth/` to the private
`lingualoop-api-1:5000`. A second public API domain is not required. Do not expose
the database or Whisper port. Confirm DNS/firewall reachability separately:
the private VPN IP alone does not make the app public.

No stack update, proxy change, TLS issuance or OAuth-console change is performed
by preparing these files. The workflow currently publishes images on `main`
push or manual dispatch, not automatically on `develop` push; never assume
GHCR `latest` contains a new develop commit.
