import { DurableObject } from "cloudflare:workers";
import { signJwt, verifyJwt, JwtValidationError } from "./jwt";
import { deferredErrorResponse, generateOpaqueId, jsonResponse, tokenSuccessResponse, corsPreflight } from "./dtr";

export interface Env {
  DEMO_JWT_SECRET: string;
}

export const ISSUER = "https://idp.deferred-token-response.dev";
export const DEMO_CLIENT_ID = "demo-client";
export const DEMO_CLIENT_SECRET = "demo-secret";
const DEFERRAL_EXPIRES_IN = 600; // seconds
const POLL_INTERVAL = 4; // seconds — short, so the demo doesn't feel like watching paint dry

type DeferralStatus =
  | "authorization_pending"
  | "interaction_required"
  | "interaction_pending"
  | "resolved"
  | "redeemed"
  | "denied"
  | "expired";

interface DeferralRecord {
  status: DeferralStatus;
  deferral_code: string;
  created_at: number;
  expires_in: number;
  interval: number;
  interaction_uri: string;
  client_id: string;
  subject: string;
  resource: string;
  scope: string;
  last_poll_at: number;
}

export class DemoSession extends DurableObject<Env> {
  private deferral: DeferralRecord | null = null;
  private loaded = false;
  private sockets: Set<WebSocket> = new Set();

  private async ensureLoaded() {
    if (this.loaded) return;
    this.deferral = ((await this.ctx.storage.get("deferral")) as DeferralRecord | undefined) ?? null;
    this.loaded = true;
  }

  private async persist() {
    await this.ctx.storage.put("deferral", this.deferral);
  }

  private log(message: string) {
    const payload = JSON.stringify({ type: "log", ts: Date.now(), actor: "as", message });
    for (const socket of this.sockets) {
      try {
        socket.send(payload);
      } catch {
        this.sockets.delete(socket);
      }
    }
  }

  private broadcastState() {
    const payload = JSON.stringify({ type: "state", state: this.deferral });
    for (const socket of this.sockets) {
      try {
        socket.send(payload);
      } catch {
        this.sockets.delete(socket);
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    await this.ensureLoaded();
    const url = new URL(request.url);
    const sessionId = url.searchParams.get("session") ?? "";

    if (request.method === "OPTIONS") return corsPreflight();

    if (url.pathname === "/events") return this.handleWebSocket();
    if (url.pathname === "/token" && request.method === "POST") return this.handleToken(request, sessionId);
    if (url.pathname === "/interact" && request.method === "GET") return this.handleInteractionPage(url, sessionId);
    if (url.pathname === "/interact" && request.method === "POST") return this.handleInteractionDecision(request, sessionId);
    if (url.pathname === "/admin/mint-assertion" && request.method === "POST") return this.handleMintAssertion(request);
    if (url.pathname === "/admin/state" && request.method === "GET") return jsonResponse(200, { state: this.deferral });
    if (url.pathname === "/admin/reset" && request.method === "POST") {
      this.deferral = null;
      await this.persist();
      this.log("session reset");
      this.broadcastState();
      return jsonResponse(200, { ok: true });
    }

    return jsonResponse(404, { error: "not_found" });
  }

  private handleWebSocket(): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.sockets.add(server);
    server.addEventListener("close", () => this.sockets.delete(server));
    server.addEventListener("error", () => this.sockets.delete(server));
    server.send(JSON.stringify({ type: "state", state: this.deferral }));
    return new Response(null, { status: 101, webSocket: client });
  }

  private authenticateClient(request: Request): string | null {
    const header = request.headers.get("Authorization") ?? "";
    const match = /^Basic (.+)$/.exec(header);
    if (!match) return null;
    let decoded: string;
    try {
      decoded = atob(match[1]);
    } catch {
      return null;
    }
    const idx = decoded.indexOf(":");
    if (idx === -1) return null;
    const clientId = decoded.slice(0, idx);
    const clientSecret = decoded.slice(idx + 1);
    if (clientId === DEMO_CLIENT_ID && clientSecret === DEMO_CLIENT_SECRET) return clientId;
    return null;
  }

  private async handleMintAssertion(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const subject = (body.subject as string) || "alice@example.com";
    const resource = (body.resource as string) || "https://api.example.com/wire-transfers";
    const scope = (body.scope as string) || "payments.write";
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: "https://login.example.com",
      sub: subject,
      aud: ISSUER,
      client_id: DEMO_CLIENT_ID,
      iat: now,
      exp: now + 300,
      jti: generateOpaqueId(96),
      resource,
      scope,
    };
    const assertion = await signJwt({ alg: "HS256", typ: "oauth-id-jag+jwt" }, claims, this.env.DEMO_JWT_SECRET);
    this.log(`minted stand-in ID-JAG for subject ${subject} (represents Token Exchange against the user's IdP, not shown here)`);
    return jsonResponse(200, { assertion, claims });
  }

