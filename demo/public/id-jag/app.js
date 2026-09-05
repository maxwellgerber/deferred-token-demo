const IDP = "https://idp.deferred-token-response.dev";
const CLIENT_ID = "demo-client";
const CLIENT_SECRET = "demo-secret";

const sessionId = (() => {
  const existing = localStorage.getItem("dtr-demo-session-id-jag");
  if (existing) return existing;
  const fresh = crypto.randomUUID();
  localStorage.setItem("dtr-demo-session-id-jag", fresh);
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

// --- WebSocket to the AS's session Durable Object: AS-side logs + state push ---
let ws;
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
  if (!state) {
    dl.innerHTML = "<dt>status</dt><dd>no active request</dd>";
    return;
  }
  dl.innerHTML = `
    <dt>status</dt><dd>${state.status}</dd>
    <dt>deferral_code</dt><dd>${state.deferral_code.slice(0, 16)}…</dd>
    <dt>subject</dt><dd>${state.subject}</dd>
    <dt>resource</dt><dd>${state.resource}</dd>
    <dt>scope</dt><dd>${state.scope}</dd>
  `;
}

// --- Step 1: mint assertion ---
let currentAssertion = null;
document.getElementById("mint-btn").addEventListener("click", async () => {
  const body = {
    subject: document.getElementById("f-subject").value,
    resource: document.getElementById("f-resource").value,
    scope: document.getElementById("f-scope").value,
  };
  appendLog("client", `requesting a fresh ID-JAG for ${body.subject}`);
  const res = await fetch(`${IDP}/admin/mint-assertion?session=${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  currentAssertion = data.assertion;
  const view = document.getElementById("assertion-view");
  view.style.display = "block";
  view.textContent = JSON.stringify(data.claims, null, 2) + "\n\n" + data.assertion;
  document.getElementById("send-btn").disabled = false;
  appendLog("client", "assertion minted — ready to send the token request");
});

// --- Step 2: send the token request ---
document.getElementById("send-btn").addEventListener("click", async () => {
  if (!currentAssertion) return;
  document.getElementById("send-btn").disabled = true;
  setStatus("pending", "sending token request…");
  const params = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: currentAssertion,
    completion_mode: "deferred",
  });
  appendLog("client", "POST /token  grant_type=jwt-bearer completion_mode=deferred");
  const res = await fetch(`${IDP}/token?session=${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: basicAuthHeader() },
    body: params,
  });
  const data = await res.json();
  appendLog("client", `response ${res.status}: ${data.error ?? "ok"}`);

  if (data.error === "authorization_pending" && data.deferral_code) {
    setStatus("pending", "authorization_pending — polling…");
    startPolling(data.deferral_code, data.interval);
  } else {
    setStatus("error", data.error ?? "unexpected response");
    document.getElementById("send-btn").disabled = false;
  }
});

// --- Step 3: poll ---
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
    document.getElementById("interaction-slot").innerHTML = "";
    return;
  }

  appendLog("client", `poll response: ${data.error}`);

  switch (data.error) {
    case "authorization_pending":
      setStatus("pending", "authorization_pending — waiting on the authorization server");
      schedulePoll(code);
      return;
    case "interaction_required":
      setStatus("pending", "interaction_required — user action needed");
      showInteractionLink(data.interaction_uri);
      schedulePoll(code);
      return;
    case "interaction_pending":
      setStatus("pending", "interaction_pending — user is deciding");
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

function showInteractionLink(uri) {
  const slot = document.getElementById("interaction-slot");
  if (slot.dataset.uri === uri) return;
  slot.dataset.uri = uri;
  slot.innerHTML = `<a class="interaction-link" target="_blank" rel="noopener" href="${uri}">Open interaction page →</a>`;
  appendLog("client", "opening interaction_uri in a new tab for the user to decide");
}

function setStatus(kind, text) {
  const pill = document.getElementById("status-pill");
  pill.className = `status-pill ${kind}`;
  pill.textContent = text;
}

// --- Reset ---
document.getElementById("reset-btn").addEventListener("click", async () => {
  clearTimeout(pollTimer);
  await fetch(`${IDP}/admin/reset?session=${encodeURIComponent(sessionId)}`, { method: "POST" });
  currentAssertion = null;
  document.getElementById("assertion-view").style.display = "none";
  document.getElementById("send-btn").disabled = true;
  document.getElementById("result-card").style.display = "none";
  document.getElementById("interaction-slot").innerHTML = "";
  setStatus("idle", "idle");
  appendLog("client", "session reset");
});
