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
const FRAUD_REVIEW_THRESHOLD = 1000; // USD — transfers over this always go to fraud review
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // no demo session needs to outlive a day

const ACCOUNT_STANDING: Record<string, string> = {
  "alice@example.com": "good",
  "acct:bob-9182": "risky",
};

const DEFAULT_RECIPIENT_HISTORY: Record<string, { total: number; count: number }> = {
  "acct:bob-9182": { total: 34200, count: 7 },
};

type DeferralStatus =
  | "authorization_pending"
  | "interaction_required"
  | "interaction_pending"
  | "resolved"
  | "redeemed"
  | "denied"
  | "expired";

type Scenario = "id-jag" | "rar-client-credentials" | "fraud-review";

// Scenarios differ in how a pending request ever gets resolved:
// - id-jag: the client is handed an interaction_uri and can route a human there itself.
// - rar-client-credentials / fraud-review: nobody the client can reach needs to act — the
//   resource owner or a reviewer acts through the authorization server's own console. These
//   scenarios never leave authorization_pending; there is no interaction_uri to hand out.
const SCENARIOS_WITH_CLIENT_ROUTABLE_INTERACTION: Scenario[] = ["id-jag"];

interface DeferralRecord {
  status: DeferralStatus;
  scenario: Scenario;
  deferral_code: string;
  created_at: number;
  expires_in: number;
  interval: number;
  interaction_uri: string;
  client_id: string;
  scope: string;
  last_poll_at: number;
  // Scenario-specific fields, shown as-is in the AS panel and admin/state.
  context: Record<string, string>;
  // Scenario-specific data needed to build an accurate success response.
  authorizationDetails?: unknown[];
}

interface PendingAuthCode {
  code: string;
  subject: string;
  amount: string;
  recipient: string;
  memo: string;
  scope: string;
  authorizationDetails: unknown[];
  redeemed: boolean;
}

// The fraud-review scenario carries the transfer's terms as an RFC 9396 authorization_details
// entry (type=payment_initiation) rather than ad hoc amount/recipient/memo query params —
// consistent with how a real client would express a payment-initiation request. See
// https://www.rfc-editor.org/rfc/rfc9396 for the worked example this is modeled on.
interface PaymentInitiationDetail {
  type?: string;
  actions?: string[];
  instructedAmount?: { currency?: string; amount?: string };
  creditorAccount?: { identifier?: string };
  remittanceInformationUnstructured?: string;
}

function parsePaymentAuthorizationDetails(raw: string | null): {
  details: unknown[];
  amount: string;
  recipient: string;
  memo: string;
} {
  let details: unknown[] = [];
  try {
    const parsed = JSON.parse(raw ?? "[]");
    if (Array.isArray(parsed)) details = parsed;
  } catch {
    details = [];
  }
  const payment = (details.find((d) => (d as PaymentInitiationDetail)?.type === "payment_initiation") ??
    {}) as PaymentInitiationDetail;
  return {
    details,
    amount: payment.instructedAmount?.amount ?? "0.00",
    recipient: payment.creditorAccount?.identifier ?? "",
    memo: payment.remittanceInformationUnstructured ?? "",
  };
}

function escapeHtmlAttr(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function parseCompletionMode(form: FormData): string[] {
  return String(form.get("completion_mode") ?? "").split(" ").filter(Boolean);
}

function mintAccessToken(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    access_token: `demo_at_${generateOpaqueId(96)}`,
    token_type: "Bearer",
    expires_in: 3600,
    ...extra,
  };
}

type RecipientHistory = Record<string, { total: number; count: number }>;

export class DemoSession extends DurableObject<Env> {
  private deferral: DeferralRecord | null = null;
  private pendingAuthCode: PendingAuthCode | null = null;
  private grantedDocuments: string[] = [];
  private recipientHistory: RecipientHistory = {};
  private loaded = false;