  private async handleToken(request: Request, sessionId: string): Promise<Response> {
    const clientId = this.authenticateClient(request);
    if (!clientId) {
      this.log("token request rejected: client authentication failed");
      return jsonResponse(400, { error: "invalid_request", error_description: "client authentication failed" });
    }

    const form = await request.formData().catch(() => null);
    if (!form) return jsonResponse(400, { error: "invalid_request", error_description: "expected application/x-www-form-urlencoded" });
    const grantType = form.get("grant_type");

    if (grantType === "urn:ietf:params:oauth:grant-type:jwt-bearer") {
      return this.handleInitialRequest(form, clientId);
    }
    if (grantType === "urn:ietf:params:oauth:grant-type:deferred") {
      return this.handlePoll(form, clientId, sessionId);
    }
    this.log(`token request rejected: unsupported grant_type ${String(grantType)}`);
    return jsonResponse(400, { error: "unsupported_grant_type" });
  }

  private async handleInitialRequest(form: FormData, clientId: string): Promise<Response> {
    const completionMode = String(form.get("completion_mode") ?? "").split(" ").filter(Boolean);
    const assertion = form.get("assertion");
    this.log(`token request received: grant_type=jwt-bearer completion_mode=${completionMode.join(",") || "(none)"}`);

    if (!completionMode.includes("deferred")) {
      this.log("client did not opt in to completion_mode=deferred — this demo requires it, since the resource always needs interaction");
      return jsonResponse(400, {
        error: "invalid_request",
        error_description: "this resource requires completion_mode=deferred",
      });
    }

    if (typeof assertion !== "string") {
      return jsonResponse(400, { error: "invalid_request", error_description: "missing assertion" });
    }

    let decoded;
    try {
      decoded = await verifyJwt(assertion, this.env.DEMO_JWT_SECRET);
    } catch (err) {
      this.log(`assertion rejected: ${err instanceof JwtValidationError ? err.message : "invalid"}`);
      return jsonResponse(400, { error: "invalid_grant", error_description: "assertion validation failed" });
    }

    if (decoded.header.typ !== "oauth-id-jag+jwt") {
      this.log("assertion rejected: unexpected typ header");
      return jsonResponse(400, { error: "invalid_grant", error_description: "expected an ID-JAG (typ=oauth-id-jag+jwt)" });
    }
    if (decoded.claims.aud !== ISSUER) {
      this.log(`assertion rejected: aud ${decoded.claims.aud} does not match this authorization server`);
      return jsonResponse(400, { error: "invalid_grant", error_description: "aud mismatch" });
    }
    if (decoded.claims.client_id !== clientId) {
      this.log("assertion rejected: client_id claim does not match authenticated client");
      return jsonResponse(400, { error: "invalid_grant", error_description: "client_id mismatch" });
    }

    this.log(`assertion validated: sub=${decoded.claims.sub} resource=${decoded.claims.resource}`);
    this.log("policy: this resource requires human interaction before every grant — deferring");

    this.deferral = {
      status: "authorization_pending",
      deferral_code: generateOpaqueId(),
      created_at: Date.now(),
      expires_in: DEFERRAL_EXPIRES_IN,
      interval: POLL_INTERVAL,
      interaction_uri: "",
      client_id: clientId,
      subject: String(decoded.claims.sub),
      resource: String(decoded.claims.resource),
      scope: String(decoded.claims.scope ?? ""),
      last_poll_at: 0,
    };
    await this.persist();
    this.broadcastState();
    this.log(`returning authorization_pending, deferral_code=${this.deferral.deferral_code.slice(0, 12)}…`);

    return deferredErrorResponse("authorization_pending", {
      deferral_code: this.deferral.deferral_code,
      expires_in: this.deferral.expires_in,
      interval: this.deferral.interval,
    });
  }

