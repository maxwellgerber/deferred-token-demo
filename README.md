# Deferred Token Response — explainer & sandbox

Companion site for [DTR](https://github.com/maxwellgerber/deferred-token-response), an IETF
OAuth Working Group draft defining a generic asynchronous token request mechanism.

Deployed on Cloudflare Workers via `wrangler`. Each of the three directories below is its own
independent Worker with its own `package.json`/`wrangler.jsonc` — there's no root-level tooling.

## Layout

- `site/` — static explainer at `deferred-token-response.dev` (protocol overview, basic flow,
  step-by-step reference).
- `demo/` — live OAuth client sandbox at `demo.deferred-token-response.dev`, a real client talking
  to the authorization server below.
- `idp/` — the authorization server at `idp.deferred-token-response.dev`, implementing DTR for
  real over HTTP (hand-written, not forked from an existing OAuth server library).

`demo/` and `idp/` are built around three scenarios, each its own self-contained page in
`demo/public/`, with a color-coded log of both the client's and the AS's side of every request:

1. **ID-JAG + `interaction_required`** (`id-jag/`) — client exchanges an identity assertion, the
   resource always requires human interaction, and the AS hands back an `interaction_uri` the
   client opens as a popup for the user to approve or deny.
2. **`client_credentials` + Rich Authorization Requests, stateful document access** (`rar/`) — a
   machine client (no user in the grant) requests view access to one of three documents. The first
   request for a given document always defers to the resource owner; once granted, later requests
   for that same document resolve synchronously with no deferral at all.
3. **Fraud review after a real Authorization Code consent** (`fraud-review/`) — a real redirect-based
   consent screen for `alice@example.com`, then a dynamic policy: transfers at or under $1,000
   resolve immediately, transfers over that always route to a separate fraud reviewer (with account
   standing and 30-day transfer history) before the token issues.

## Local dev

```
cd <site|demo|idp> && npm install && npm run dev
```

`idp/` also has a typecheck script (`npm run typecheck`) — there's no build step for any of the
three; `wrangler dev`/`deploy` run the source directly.

## Deploy

```
cd <site|demo|idp> && npm run deploy
```

Each `npm run deploy` ships straight to the live custom domain configured in that project's
`wrangler.jsonc` — there's no staging environment.
