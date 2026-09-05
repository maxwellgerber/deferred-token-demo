const IDP = "https://idp.deferred-token-response.dev";

const sessionId = (() => {
  const existing = localStorage.getItem("dtr-demo-session-fraud-review");
  if (existing) return existing;
  const fresh = crypto.randomUUID();
  localStorage.setItem("dtr-demo-session-fraud-review", fresh);
  return fresh;
})();
document.getElementById("session-tag").textContent = `session ${sessionId.slice(0, 8)}`;

// --- WebSocket to the AS's session Durable Object ---
let ws;
let currentStatus = null;
function connectSocket() {
  ws = new WebSocket(`${IDP.replace("https://", "wss://")}/events?session=${encodeURIComponent(sessionId)}`);
  ws.addEventListener("message", (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.type === "log") appendLog("as", msg.message, msg.ts, msg.detail);
    if (msg.type === "state") renderAsState(msg.state);
  });
  ws.addEventListener("close", () => setTimeout(connectSocket, 2000));
}
connectSocket();

function renderAsState(state) {
  const dl = document.getElementById("as-state");
  const endUserView = document.getElementById("end-user-view");
  const reviewDetail = document.getElementById("review-detail");
  currentStatus = state ? state.status : null;
  const approveBtn = document.getElementById("approve-btn");
  const denyBtn = document.getElementById("deny-btn");
  const decidable = currentStatus === "authorization_pending";
  approveBtn.disabled = !decidable;
  denyBtn.disabled = !decidable;

  if (!state) {
    dl.innerHTML = "<dt>status</dt><dd>no active request</dd>";
    endUserView.textContent = "No consent recorded yet.";
    reviewDetail.innerHTML = "";
    return;
  }
  dl.innerHTML = `
    <dt>status</dt><dd>${state.status}</dd>
    <dt>deferral_code</dt><dd>${state.deferral_code.slice(0, 16)}…</dd>
    <dt>subject</dt><dd>${escapeHtml(state.context.subject)}</dd>
    <dt>amount</dt><dd>${escapeHtml(state.context.amount)}</dd>
    <dt>recipient</dt><dd>${escapeHtml(state.context.recipient)}</dd>
  `;
  endUserView.textContent =
    `${state.context.subject} (standing: ${state.context.senderStanding}) already granted ${state.scope || "this scope"} for a ` +
    `${state.context.amount} transfer to ${state.context.recipient} via the regular ` +
    `Authorization Code flow. Nothing further is needed from them.`;
  reviewDetail.innerHTML = `
    <dt>memo</dt><dd>${escapeHtml(state.context.memo || "(none)")}</dd>
    <dt>sender standing</dt><dd>${escapeHtml(state.context.subject)} — ${escapeHtml(state.context.senderStanding)}</dd>
    <dt>recipient standing</dt><dd>${escapeHtml(state.context.recipient)} — ${escapeHtml(state.context.recipientStanding)}</dd>
    <dt>recipient history</dt><dd>${escapeHtml(state.context.recipientHistory || "—")}</dd>
  `;
}

// --- Step 1: real Authorization Code consent screen, opened as a popup ---
let currentCode = null;
let authPopup = null;
document.getElementById("start-auth-btn").addEventListener("click", () => {
  // Starting over: clear whatever a previous attempt left behind before doing anything else.
  currentCode = null;
  document.getElementById("send-btn").disabled = true;
  document.getElementById("result-card").style.display = "none";
  document.getElementById("auth-status").textContent = "";

  const amount = document.getElementById("f-amount").value;
  const recipient = document.getElementById("f-recipient").value;
  const memo = document.getElementById("f-memo").value;
  const state = crypto.randomUUID();
  const redirectUri = `${location.origin}/fraud-review/callback.html`;

  // RFC 9396 Rich Authorization Requests — the transfer's terms travel as a structured
  // authorization_details entry, not as flat amount/recipient/memo query params.
  const authorizationDetails = [
    {
      type: "payment_initiation",
      actions: ["initiate"],
      instructedAmount: { currency: "USD", amount },
      creditorAccount: { identifier: recipient },
      remittanceInformationUnstructured: memo,
    },
  ];

  const url = new URL(`${IDP}/authorize`);
  url.searchParams.set("session", sessionId);
  url.searchParams.set("client_id", DTR.CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "wire_transfers.initiate");
  url.searchParams.set("authorization_details", JSON.stringify(authorizationDetails));
  url.searchParams.set("state", state);

  authPopup = window.open(url.toString(), "dtr-authorize", "width=460,height=560,menubar=no,toolbar=no,location=no,status=no");
  authPopup.__dtrState = state;
  document.getElementById("auth-status").textContent = "Waiting on alice@example.com in the popup…";
  appendLog("client", `opened /authorize consent screen for alice@example.com ($${amount} to ${recipient})`);
});

window.addEventListener("message", (evt) => {
  if (evt.origin !== location.origin) return;
  if (!evt.data) return;
  const expectedState = authPopup && authPopup.__dtrState;
  if (expectedState && evt.data.state !== expectedState) {
    appendLog("client", "ignored postMessage: state mismatch (possible CSRF) — discarding response");
    return;
  }
  if (evt.data.error) {
    document.getElementById("auth-status").textContent = `Consent screen returned: ${evt.data.error}`;
    appendLog("client", `consent denied: ${evt.data.error}`);
    return;
  }
  if (evt.data.code) {
    currentCode = evt.data.code;
    document.getElementById("auth-status").textContent = "Authorization code received — ready to send the token request.";
    document.getElementById("send-btn").disabled = false;
    appendLog("client", "received authorization code from the consent screen");
  }
});