  private async handlePoll(form: FormData, clientId: string, sessionId: string): Promise<Response> {
    const code = form.get("deferral_code");
    if (!this.deferral || code !== this.deferral.deferral_code || this.deferral.client_id !== clientId) {
      this.log("poll rejected: unrecognized deferral_code");
      return jsonResponse(400, { error: "invalid_grant" });
    }

    const now = Date.now();
    if (now - this.deferral.created_at > this.deferral.expires_in * 1000) {
      this.deferral.status = "expired";
      await this.persist();
      this.log("poll: deferral code expired");
      return jsonResponse(400, { error: "expired_token" });
    }

    if (this.deferral.last_poll_at && now - this.deferral.last_poll_at < this.deferral.interval * 1000) {
      this.log("poll rejected: client polled faster than interval — slow_down");
      return jsonResponse(400, { error: "slow_down" });
    }
    this.deferral.last_poll_at = now;

    // First poll after the initial deferral is where this scenario's policy becomes visible
    // to the client: the resource always needs interaction.
    if (this.deferral.status === "authorization_pending") {
      this.deferral.status = "interaction_required";
      this.deferral.interaction_uri = `${ISSUER}/interact?session=${encodeURIComponent(sessionId)}&code=${this.deferral.deferral_code}`;
      await this.persist();
      this.broadcastState();
      this.log("poll response: interaction_required — interaction_uri issued");
      return deferredErrorResponse("interaction_required", {
        deferral_code: this.deferral.deferral_code,
        interaction_uri: this.deferral.interaction_uri,
        expires_in: this.deferral.expires_in,
        interval: this.deferral.interval,
      });
    }

    if (this.deferral.status === "interaction_required") {
      this.log("poll response: interaction_required (unchanged — user has not reached interaction_uri yet)");
      return jsonResponse(400, { error: "interaction_required", interaction_uri: this.deferral.interaction_uri });
    }

    if (this.deferral.status === "interaction_pending") {
      this.log("poll response: interaction_pending (user is at the interaction page but hasn't decided)");
      return jsonResponse(400, { error: "interaction_pending" });
    }

    if (this.deferral.status === "denied") {
      this.log("poll response: access_denied (terminal)");
      return jsonResponse(400, { error: "access_denied" });
    }

    if (this.deferral.status === "resolved") {
      this.deferral.status = "redeemed";
      await this.persist();
      this.broadcastState();
      this.log("poll response: 200 OK — access_token issued, deferral_code redeemed");
      return tokenSuccessResponse({
        access_token: `demo_at_${generateOpaqueId(96)}`,
        token_type: "Bearer",
        expires_in: 3600,
        scope: this.deferral.scope,
      });
    }

    // redeemed or expired
    this.log(`poll rejected: deferral_code already ${this.deferral.status}`);
    return jsonResponse(400, { error: this.deferral.status === "expired" ? "expired_token" : "invalid_grant" });
  }

  private handleInteractionPage(url: URL, sessionId: string): Response {
    const code = url.searchParams.get("code");
    if (!this.deferral || this.deferral.deferral_code !== code) {
      return new Response(renderInteractPage({ notFound: true }), { headers: { "Content-Type": "text/html" } });
    }
    if (this.deferral.status === "interaction_required") {
      this.deferral.status = "interaction_pending";
      void this.persist();
      this.broadcastState();
      this.log("user reached interaction_uri — interaction now in progress (interaction_pending)");
    }
    return new Response(
      renderInteractPage({
        sessionId,
        code,
        subject: this.deferral.subject,
        clientId: this.deferral.client_id,
        resource: this.deferral.resource,
        scope: this.deferral.scope,
        decided: this.deferral.status === "resolved" || this.deferral.status === "redeemed" || this.deferral.status === "denied",
        status: this.deferral.status,
      }),
      { headers: { "Content-Type": "text/html" } },
    );
  }

