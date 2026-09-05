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

const logBody = document.getElementById("log-body");
const logCount = document.getElementById("log-count");
let events = 0;

function appendLog(actor, message, ts = Date.now()) {
  events += 1;
  logCount.textContent = `${events} event${events === 1 ? "" : "s"}`;
  const line = document.createElement("div");
  line.className = `log-line ${actor}`;
  const time = new Date(ts).toLocaleTimeString([], { hour12: false });
  line.innerHTML = `<span class="ts">${time}</span><span class="actor">${actor}</span><span class="msg"></span>`;
  line.querySelector(".msg").textContent = message;
  logBody.appendChild(line);
  logBody.scrollTop = logBody.scrollHeight;
}

function basicAuthHeader() {
  return "Basic " + btoa(`${CLIENT_ID}:${CLIENT_SECRET}`);
}

// --- WebSocket to the AS's session Durable Object ---
let ws;
let currentStatus = null;
function connectSocket() {
  ws = new WebSocket(`${IDP.replace("https://", "wss://")}/events?session=${encodeURIComponent(sessionId)}`);
  ws.addEventListener("message", (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.type === "log") appendLog("as", msg.message, msg.ts);
    if (msg.type === "state") renderAsState(msg.state);
  });
  ws.addEventListener("close", () => setTimeout(connectSocket, 2000));
}
connectSocket();

function renderAsState(state) {
  const dl = document.getElementById("as-state");
  const endUserView = document.getElementById("end-user-view");
  currentStatus = state ? state.status : null;
  const approveBtn = document.getElementById("approve-btn");
  const denyBtn = document.getElementById("deny-btn");
  const decidable = currentStatus === "authorization_pending";
  approveBtn.disabled = !decidable;
  denyBtn.disabled = !decidable;

  if (!state) {
    dl.innerHTML = "<dt>status</dt><dd>no active request</dd>";
    endUserView.textContent = "No consent recorded yet.";
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
    `${state.context.subject} already granted ${state.scope || "this scope"} for a ` +
    `${state.context.amount} transfer to ${state.context.recipient} via the regular ` +
    `Authorization Code flow. Nothing further is needed from them.`;
}

// --- Step 1: simulate the already-completed auth code flow ---
let currentCode = null;
document.getElementById("seed-btn").addEventListener("click", async () => {
  const body = {
    subject: document.getElementById("f-subject").value,
    amount: document.getElementById("f-amount").value,
    recipient: document.getElementById("f-recipient").value,
    scope: "wire_transfers.initiate",
  };
  appendLog("client", `simulating completed Authorization Code consent for ${body.subject}`);
  const res = await fetch(`${IDP}/admin/seed-auth-code?session=${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  currentCode = data.code;
  const view = document.getElementById("code-view");
  view.style.display = "block";
  view.textContent = `code=${data.code}`;
  document.getElementById("send-btn").disabled = false;
  appendLog("client", "consent recorded upstream — ready to send the token request");
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
  appendLog("client", "POST /token  grant_type=authorization_code completion_mode=deferred");
  const res = await fetch(`${IDP}/token?session=${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: basicAuthHeader() },
    body: params,
  });
  const data = await res.json();
  appendLog("client", `response ${res.status}: ${data.error ?? "ok"}`);

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
  appendLog("client", `poll  deferral_code=${code.slice(0, 12)}…`);
  const res = await fetch(`${IDP}/token?session=${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: basicAuthHeader() },
    body: params,
  });
  const data = await res.json();

  if (res.ok) {
    appendLog("client", "received 200 OK — access_token issued");
    setStatus("ok", "resolved");
    document.getElementById("result-card").style.display = "block";
    document.getElementById("result-view").textContent = JSON.stringify(data, null, 2);
    return;
  }

  appendLog("client", `poll response: ${data.error}`);
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
  document.getElementById("code-view").style.display = "none";
  document.getElementById("send-btn").disabled = true;
  document.getElementById("result-card").style.display = "none";
  setStatus("idle", "idle");
  appendLog("client", "session reset");
});

// --- Hamburger menu ---
const menuBtn = document.getElementById("menu-btn");
const menuDropdown = document.getElementById("menu-dropdown");
menuBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  menuDropdown.hidden = !menuDropdown.hidden;
});
document.addEventListener("click", (e) => {
  if (!menuDropdown.hidden && !menuDropdown.contains(e.target) && e.target !== menuBtn) menuDropdown.hidden = true;
});
