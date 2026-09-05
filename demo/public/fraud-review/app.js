const IDP = "https://idp.deferred-token-response.dev";
const CLIENT_ID = "demo-client";
const CLIENT_SECRET = "demo-secret";

const sessionId = (() => {
  const existing = localStorage.getItem("dtr-demo-session-fraud-review");
  if (existing) return existing;
  const fresh = crypto.randomUUID();
  localStorage.setItem("dtr-demo-session-fraud-review", fresh);
  return fresh;
})();
document.getElementById("session-tag").textContent = `session ${sessionId.slice(0, 8)}`;

function basicAuthHeader() {
  return "Basic " + btoa(`${CLIENT_ID}:${CLIENT_SECRET}`);
}

function requestDetailFor(params) {
  return {
    method: "POST",
    path: "/token",
    headers: { Authorization: basicAuthHeader(), "Content-Type": "application/x-www-form-urlencoded" },
    body: Object.fromEntries(params),
  };
}

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
    <dt>subject</dt><dd>${state.context.subject}</dd>
    <dt>amount</dt><dd>${state.context.amount}</dd>
    <dt>recipient</dt><dd>${state.context.recipient}</dd>
  `;
  endUserView.textContent =
    `${state.context.subject} (standing: ${state.context.senderStanding}) already granted ${state.scope || "this scope"} for a ` +
    `${state.context.amount} transfer to ${state.context.recipient} via the regular ` +
    `Authorization Code flow. Nothing further is needed from them.`;
  reviewDetail.innerHTML = `
    <dt>memo</dt><dd>${escapeHtml(state.context.memo || "(none)")}</dd>
    <dt>sender standing</dt><dd>${state.context.subject} — ${state.context.senderStanding}</dd>
    <dt>recipient standing</dt><dd>${state.context.recipient} — ${state.context.recipientStanding}</dd>
    <dt>recipient history</dt><dd>${escapeHtml(state.context.recipientHistory || "—")}</dd>
  `;
}

// --- Step 1: real Authorization Code consent screen, opened as a popup ---
let currentCode = null;
let authPopup = null;
document.getElementById("start-auth-btn").addEventListener("click", () => {
  const amount = document.getElementById("f-amount").value;
  const recipient = document.getElementById("f-recipient").value;
  const memo = document.getElementById("f-memo").value;
  const state = crypto.randomUUID();
  const redirectUri = `${location.origin}/fraud-review/callback.html`;

  const url = new URL(`${IDP}/authorize`);
  url.searchParams.set("session", sessionId);
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "wire_transfers.initiate");
  url.searchParams.set("amount", amount);
  url.searchParams.set("recipient", recipient);
  url.searchParams.set("memo", memo);
  url.searchParams.set("state", state);

  authPopup = window.open(url.toString(), "dtr-authorize", "width=460,height=560,menubar=no,toolbar=no,location=no,status=no");
  authPopup.__dtrState = state;
  document.getElementById("auth-status").textContent = "Waiting on alice@example.com in the popup…";
  appendLog("client", `opened /authorize consent screen for alice@example.com ($${amount} to ${recipient})`);
});

window.addEventListener("message", (evt) => {
  if (evt.origin !== location.origin) return;
  if (!evt.data) return;
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
  setStatus("pending", "sending token request…");
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code: currentCode,
    completion_mode: "deferred",
  });
  appendLog("client", "POST /token  grant_type=authorization_code completion_mode=deferred", undefined, {
    request: requestDetailFor(params),
  });
  const res = await fetch(`${IDP}/token?session=${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: basicAuthHeader() },
    body: params,
  });
  const data = await res.json();

  if (res.ok) {
    appendLog("client", "received 200 OK — access_token issued synchronously (at or under the review threshold)", undefined, {
      response: { status: res.status, body: data },
    });
    setStatus("ok", "resolved synchronously — no fraud review needed");
    document.getElementById("result-card").style.display = "block";
    document.getElementById("result-view").textContent = JSON.stringify(data, null, 2);
    document.getElementById("send-btn").disabled = false;
    return;
  }

  appendLog("client", `response ${res.status}: ${data.error ?? "ok"}`, undefined, { response: { status: res.status, body: data } });

  if (data.error === "authorization_pending" && data.deferral_code) {
    setStatus("pending", "authorization_pending — waiting on fraud review");
    startPolling(data.deferral_code, data.interval);
  } else {
    setStatus("error", data.error ?? "unexpected response");
    document.getElementById("send-btn").disabled = false;
  }
});

// --- Poll ---
let pollTimer = null;
let pollInterval = 4;

function startPolling(code, interval) {
  pollInterval = interval ?? 4;
  poll(code);
}

async function poll(code) {
  const params = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:deferred", deferral_code: code });
  appendLog("client", `poll  deferral_code=${code.slice(0, 12)}…`, undefined, { request: requestDetailFor(params) });
  const res = await fetch(`${IDP}/token?session=${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: basicAuthHeader() },
    body: params,
  });
  const data = await res.json();

  if (res.ok) {
    appendLog("client", "received 200 OK — access_token issued", undefined, { response: { status: res.status, body: data } });
    setStatus("ok", "resolved");
    document.getElementById("result-card").style.display = "block";
    document.getElementById("result-view").textContent = JSON.stringify(data, null, 2);
    return;
  }

  appendLog("client", `poll response: ${data.error}`, undefined, { response: { status: res.status, body: data } });
  switch (data.error) {
    case "authorization_pending":
      setStatus("pending", "authorization_pending — waiting on fraud review");
      schedulePoll(code);
      return;
    case "slow_down":
      pollInterval += 5;
      appendLog("client", `backing off to ${pollInterval}s per slow_down`);
      schedulePoll(code);
      return;
    case "access_denied":
      setStatus("error", "access_denied");
      document.getElementById("send-btn").disabled = false;
      return;
    case "expired_token":
      setStatus("error", "expired_token");
      document.getElementById("send-btn").disabled = false;
      return;
    default:
      setStatus("error", data.error ?? "unknown error");
      document.getElementById("send-btn").disabled = false;
      return;
  }
}

function schedulePoll(code) {
  clearTimeout(pollTimer);
  DTR.armResume(() => poll(code));
  if (DTR.pollingPaused) return;
  pollTimer = setTimeout(() => poll(code), pollInterval * 1000);
}

function setStatus(kind, text) {
  const pill = document.getElementById("status-pill");
  pill.className = `status-pill ${kind}`;
  pill.textContent = text;
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
  clearTimeout(pollTimer);
  await fetch(`${IDP}/admin/reset?session=${encodeURIComponent(sessionId)}`, { method: "POST" });
  currentCode = null;
  document.getElementById("auth-status").textContent = "";
  document.getElementById("send-btn").disabled = true;
  document.getElementById("result-card").style.display = "none";
  setStatus("idle", "idle");
  appendLog("client", "session reset");
});
