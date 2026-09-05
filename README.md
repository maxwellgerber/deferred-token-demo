# Deferred Token Response — explainer & sandbox

Companion site for [DTR](https://github.com/maxwellgerber/deferred-token-response), an IETF
OAuth Working Group draft defining a generic asynchronous token request mechanism.

Deployed on Cloudflare Workers via `wrangler`.

## Layout

- `site/` — static explainer at `deferred-token-response.dev` (protocol overview, basic flow,
  step-by-step reference). Done.
- `demo/` — OAuth client at `demo.deferred-token-response.dev`. Not started.
- `idp/` — authorization server at `idp.deferred-token-response.dev`. Not started.

`demo/` and `idp/` will be built scenario by scenario:

1. ID-JAG + `interaction_required` — client exchanges an assertion, AS requires human
   interaction, client redirects the user to `interaction_uri`.
2. `client_credentials` + RAR, resource-owner confirmation the client can't route to directly.
3. Fraud review — auth code flow grants access, then an admin/authority approves or denies the
   deferred request. AS-side has both an end-user view and an admin view.

## Local dev

```
cd site && npm install && npm run dev
```

## Deploy

```
cd site && npm run deploy
```