  private async ensureLoaded() {
    if (this.loaded) return;
    this.deferral = ((await this.ctx.storage.get("deferral")) as DeferralRecord | undefined) ?? null;
    this.pendingAuthCode = ((await this.ctx.storage.get("pendingAuthCode")) as PendingAuthCode | undefined) ?? null;
    this.grantedDocuments = ((await this.ctx.storage.get("grantedDocuments")) as string[] | undefined) ?? [];
    this.recipientHistory =
      ((await this.ctx.storage.get("recipientHistory")) as RecipientHistory | undefined) ?? { ...DEFAULT_RECIPIENT_HISTORY };
    this.loaded = true;
  }

  private async persist() {
    await this.ctx.storage.put("deferral", this.deferral);
  }

  private async persistAuthCode() {
    await this.ctx.storage.put("pendingAuthCode", this.pendingAuthCode);
  }

  private async persistGrantedDocuments() {
    await this.ctx.storage.put("grantedDocuments", this.grantedDocuments);
  }

  private async persistRecipientHistory() {
    await this.ctx.storage.put("recipientHistory", this.recipientHistory);
  }

  // Fires when a full day passes with no request against this session (fetch() keeps pushing
  // this out on every request). Wipes the session back to a fresh, empty state — nothing here
  // needs to outlive that.
  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
    this.deferral = null;
    this.pendingAuthCode = null;
    this.grantedDocuments = [];
    this.recipientHistory = { ...DEFAULT_RECIPIENT_HISTORY };
    this.loaded = true;
  }

  private formatHistory(recipient: string): string {
    const entry = this.recipientHistory[recipient];
    if (!entry || entry.count === 0) return "no prior transfers in the last 30 days";
    return `$${entry.total.toLocaleString()} across ${entry.count} transfer${entry.count === 1 ? "" : "s"} in the last 30 days`;
  }

  // A request that resolves synchronously (already-granted document, at-or-under-threshold
  // transfer) never creates a deferral — but if a *previous* request left one behind (e.g. a
  // denied doc-2), the AS panel would otherwise keep showing that stale deferral as if it were
  // this request's outcome. Clear it and broadcast so the panel honestly reflects "no deferral."
  private async clearDeferralForSynchronousResolution() {
    if (!this.deferral) return;
    this.deferral = null;
    await this.persist();
    this.broadcastState();
  }

  private async bumpRecipientHistory(recipient: string, amount: number) {
    const entry = this.recipientHistory[recipient] ?? { total: 0, count: 0 };
    entry.total += amount;
    entry.count += 1;
    this.recipientHistory[recipient] = entry;
    await this.persistRecipientHistory();
  }

  // Using ctx.getWebSockets() (not an in-memory Set) is what makes this survive hibernation —
  // the DO can be evicted from memory between messages, and a plain field would lose its
  // contents on the next wake. Cloudflare tracks attached sockets independently of the instance.
  private log(message: string, detail?: { request?: unknown; response?: unknown }) {
    const payload = JSON.stringify({ type: "log", ts: Date.now(), actor: "as", message, detail });
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(payload);
      } catch {
        // Cloudflare prunes closed sockets from getWebSockets() automatically.
      }
    }
  }

  private broadcastState() {
    const payload = JSON.stringify({ type: "state", state: this.deferral, grantedDocuments: this.grantedDocuments });
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(payload);
      } catch {
        // Cloudflare prunes closed sockets from getWebSockets() automatically.
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    await this.ensureLoaded();
    // Rolling TTL: every request (including WebSocket keepalive/polling) pushes expiry out
    // another day; a session untouched for a full day gets its storage cleared in alarm().
    await this.ctx.storage.setAlarm(Date.now() + SESSION_TTL_MS);
    const url = new URL(request.url);
    const sessionId = url.searchParams.get("session") ?? "";

    if (request.method === "OPTIONS") return corsPreflight();

    if (url.pathname === "/events") return this.handleWebSocket();
    if (url.pathname === "/token" && request.method === "POST") return this.handleToken(request, sessionId);
    if (url.pathname === "/interact" && request.method === "GET") return this.handleInteractionPage(url, sessionId);
    if (url.pathname === "/interact" && request.method === "POST") return this.handleInteractionDecision(request);
    if (url.pathname === "/authorize" && request.method === "GET") return this.handleAuthorizePage(url, sessionId);
    if (url.pathname === "/authorize" && request.method === "POST") return this.handleAuthorizeDecision(request);
    if (url.pathname === "/admin/mint-assertion" && request.method === "POST") return this.handleMintAssertion(request);
    if (url.pathname === "/admin/decide" && request.method === "POST") return this.handleAdminDecide(request);
    if (url.pathname === "/admin/revoke-document" && request.method === "POST") return this.handleRevokeDocument(request);
    if (url.pathname === "/admin/state" && request.method === "GET")
      return jsonResponse(200, {
        state: this.deferral,
        grantedDocuments: this.grantedDocuments,
        recipientHistory: this.recipientHistory,
      });
    if (url.pathname === "/admin/reset" && request.method === "POST") {
      this.deferral = null;
      this.pendingAuthCode = null;
      this.grantedDocuments = [];
      this.recipientHistory = { ...DEFAULT_RECIPIENT_HISTORY };
      await this.persist();
      await this.persistAuthCode();
      await this.persistGrantedDocuments();
      await this.persistRecipientHistory();
      this.log("session reset");
      this.broadcastState();
      return jsonResponse(200, { ok: true });
    }

    return jsonResponse(404, { error: "not_found" });
  }

  private handleWebSocket(): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    // Hibernation API: lets the runtime evict this DO from memory between pushes (these sockets
    // are log/state push only, quiet in between) instead of billing the whole time a tab is open.
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type: "state", state: this.deferral, grantedDocuments: this.grantedDocuments }));
    return new Response(null, { status: 101, webSocket: client });
  }

  // Required for the Hibernation API to apply — no client-to-server messages are expected on
  // this socket, it's log/state push only, and Cloudflare handles removing closed/errored
  // sockets from ctx.getWebSockets() on its own.
  async webSocketMessage(): Promise<void> {}
  async webSocketClose(): Promise<void> {}
  async webSocketError(): Promise<void> {}

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

  // --- Admin/setup endpoints: these stand in for steps upstream of DTR itself (minting an
  // identity assertion via Token Exchange, or a user completing the Authorization Code flow). ---

  private async handleMintAssertion(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const subject = (body.subject as string) || "alice@example.com";
    const resource = (body.resource as string) || "db://prod-orders";
    const scope = (body.scope as string) || "database.read";
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

  // --- Real Authorization Code flow for the fraud-review scenario: a consent screen for
  // alice@example.com, reached via an actual redirect (opened as a popup by the client). ---

  private handleAuthorizePage(url: URL, sessionId: string): Response {
    const params = url.searchParams;
    const redirectUri = params.get("redirect_uri") ?? "";
    const scope = params.get("scope") ?? "wire_transfers.initiate";
    const state = params.get("state") ?? "";
    const { details, amount, recipient, memo } = parsePaymentAuthorizationDetails(params.get("authorization_details"));
    this.log(`GET /authorize — rendering consent screen for alice@example.com ($${amount} to ${recipient})`);
    return new Response(
      renderAuthorizePage({ sessionId, redirectUri, authorizationDetails: details, amount, recipient, memo, scope, state }),
      { headers: { "Content-Type": "text/html" } },
    );
  }

  private async handleAuthorizeDecision(request: Request): Promise<Response> {
    const form = await request.formData().catch(() => null);
    if (!form) return jsonResponse(400, { error: "invalid_request", error_description: "expected application/x-www-form-urlencoded" });
    const redirectUri = String(form.get("redirect_uri") ?? "");
    const scope = String(form.get("scope") ?? "wire_transfers.initiate");
    const state = String(form.get("state") ?? "");
    const decision = form.get("decision");
    const { details, amount, recipient, memo } = parsePaymentAuthorizationDetails(String(form.get("authorization_details") ?? "[]"));

    let redirectUrl: URL;
    try {
      redirectUrl = new URL(redirectUri);
    } catch {
      return jsonResponse(400, { error: "invalid_request", error_description: "invalid redirect_uri" });
    }
    if (state) redirectUrl.searchParams.set("state", state);

    if (decision !== "approve") {
      this.log("alice@example.com denied the Authorization Code consent screen");
      redirectUrl.searchParams.set("error", "access_denied");
      return Response.redirect(redirectUrl.toString(), 302);
    }

    this.pendingAuthCode = {
      code: `demo_code_${generateOpaqueId(96)}`,
      subject: "alice@example.com",
      amount,
      recipient,
      memo,
      scope,
      authorizationDetails: details,
      redeemed: false,
    };
    await this.persistAuthCode();
    this.log(`alice@example.com approved the consent screen — granted ${scope} for a $${amount} transfer to ${recipient}`);
    redirectUrl.searchParams.set("code", this.pendingAuthCode.code);
    return Response.redirect(redirectUrl.toString(), 302);
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

    const requestDetail = {
      method: "POST",
      path: "/token",
      headers: {
        Authorization: request.headers.get("Authorization") ?? "",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: Object.fromEntries(form.entries()),
    };

    let response: Response;
    if (grantType === "urn:ietf:params:oauth:grant-type:jwt-bearer") {
      response = await this.handleIdJagRequest(form, clientId);
    } else if (grantType === "client_credentials") {
      response = await this.handleClientCredentialsRequest(form, clientId);
    } else if (grantType === "authorization_code") {
      response = await this.handleAuthorizationCodeRequest(form, clientId);
    } else if (grantType === "urn:ietf:params:oauth:grant-type:deferred") {
      response = await this.handlePoll(form, clientId, sessionId);
    } else {
      this.log(`token request rejected: unsupported grant_type ${String(grantType)}`);
      response = jsonResponse(400, { error: "unsupported_grant_type" });
    }

    const responseBody = await response
      .clone()
      .json()
      .catch(() => null);
    this.log(`⇄ POST /token → ${response.status}`, {
      request: requestDetail,
      response: { status: response.status, body: responseBody },
    });
    return response;
  }

  // --- Scenario 1: ID-JAG against a production database. database.read is granted
  // automatically; database.delete always requires human interaction. ---

  private async handleIdJagRequest(form: FormData, clientId: string): Promise<Response> {
    const completionMode = parseCompletionMode(form);
    const assertion = form.get("assertion");
    this.log(`token request received: grant_type=jwt-bearer completion_mode=${completionMode.join(",") || "(none)"}`);

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

    const scope = String(decoded.claims.scope ?? "");
    this.log(`assertion validated: sub=${decoded.claims.sub} resource=${decoded.claims.resource} scope=${scope}`);

    if (!scope.includes("database.delete")) {
      this.log("policy: database.read is granted automatically — no interaction needed");
      return tokenSuccessResponse(mintAccessToken({ scope }));
    }

    if (!completionMode.includes("deferred")) {
      this.log("client did not opt in to completion_mode=deferred — database.delete always needs interaction");
      return jsonResponse(400, { error: "invalid_request", error_description: "database.delete requires completion_mode=deferred" });
    }

    this.log("policy: database.delete always requires human interaction before granting access — deferring");

    this.startDeferral(clientId, "id-jag", scope, {
      subject: String(decoded.claims.sub),
      resource: String(decoded.claims.resource),
    });
    await this.persist();
    this.broadcastState();
    this.log(`returning authorization_pending, deferral_code=${this.deferral!.deferral_code.slice(0, 12)}…`);

    return deferredErrorResponse("authorization_pending", {
      deferral_code: this.deferral!.deferral_code,
      expires_in: this.deferral!.expires_in,
      interval: this.deferral!.interval,
    });
  }

  // --- Scenario 2: client_credentials + RAR. No user in this grant at all, so nobody the
  // client can reach needs to act — the resource owner reviews and decides through the
  // authorization server's own console (this demo's AS panel), not an interaction_uri. ---

  private async handleClientCredentialsRequest(form: FormData, clientId: string): Promise<Response> {
    const completionMode = parseCompletionMode(form);
    const rawDetails = form.get("authorization_details");
    this.log(`token request received: grant_type=client_credentials completion_mode=${completionMode.join(",") || "(none)"}`);

    let details: unknown[];
    try {
      details = JSON.parse(String(rawDetails ?? "[]"));
      if (!Array.isArray(details)) throw new Error("not an array");
    } catch {
      return jsonResponse(400, { error: "invalid_request", error_description: "authorization_details must be a JSON array (RFC 9396)" });
    }
    this.log(`authorization_details received: ${JSON.stringify(details)}`);

    const first = (details[0] ?? {}) as Record<string, unknown>;
    const documentId = String(first.document_id ?? "");

    if (documentId && this.grantedDocuments.includes(documentId)) {
      this.log(`policy: ${documentId} was already granted to this client — issuing a token immediately, no deferral needed`);
      await this.clearDeferralForSynchronousResolution();
      return tokenSuccessResponse(mintAccessToken({ authorization_details: details }));
    }

    if (!completionMode.includes("deferred")) {
      this.log("client did not opt in to completion_mode=deferred — this demo requires it for a document that hasn't been granted yet");
      return jsonResponse(400, { error: "invalid_request", error_description: "this resource requires completion_mode=deferred" });
    }

    this.log(
      `policy: ${documentId || "this document"} has not been granted before — the resource owner must confirm. client_credentials carries ` +
        "no user context, so there is no one for the client to route an interaction_uri to. Resolution happens on the AS's own console.",
    );

    this.startDeferral(clientId, "rar-client-credentials", "", {
      document_id: documentId,
      document_name: String(first.document_name ?? ""),
      authorization_details: JSON.stringify(details, null, 2),
    });
    this.deferral!.authorizationDetails = details;
    await this.persist();
    this.broadcastState();
    this.log(`returning authorization_pending, deferral_code=${this.deferral!.deferral_code.slice(0, 12)}… (no interaction_uri — none will ever be issued)`);

    return deferredErrorResponse("authorization_pending", {
      deferral_code: this.deferral!.deferral_code,
      expires_in: this.deferral!.expires_in,
      interval: this.deferral!.interval,
    });
  }

  // --- Scenario 3: fraud review. A real end user grants consent via an actual Authorization
  // Code redirect (the /authorize consent screen above). Transfers over the threshold then
  // additionally need a fraud reviewer — not the end user — to sign off before the token issues.
  // Transfers at or under the threshold are the AS's call to complete synchronously. ---

  private async handleAuthorizationCodeRequest(form: FormData, clientId: string): Promise<Response> {
    const completionMode = parseCompletionMode(form);
    const code = form.get("code");
    this.log(`token request received: grant_type=authorization_code completion_mode=${completionMode.join(",") || "(none)"}`);

    if (!this.pendingAuthCode || this.pendingAuthCode.code !== code || this.pendingAuthCode.redeemed) {
      this.log("authorization_code rejected: unrecognized or already-redeemed code");
      return jsonResponse(400, { error: "invalid_grant" });
    }

    const { subject, amount, recipient, memo, scope, authorizationDetails } = this.pendingAuthCode;
    const amountNum = Number.parseFloat(amount) || 0;
    this.pendingAuthCode.redeemed = true;
    await this.persistAuthCode();

    this.log(`authorization_code validated: end user ${subject} granted ${scope} for a $${amount} transfer to ${recipient}`);

    if (amountNum <= FRAUD_REVIEW_THRESHOLD) {
      this.log(`policy: $${amount} is at or under the $${FRAUD_REVIEW_THRESHOLD.toLocaleString()} fraud-review threshold — issuing the token immediately`);
      await this.bumpRecipientHistory(recipient, amountNum);
      await this.clearDeferralForSynchronousResolution();
      return tokenSuccessResponse(mintAccessToken({ scope, authorization_details: authorizationDetails }));
    }

    if (!completionMode.includes("deferred")) {
      this.log(`client did not opt in to completion_mode=deferred — this demo requires it for transfers over $${FRAUD_REVIEW_THRESHOLD.toLocaleString()}`);
      return jsonResponse(400, {
        error: "invalid_request",
        error_description: `this resource requires completion_mode=deferred for transfers over $${FRAUD_REVIEW_THRESHOLD.toLocaleString()}`,
      });
    }

    this.log(`policy: $${amount} exceeds the $${FRAUD_REVIEW_THRESHOLD.toLocaleString()} threshold — routing to fraud review before the token is issued`);

    this.startDeferral(clientId, "fraud-review", scope, {
      subject,
      amount: `$${amount}`,
      recipient,
      memo: memo || "(no memo)",
      senderStanding: ACCOUNT_STANDING[subject] ?? "unknown",
      recipientStanding: ACCOUNT_STANDING[recipient] ?? "unknown",
      recipientHistory: this.formatHistory(recipient),
    });
    this.deferral!.authorizationDetails = authorizationDetails;
    await this.persist();
    this.broadcastState();
    this.log(`returning authorization_pending, deferral_code=${this.deferral!.deferral_code.slice(0, 12)}… (no interaction_uri — the end user already consented; only the reviewer's decision remains)`);

    return deferredErrorResponse("authorization_pending", {
      deferral_code: this.deferral!.deferral_code,
      expires_in: this.deferral!.expires_in,
      interval: this.deferral!.interval,
    });
  }

  private startDeferral(clientId: string, scenario: Scenario, scope: string, context: Record<string, string>) {
    this.deferral = {
      status: "authorization_pending",
      scenario,
      deferral_code: generateOpaqueId(),
      created_at: Date.now(),
      expires_in: DEFERRAL_EXPIRES_IN,
      interval: POLL_INTERVAL,
      interaction_uri: "",
      client_id: clientId,
      scope,
      last_poll_at: 0,
      context,
    };
  }

  // --- Polling: the DTR substrate. Identical across scenarios except which ones ever offer
  // an interaction_uri (see SCENARIOS_WITH_CLIENT_ROUTABLE_INTERACTION). ---

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

    const routable = SCENARIOS_WITH_CLIENT_ROUTABLE_INTERACTION.includes(this.deferral.scenario);

    if (this.deferral.status === "authorization_pending" && routable) {
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

    if (this.deferral.status === "authorization_pending") {
      this.log("poll response: authorization_pending (unchanged — waiting on the AS console, nothing for the client to do)");
      return jsonResponse(400, { error: "authorization_pending" });
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
      if (this.deferral.scenario === "rar-client-credentials" && this.deferral.context.document_id) {
        const docId = this.deferral.context.document_id;
        if (!this.grantedDocuments.includes(docId)) {
          this.grantedDocuments.push(docId);
          await this.persistGrantedDocuments();
          this.log(`${docId} added to this client's granted documents — future requests for it will resolve synchronously`);
        }
      }
      if (this.deferral.scenario === "fraud-review" && this.deferral.context.recipient) {
        const amountNum = Number.parseFloat(this.deferral.context.amount?.replace(/[$,]/g, "") ?? "0") || 0;
        await this.bumpRecipientHistory(this.deferral.context.recipient, amountNum);
      }
      await this.persist();
      this.broadcastState();
      this.log("poll response: 200 OK — access_token issued, deferral_code redeemed");
      const response = mintAccessToken();
      if (this.deferral.scope) response.scope = this.deferral.scope;
      if (this.deferral.authorizationDetails) response.authorization_details = this.deferral.authorizationDetails;
      return tokenSuccessResponse(response);
    }

    // redeemed or expired
    this.log(`poll rejected: deferral_code already ${this.deferral.status}`);
    return jsonResponse(400, { error: this.deferral.status === "expired" ? "expired_token" : "invalid_grant" });
  }

  // --- Resolution paths ---
  // Scenario 1: a human navigates to a dedicated interaction page (client-routable).
  // Scenarios 2 & 3: the decision is made directly on the AS panel — /admin/decide — since
  // nobody was ever handed a link to click.

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
        subject: this.deferral.context.subject,
        clientId: this.deferral.client_id,
        resource: this.deferral.context.resource,
        scope: this.deferral.scope,
        decided: this.deferral.status === "resolved" || this.deferral.status === "redeemed" || this.deferral.status === "denied",
        status: this.deferral.status,
      }),
      { headers: { "Content-Type": "text/html" } },
    );
  }

  private async handleInteractionDecision(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const sessionId = url.searchParams.get("session") ?? "";
    const form = await request.formData().catch(() => null);
    if (!form) return jsonResponse(400, { error: "invalid_request", error_description: "expected application/x-www-form-urlencoded" });
    const code = form.get("code");
    const decision = form.get("decision");
    if (!this.deferral || this.deferral.deferral_code !== code) {
      return new Response(renderInteractPage({ notFound: true }), { headers: { "Content-Type": "text/html" } });
    }
    if (decision === "approve") {
      this.deferral.status = "resolved";
      this.log(`user approved the request at the interaction page (subject=${this.deferral.context.subject})`);
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
        subject: this.deferral.context.subject,
        clientId: this.deferral.client_id,
        resource: this.deferral.context.resource,
        scope: this.deferral.scope,
        decided: true,
        status: this.deferral.status,
      }),
      { headers: { "Content-Type": "text/html" } },
    );
  }

  private async handleAdminDecide(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as { decision?: string };
    if (!this.deferral) return jsonResponse(404, { error: "no_active_request" });
    if (SCENARIOS_WITH_CLIENT_ROUTABLE_INTERACTION.includes(this.deferral.scenario)) {
      return jsonResponse(400, { error: "invalid_request", error_description: "this scenario resolves via the interaction page, not the admin console" });
    }
    const actor = this.deferral.scenario === "rar-client-credentials" ? "resource owner" : "fraud reviewer";
    if (body.decision === "approve") {
      this.deferral.status = "resolved";
      this.log(`${actor} approved the request via the AS console`);
    } else {
      this.deferral.status = "denied";
      this.log(`${actor} denied the request via the AS console`);
    }
    await this.persist();
    this.broadcastState();
    return jsonResponse(200, { ok: true, status: this.deferral.status });
  }

  // Resource-owner control for the RAR scenario's stateful grant: undo a previous approval so
  // the next request for that document goes through the review process again.
  private async handleRevokeDocument(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as { document_id?: string };
    const docId = body.document_id;
    if (!docId) return jsonResponse(400, { error: "invalid_request", error_description: "missing document_id" });
    const idx = this.grantedDocuments.indexOf(docId);
    if (idx === -1) return jsonResponse(404, { error: "not_found", error_description: "document was not granted" });
    this.grantedDocuments.splice(idx, 1);
    await this.persistGrantedDocuments();
    this.log(`resource owner revoked ${docId} — the next request for it will require approval again`);
    this.broadcastState();
    return jsonResponse(200, { ok: true, grantedDocuments: this.grantedDocuments });
  }
}

