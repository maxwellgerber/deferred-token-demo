# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Companion site and live sandbox for [DTR (Deferred Token Response)](https://github.com/maxwellgerber/deferred-token-response),
an IETF OAuth Working Group draft for authorization decisions that can't complete synchronously.
Three independent Cloudflare Workers, each deployed to its own subdomain:

- `site/` — static explainer at `deferred-token-response.dev` (protocol overview, sequence
  diagram, step-by-step reference). Single `index.html`, no build step.
- `demo/` — the interactive OAuth **client** sandbox at `demo.deferred-token-response.dev`.
  Plain HTML/CSS/JS static assets, no build step, no framework.
- `idp/` — the hand-written OAuth **authorization server** at `idp.deferred-token-response.dev`.
  TypeScript on a Cloudflare Durable Object.

There is no root `package.json`/workspace tooling — each of the three directories is its own
independent npm project with its own `wrangler.jsonc`. Always `cd` into the relevant one first.

## Commands

Each project (`site/`, `demo/`, `idp/`):

```
cd <site|demo|idp> && npm install   # first time / after dependency changes
npm run dev                          # wrangler dev, local preview
npm run deploy                       # wrangler deploy, ships to the live *.deferred-token-response.dev domain
```

`idp/` and `demo/` also have an ESLint flat config (`eslint.config.mjs`) and a `lint` script;
`idp/` additionally has a typecheck step (no build/bundle step — Workers runs the TS directly):

```
cd idp && npm run lint               # eslint .
cd idp && npm run typecheck          # tsc --noEmit
cd demo && npm run lint              # eslint .
```

`site/` has no JS at all (see below), so there's nothing for it to lint. `.github/workflows/ci.yml`
runs the `idp` and `demo` lint (+ `idp` typecheck) jobs on push/PR to `main` — it does not deploy;
deploys are still a manual `npm run deploy` from your machine. There is no test suite. `npm run
deploy` deploys straight to the live custom domain (`site/`, `demo/`, `idp` are each mapped via
`routes` in their `wrangler.jsonc`) — there is no staging environment, so verify locally or via
`wrangler dev` before deploying anything user-facing.

## Architecture

### `idp/` — the authorization server

`idp/src/index.ts` is the Worker entry point. It serves `/.well-known/oauth-authorization-server`
and otherwise routes **every** request to a Durable Object instance keyed by the `?session=` query
string (`env.SESSION_DO.idFromName(sessionId)`). Every request the demo client makes — `/token`,
`/authorize`, `/interact`, `/events` (WebSocket), `/admin/*` — must carry `?session=<id>` or it's
rejected before it ever reaches the DO.

`idp/src/session.ts` (`DemoSession`, extends `DurableObject`) is the whole authorization server.
Key things to know before touching it:

- **One `deferral` at a time per session.** There's a single `DeferralRecord | null` field, not a
  collection — a session is mid-flight on at most one pending request. `scenario` discriminates
  which of the three demo scenarios (`id-jag` | `rar-client-credentials` | `fraud-review`) it
  belongs to, and a generic `context: Record<string, string>` bag carries scenario-specific fields
  (subject/resource, document_id, memo/standing/history, etc.) shown as-is in the AS panel.
- **The polling substrate (expiry, `slow_down`, redemption, `invalid_grant`) is 100% shared** across
  scenarios in `handlePoll` — resist the urge to special-case a scenario there. The one thing that
  varies is whether a scenario ever hands out an `interaction_uri`: only scenarios listed in
  `SCENARIOS_WITH_CLIENT_ROUTABLE_INTERACTION` (currently just `id-jag`) do. The others
  (`rar-client-credentials`, `fraud-review`) resolve via `/admin/decide` — a stand-in for "the
  resource owner or reviewer acts through the AS's own console," since there's no user the client
  can route an interaction link to.
- **`id-jag` requests a fixed subject/resource against a fictional production database** (`db://prod-orders`),
  with only the scope varying (`database.read` or `database.delete`, chosen via a dropdown in
  `demo/public/id-jag/index.html` — subject/resource are no longer editable inputs). This is decided
  in `handleIdJagRequest`, not in `handlePoll`: `database.read` returns a token synchronously
  (skips deferral entirely, regardless of `completion_mode`); `database.delete` requires
  `completion_mode=deferred` and always defers into the interaction flow above.
- **Two real (not simulated) redirect-based consent flows** render server-side HTML and are meant
  to be opened as popups by the client: `/interact` (GET renders the ID-JAG interaction page, POST
  records the decision) and `/authorize` (a real Authorization Code consent screen for
  `alice@example.com` used by the fraud-review scenario). Both auto-close themselves via an inline
  `<script>setTimeout(() => window.close(), ...)</script>` once decided. `/authorize`'s redirect
  lands on the **demo** origin (`demo/public/fraud-review/callback.html`), which relays the code
  back to `window.opener` via `postMessage` and closes itself — the redirect_uri is never on the
  idp origin.