  private async handleInteractionDecision(request: Request, sessionId: string): Promise<Response> {
    const form = await request.formData();
    const code = form.get("code");
    const decision = form.get("decision");
    if (!this.deferral || this.deferral.deferral_code !== code) {
      return new Response(renderInteractPage({ notFound: true }), { headers: { "Content-Type": "text/html" } });
    }
    if (decision === "approve") {
      this.deferral.status = "resolved";
      this.log(`user approved the request at the interaction page (subject=${this.deferral.subject})`);
    } else {
      this.deferral.status = "denied";
      this.log("user denied the request at the interaction page");
    }
    await this.persist();
    this.broadcastState();
    return new Response(
      renderInteractPage({
        sessionId,
        code,
        subject: this.deferral.subject,
        clientId: this.deferral.client_id,
        resource: this.deferral.resource,
        scope: this.deferral.scope,
        decided: true,
        status: this.deferral.status,
      }),
      { headers: { "Content-Type": "text/html" } },
    );
  }
}

function renderInteractPage(opts: {
  notFound?: boolean;
  sessionId?: string;
  code?: string | null;
  subject?: string;
  clientId?: string;
  resource?: string;
  scope?: string;
  decided?: boolean;
  status?: string;
}): string {
  const style = `
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #101114; color: #eceef2; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { max-width: 420px; background: #17181d; border: 1px solid #2a2c34; border-radius: 12px; padding: 2rem; }
    h1 { font-size: 1.05rem; margin-top: 0; color: #9a9fac; font-weight: 600; }
    dl { display: grid; grid-template-columns: auto 1fr; gap: .3rem 1rem; font-size: .9rem; color: #9a9fac; margin: 1.2rem 0; }
    dt { font-weight: 600; color: #eceef2; }
    dd { margin: 0; word-break: break-all; }
    button { font-size: .95rem; font-weight: 600; padding: .6rem 1.2rem; border-radius: 8px; border: none; cursor: pointer; margin-right: .6rem; }
    .approve { background: #4fd188; color: #05170c; }
    .deny { background: #ff6b64; color: #200604; }
    .result { font-size: 1.3rem; font-weight: 600; }
  `;
  if (opts.notFound) {
    return `<!doctype html><html><head><meta charset="utf-8"><title>Interaction — not found</title><style>${style}</style></head><body><div class="card"><h1>Request not found</h1><p>This interaction link is invalid or the session has been reset.</p></div></body></html>`;
  }
  if (opts.decided) {
    const approved = opts.status === "resolved" || opts.status === "redeemed";
    return `<!doctype html><html><head><meta charset="utf-8"><title>Interaction — done</title><style>${style}</style></head><body><div class="card"><h1>idp.deferred-token-response.dev</h1><p class="result">${approved ? "✅ Approved" : "❌ Denied"}</p><p>You can close this tab and return to the demo — it already picked up the result.</p></div></body></html>`;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>Approve request</title><style>${style}</style></head><body>
    <div class="card">
      <h1>idp.deferred-token-response.dev</h1>
      <p><strong>${opts.clientId}</strong> is requesting access on behalf of <strong>${opts.subject}</strong>.</p>
      <dl>
        <dt>Resource</dt><dd>${opts.resource}</dd>
        <dt>Scope</dt><dd>${opts.scope}</dd>
      </dl>
      <form method="POST" action="/interact?session=${encodeURIComponent(opts.sessionId ?? "")}">
        <input type="hidden" name="code" value="${opts.code}">
        <button class="approve" name="decision" value="approve">Approve</button>
        <button class="deny" name="decision" value="deny">Deny</button>
      </form>
    </div>
  </body></html>`;
}