// Shared by renderInteractPage and renderAuthorizePage — both are small standalone consent
// pages opened as a popup, with the same dark card-on-dark-background look.
const CONSENT_PAGE_STYLE = `
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #101114; color: #eceef2; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { max-width: 440px; background: #17181d; border: 1px solid #2a2c34; border-radius: 12px; padding: 2rem; }
  h1 { font-size: 1.05rem; margin-top: 0; color: #9a9fac; font-weight: 600; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: .3rem 1rem; font-size: .9rem; color: #9a9fac; margin: 1.2rem 0; }
  dt { font-weight: 600; color: #eceef2; }
  dd { margin: 0; word-break: break-all; }
  pre { background: #1b1c22; border: 1px solid #2a2c34; border-radius: 8px; padding: .7rem .8rem; font-size: .74rem; line-height: 1.5; overflow-x: auto; color: #9a9fac; margin: 0 0 1.2rem; }
  button { font-size: .95rem; font-weight: 600; padding: .6rem 1.2rem; border-radius: 8px; border: none; cursor: pointer; margin-right: .6rem; }
  .approve { background: #4fd188; color: #05170c; }
  .deny { background: #ff6b64; color: #200604; }
  .result { font-size: 1.3rem; font-weight: 600; }
`;

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
  const style = CONSENT_PAGE_STYLE;
  if (opts.notFound) {
    return `<!doctype html><html><head><meta charset="utf-8"><title>Interaction — not found</title><style>${style}</style></head><body><div class="card"><h1>Request not found</h1><p>This interaction link is invalid or the session has been reset.</p></div></body></html>`;
  }
  if (opts.decided) {
    const approved = opts.status === "resolved" || opts.status === "redeemed";
    return `<!doctype html><html><head><meta charset="utf-8"><title>Interaction — done</title><style>${style}</style></head><body><div class="card"><h1>idp.deferred-token-response.dev</h1><p class="result">${approved ? "✅ Approved" : "❌ Denied"}</p><p>This window will close automatically — the demo already picked up the result.</p></div><script>setTimeout(() => window.close(), 1200);</script></body></html>`;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>Approve request</title><style>${style}</style></head><body>
    <div class="card">
      <h1>idp.deferred-token-response.dev</h1>
      <p><strong>${escapeHtmlAttr(opts.clientId ?? "")}</strong> is requesting access on behalf of <strong>${escapeHtmlAttr(opts.subject ?? "")}</strong>.</p>
      <dl>
        <dt>Resource</dt><dd>${escapeHtmlAttr(opts.resource ?? "")}</dd>
        <dt>Scope</dt><dd>${escapeHtmlAttr(opts.scope ?? "")}</dd>
      </dl>
      <form method="POST" action="/interact?session=${encodeURIComponent(opts.sessionId ?? "")}">
        <input type="hidden" name="code" value="${escapeHtmlAttr(opts.code ?? "")}">
        <button class="approve" name="decision" value="approve">Approve</button>
        <button class="deny" name="decision" value="deny">Deny</button>
      </form>
    </div>
  </body></html>`;
}

function renderAuthorizePage(opts: {
  sessionId: string;
  redirectUri: string;
  authorizationDetails: unknown[];
  amount: string;
  recipient: string;
  memo: string;
  scope: string;
  state: string;
}): string {
  const style = CONSENT_PAGE_STYLE;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Sign in to approve</title><style>${style}</style></head><body>
    <div class="card">
      <h1>idp.deferred-token-response.dev</h1>
      <p><strong>demo-client</strong> is requesting your approval, <strong>alice@example.com</strong>.</p>
      <dl>
        <dt>Amount</dt><dd>$${escapeHtmlAttr(opts.amount)}</dd>
        <dt>Recipient</dt><dd>${escapeHtmlAttr(opts.recipient)}</dd>
        <dt>Memo</dt><dd>${escapeHtmlAttr(opts.memo) || "(none)"}</dd>
        <dt>Scope</dt><dd>${escapeHtmlAttr(opts.scope)}</dd>
      </dl>
      <p style="font-size:.78rem; color:#565a66; margin:0 0 .4rem;">authorization_details (RFC 9396):</p>
      <pre>${escapeHtmlAttr(JSON.stringify(opts.authorizationDetails, null, 2))}</pre>
      <form method="POST" action="/authorize?session=${encodeURIComponent(opts.sessionId)}">
        <input type="hidden" name="redirect_uri" value="${escapeHtmlAttr(opts.redirectUri)}">
        <input type="hidden" name="authorization_details" value="${escapeHtmlAttr(JSON.stringify(opts.authorizationDetails))}">
        <input type="hidden" name="scope" value="${escapeHtmlAttr(opts.scope)}">
        <input type="hidden" name="state" value="${escapeHtmlAttr(opts.state)}">
        <button class="approve" name="decision" value="approve">Approve</button>
        <button class="deny" name="decision" value="deny">Deny</button>
      </form>
    </div>
  </body></html>`;
}