- Extra state that outlives any single deferral is tracked separately and persisted independently:
  `grantedDocuments` (RAR: which documents this client has already been granted, so a repeat
  request resolves synchronously instead of deferring again) and `recipientHistory` (fraud-review:
  a running total/count per recipient, seeded from `DEFAULT_RECIPIENT_HISTORY`, bumped only once a
  transfer actually succeeds). Both are reset back to their defaults by `/admin/reset`, not cleared
  to empty.
- `idp/src/jwt.ts` is a minimal hand-rolled HS256 sign/verify (no lib) — just enough to mint/verify
  the stand-in "ID-JAG" identity assertion; not meant to be a general-purpose JWT implementation.
- `idp/src/dtr.ts` has the shared response helpers (`jsonResponse`, `deferredErrorResponse`,
  `tokenSuccessResponse`, CORS, opaque ID generation) used across all scenarios.
- The demo client's credentials (`demo-client` / `demo-secret`) and `DEMO_JWT_SECRET` are
  intentionally public/fake — this is a public educational sandbox, not a real deployment, so
  don't treat hardcoded secrets here as a finding.
- **Every session has a rolling 24h TTL.** `fetch()` calls `this.ctx.storage.setAlarm(Date.now() +
  SESSION_TTL_MS)` on every request (including the WebSocket upgrade and polling), pushing expiry
  out another day; `alarm()` wipes the DO's storage back to a fresh, empty state once a full day
  passes with no activity. No demo session is meant to persist longer than that.
- **`/events` uses the WebSocket Hibernation API**, not a plain `server.accept()` + in-memory
  `Set<WebSocket>` — that lets Cloudflare evict the DO from memory between log/state pushes
  instead of billing for the entire time a tab stays open. This means there is no `this.sockets`
  field: `log()`/`broadcastState()` iterate `this.ctx.getWebSockets()` fresh each time (the
  runtime tracks attached sockets independently of the instance, so this survives hibernation
  where a plain field would not), and `webSocketMessage`/`webSocketClose`/`webSocketError` are
  required no-op methods on the class — don't add socket bookkeeping back into instance state.

### `demo/` — the OAuth client sandbox

Three self-contained scenario pages under `demo/public/`: `id-jag/`, `rar/`, `fraud-review/`, each
its own `index.html` + `app.js` acting as a real OAuth client against `idp.deferred-token-response.dev`
(no server-side code in `demo/` itself — it's pure static assets). The demo root (`demo/public/index.html`)
just redirects into `id-jag/`; there's no scenario-picker landing page anymore.

Common behavior — the log tray (with per-line expandable request/response detail), the hamburger
menu for switching scenarios, the resizable log tray, the pause/resume-polling helper
(`window.DTR.pollingPaused` / `DTR.armResume(cb)`), and the demo OAuth client plumbing
(`DTR.CLIENT_ID`/`CLIENT_SECRET`, `DTR.basicAuthHeader()`, `DTR.requestDetailFor(params)`,
`DTR.setStatus(kind, text)`, `DTR.schedulePoll(pollState, pollFn)`) — lives in
`demo/public/shared.css` and `demo/public/shared.js`, loaded by every scenario page before its own
`app.js`. **Do not re-duplicate this logic into a scenario's `app.js`** — that's exactly the
pattern that caused a regression before (a fix landing in one scenario's copy but not the other
two). Each scenario's own `app.js` only needs to declare its own `const pollState = { timer: null,
interval: 4 }` and call `DTR.schedulePoll(pollState, () => poll(code))` inside its own
`schedulePoll` — `DTR.schedulePoll` owns the actual timer/pause-resume wiring.

Each scenario page opens its own WebSocket to `wss://idp.deferred-token-response.dev/events?session=...`
for live AS-side log lines and state pushes (`{type: "log", ...}` / `{type: "state", state, ...}`) —
this is how the split-screen client/AS panels stay in sync without polling the AS's log.

### `site/` — the static explainer

Single self-contained `index.html` (inline `<style>`, no external JS). No dynamic behavior beyond
the inline sequence diagram and anchor navigation. Also serves `robots.txt` (fully indexable —
this is the canonical content page), `sitemap.xml`, and `llms.txt` as sibling static files in
`site/public/` — keep these in sync with the page's own content/URL if either changes.
`demo/public/robots.txt` disallows everything (the scenario pages are app shells, not content,
and would otherwise dilute search/LLM relevance against this page); `idp/` isn't asset-served, so
its `/robots.txt` (also disallow-everything) is a route in `idp/src/index.ts` answered before the
`?session=` check, so crawlers get a real response instead of a 400.
