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

// --- WebSocket to the AS's session Durable Object: AS-side logs + state push ---
let ws;
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
  if (!state) {
    dl.innerHTML = "<dt>status</dt><dd>no active request</dd>";
    return;
  }
  dl.innerHTML = `
    <dt>status</dt><dd>${state.status}</dd>
    <dt>deferral_code</dt><dd>${state.deferral_code.slice(0, 16)}…</dd>
    <dt>subject</dt><dd>${state.context.subject}</dd>
    <dt>resource</dt><dd>${state.context.resource}</dd>
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
  document.getElementById("result-card").style.display = "none";
  document.getElementById("interaction-slot").innerHTML = "";
  DTR.beginAttempt();
  setStatus("pending", "sending token request…");
  const params = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: currentAssertion,
    completion_mode: "deferred",
  });
  appendLog("client", "POST /token  grant_type=jwt-bearer completion_mode=deferred", undefined, {
    request: requestDetailFor(params),
  });
  const res = await fetch(`${IDP}/token?session=${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: basicAuthHeader() },
    body: params,
  });
  const data = await res.json();
  appendLog("client", `response ${res.status}: ${data.error ?? "ok"}`, undefined, { response: { status: res.status, body: data } });

  if (data.error === "authorization_pending" && data.deferral_code) {
    setStatus("pending", "authorization_pending — polling…");
    startPolling(data.deferral_code, data.interval);
  } else {
    DTR.endAttempt();
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
  appendLog("client", `poll  deferral_code=${code.slice(0, 12)}…`, undefined, { request: requestDetailFor(params) });
  const res = await fetch(`${IDP}/token?session=${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: basicAuthHeader() },
    body: params,
  });
  const data = await res.json();

  if (res.ok) {
    appendLog("client", "received 200 OK — access_token issued", undefined, { response: { status: res.status, body: data } });
    DTR.endAttempt();
    setStatus("ok", "resolved");
    document.getElementById("result-card").style.display = "block";
    document.getElementById("result-view").textContent = JSON.stringify(data, null, 2);
    document.getElementById("interaction-slot").innerHTML = "";
    document.getElementById("send-btn").disabled = false;
    closeInteractionPopup();
    return;
  }

  appendLog("client", `poll response: ${data.error}`, undefined, { response: { status: res.status, body: data } });

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
      DTR.endAttempt();
      setStatus("error", "access_denied");
      document.getElementById("send-btn").disabled = false;
      return;
    case "expired_token":
      DTR.endAttempt();
      setStatus("error", "expired_token");
      document.getElementById("send-btn").disabled = false;
      return;
    default:
      DTR.endAttempt();
      setStatus("error", data.error ?? "unknown error");
      document.getElementById("send-btn").disabled = false;
      return;
  }
}

function schedulePoll(code) {
  clearTimeout(pollTimer);
  if (DTR.pollingPaused) {
    DTR.armResume(() => poll(code));
    return;
  }
  pollTimer = setTimeout(() => poll(code), pollInterval * 1000);
  DTR.armResume(() => poll(code), pollTimer);
}

let interactionPopup = null;
function showInteractionLink(uri) {
  const slot = document.getElementById("interaction-slot");
  if (slot.dataset.uri === uri) return;
  slot.dataset.uri = uri;
  slot.innerHTML = `<button class="btn interaction-link" id="interaction-btn">Open interaction page →</button>`;
  document.getElementById("interaction-btn").addEventListener("click", () => {
    interactionPopup = window.open(
      uri,
      "dtr-interaction",
      "width=460,height=560,menubar=no,toolbar=no,location=no,status=no",
    );
  });
  appendLog("client", "interaction_uri received — click to open it in a popup for the user to decide");
}

function closeInteractionPopup() {
  if (interactionPopup && !interactionPopup.closed) interactionPopup.close();
  interactionPopup = null;
}

function setStatus(kind, text) {
  const pill = document.getElementById("status-pill");
  pill.className = `status-pill ${kind}`;
  pill.textContent = text;
}

// --- Reset ---
document.getElementById("reset-btn").addEventListener("click", async () => {
  clearTimeout(pollTimer);
  closeInteractionPopup();
  DTR.endAttempt();
  await fetch(`${IDP}/admin/reset?session=${encodeURIComponent(sessionId)}`, { method: "POST" });
  currentAssertion = null;
  document.getElementById("assertion-view").style.display = "none";
  document.getElementById("send-btn").disabled = true;
  document.getElementById("result-card").style.display = "none";
  document.getElementById("interaction-slot").innerHTML = "";
  setStatus("idle", "idle");
  appendLog("client", "session reset");
});