// --- Step 2: send the token request ---
document.getElementById("send-btn").addEventListener("click", async () => {
  if (!currentCode) return;
  document.getElementById("send-btn").disabled = true;
  document.getElementById("auth-status").textContent = "Token request sent — waiting on the result.";
  DTR.beginAttempt();
  DTR.setStatus("pending", "sending token request…");
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code: currentCode,
    completion_mode: "deferred",
  });
  appendLog("client", "POST /token  grant_type=authorization_code completion_mode=deferred", undefined, {
    request: DTR.requestDetailFor(params),
  });
  const res = await fetch(`${IDP}/token?session=${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: DTR.basicAuthHeader() },
    body: params,
  });
  const data = await res.json();

  if (res.ok) {
    appendLog("client", "received 200 OK — access_token issued synchronously (at or under the review threshold)", undefined, {
      response: { status: res.status, body: data },
    });
    DTR.endAttempt();
    DTR.setStatus("ok", "resolved synchronously — no fraud review needed");
    document.getElementById("result-card").style.display = "block";
    document.getElementById("result-view").textContent = JSON.stringify(data, null, 2);
    document.getElementById("auth-status").textContent = "Code redeemed — click \"Start authorization\" to submit another transfer.";
    currentCode = null; // redeemed — a new attempt needs a fresh code from "Start authorization"
    return;
  }

  appendLog("client", `response ${res.status}: ${data.error ?? "ok"}`, undefined, { response: { status: res.status, body: data } });

  if (data.error === "authorization_pending" && data.deferral_code) {
    DTR.setStatus("pending", "authorization_pending — waiting on fraud review");
    startPolling(data.deferral_code, data.interval);
  } else {
    DTR.endAttempt();
    DTR.setStatus("error", data.error ?? "unexpected response");
    document.getElementById("auth-status").textContent = "Something went wrong — click \"Start authorization\" to try again.";
    currentCode = null;
  }
});

// --- Poll ---
const pollState = { timer: null, interval: 4 };

function startPolling(code, interval) {
  pollState.interval = interval ?? 4;
  poll(code);
}

async function poll(code) {
  const params = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:deferred", deferral_code: code });
  appendLog("client", `poll  deferral_code=${code.slice(0, 12)}…`, undefined, { request: DTR.requestDetailFor(params) });
  const res = await fetch(`${IDP}/token?session=${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: DTR.basicAuthHeader() },
    body: params,
  });
  const data = await res.json();

  if (res.ok) {
    appendLog("client", "received 200 OK — access_token issued", undefined, { response: { status: res.status, body: data } });
    DTR.endAttempt();
    DTR.setStatus("ok", "resolved");
    document.getElementById("result-card").style.display = "block";
    document.getElementById("result-view").textContent = JSON.stringify(data, null, 2);
    document.getElementById("auth-status").textContent = "Code redeemed — click \"Start authorization\" to submit another transfer.";
    currentCode = null; // redeemed — a new attempt needs a fresh code from "Start authorization"
    return;
  }

  appendLog("client", `poll response: ${data.error}`, undefined, { response: { status: res.status, body: data } });
  switch (data.error) {
    case "authorization_pending":
      DTR.setStatus("pending", "authorization_pending — waiting on fraud review");
      schedulePoll(code);
      return;
    case "slow_down":
      pollState.interval += 5;
      appendLog("client", `backing off to ${pollState.interval}s per slow_down`);
      schedulePoll(code);
      return;
    case "access_denied":
      DTR.endAttempt();
      DTR.setStatus("error", "access_denied");
      document.getElementById("auth-status").textContent = "Request denied — click \"Start authorization\" to try again.";
      currentCode = null;
      return;
    case "expired_token":
      DTR.endAttempt();
      DTR.setStatus("error", "expired_token");
      document.getElementById("auth-status").textContent = "Deferral expired — click \"Start authorization\" to try again.";
      currentCode = null;
      return;
    default:
      DTR.endAttempt();
      DTR.setStatus("error", data.error ?? "unknown error");
      document.getElementById("auth-status").textContent = "Something went wrong — click \"Start authorization\" to try again.";
      currentCode = null;
      return;
  }
}

function schedulePoll(code) {
  DTR.schedulePoll(pollState, () => poll(code));
}

// --- Fraud review console ---
async function decide(decision) {
  document.getElementById("approve-btn").disabled = true;
  document.getElementById("deny-btn").disabled = true;
  await fetch(`${IDP}/admin/decide?session=${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision }),
  });
}
document.getElementById("approve-btn").addEventListener("click", () => decide("approve"));
document.getElementById("deny-btn").addEventListener("click", () => decide("deny"));

// --- Reset ---
document.getElementById("reset-btn").addEventListener("click", async () => {
  clearTimeout(pollState.timer);
  DTR.endAttempt();
  await fetch(`${IDP}/admin/reset?session=${encodeURIComponent(sessionId)}`, { method: "POST" });
  currentCode = null;
  document.getElementById("auth-status").textContent = "";
  document.getElementById("send-btn").disabled = true;
  document.getElementById("result-card").style.display = "none";
  DTR.setStatus("idle", "idle");
  appendLog("client", "session reset");
});
