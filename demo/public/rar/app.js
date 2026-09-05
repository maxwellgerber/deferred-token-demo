const IDP = "https://idp.deferred-token-response.dev";
const CLIENT_ID = "demo-client";
const CLIENT_SECRET = "demo-secret";

const DOCUMENTS = [
  { id: "doc-1", name: "Q3 Planning Doc" },
  { id: "doc-2", name: "Engineering Roadmap" },
  { id: "doc-3", name: "Budget Spreadsheet" },
];

const sessionId = (() => {
  const existing = localStorage.getItem("dtr-demo-session-rar");
  if (existing) return existing;
  const fresh = crypto.randomUUID();
  localStorage.setItem("dtr-demo-session-rar", fresh);
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

function selectedDocument() {
  const id = document.getElementById("f-document").value;
  return DOCUMENTS.find((d) => d.id === id);
}

function docLabel(id) {
  const doc = DOCUMENTS.find((d) => d.id === id);
  return doc ? `${doc.id} (${doc.name})` : id;
}

function buildAuthorizationDetails() {
  const doc = selectedDocument();
  return [
    {
      type: "document_access",
      actions: ["view"],
      document_id: doc.id,
      document_name: doc.name,
    },
  ];
}

let grantedDocuments = [];

function renderDetailsPreview() {
  document.getElementById("details-view").textContent = JSON.stringify(buildAuthorizationDetails(), null, 2);
  renderGrantedNote();
}
document.getElementById("f-document").addEventListener("change", renderDetailsPreview);
renderDetailsPreview();

// --- WebSocket to the AS's session Durable Object ---
let ws;
let currentStatus = null;
function connectSocket() {
  ws = new WebSocket(`${IDP.replace("https://", "wss://")}/events?session=${encodeURIComponent(sessionId)}`);
  ws.addEventListener("message", (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.type === "log") appendLog("as", msg.message, msg.ts, msg.detail);
    if (msg.type === "state") {
      renderAsState(msg.state);
      grantedDocuments = msg.grantedDocuments || [];
      renderGrantedList();
      renderGrantedNote();
    }
  });
  ws.addEventListener("close", () => setTimeout(connectSocket, 2000));
}
connectSocket();

function renderAsState(state) {
  const dl = document.getElementById("as-state");
  currentStatus = state ? state.status : null;
  const approveBtn = document.getElementById("approve-btn");
  const denyBtn = document.getElementById("deny-btn");
  const decidable = currentStatus === "authorization_pending";
  approveBtn.disabled = !decidable;
  denyBtn.disabled = !decidable;
  if (!state) {
    dl.innerHTML = "<dt>status</dt><dd>no active request</dd>";
    return;
  }
  dl.innerHTML = `
    <dt>status</dt><dd>${state.status}</dd>
    <dt>deferral_code</dt><dd>${state.deferral_code.slice(0, 16)}…</dd>
    <dt>document</dt><dd>${docLabel(state.context.document_id)}</dd>
  `;
}

function renderGrantedList() {
  const el = document.getElementById("granted-list");
  if (!grantedDocuments.length) {
    el.textContent = "None yet — every document starts ungranted.";
    return;
  }
  el.innerHTML = grantedDocuments
    .map(
      (id) => `
        <li>
          <span>${escapeHtml(docLabel(id))}</span>
          <button class="btn secondary revoke-btn" data-doc-id="${escapeHtml(id)}">Revoke</button>
        </li>
      `,
    )
    .join("");
  el.querySelectorAll(".revoke-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      await fetch(`${IDP}/admin/revoke-document?session=${encodeURIComponent(sessionId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ document_id: btn.dataset.docId }),
      });
    });
  });
}

function renderGrantedNote() {
  const note = document.getElementById("granted-note");
  const doc = selectedDocument();
  if (grantedDocuments.includes(doc.id)) {
    note.textContent = `✓ ${doc.id} was already granted to this client — this request will resolve synchronously, no deferral.`;
    note.style.display = "block";
  } else {
    note.style.display = "none";
  }
}

// --- Send token request ---
document.getElementById("send-btn").addEventListener("click", async () => {
  document.getElementById("send-btn").disabled = true;
  document.getElementById("result-card").style.display = "none";
  DTR.beginAttempt();
  setStatus("pending", "sending token request…");
  const details = buildAuthorizationDetails();
  const params = new URLSearchParams({
    grant_type: "client_credentials",
    authorization_details: JSON.stringify(details),
    completion_mode: "deferred",
  });
  appendLog("client", "POST /token  grant_type=client_credentials completion_mode=deferred", undefined, {
    request: requestDetailFor(params),
  });
  const res = await fetch(`${IDP}/token?session=${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: basicAuthHeader() },
    body: params,
  });
  const data = await res.json();

  if (res.ok) {
    appendLog("client", "received 200 OK — access_token issued synchronously (already granted, no deferral)", undefined, {
      response: { status: res.status, body: data },
    });
    setStatus("ok", "resolved synchronously — no deferral needed");
    document.getElementById("result-card").style.display = "block";
    document.getElementById("result-view").textContent = JSON.stringify(data, null, 2);
    document.getElementById("send-btn").disabled = false;
    DTR.endAttempt();
    return;
  }

  appendLog("client", `response ${res.status}: ${data.error ?? "ok"}`, undefined, { response: { status: res.status, body: data } });

  if (data.error === "authorization_pending" && data.deferral_code) {
    setStatus("pending", "authorization_pending — waiting on the resource owner");
    startPolling(data.deferral_code, data.interval);
  } else {
    DTR.endAttempt();
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
    document.getElementById("send-btn").disabled = false;
    DTR.endAttempt();
    return;
  }

  appendLog("client", `poll response: ${data.error}`, undefined, { response: { status: res.status, body: data } });
  switch (data.error) {
    case "authorization_pending":
      setStatus("pending", "authorization_pending — waiting on the resource owner");
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
      DTR.endAttempt();
      return;
    case "expired_token":
      setStatus("error", "expired_token");
      document.getElementById("send-btn").disabled = false;
      DTR.endAttempt();
      return;
    default:
      setStatus("error", data.error ?? "unknown error");
      document.getElementById("send-btn").disabled = false;
      DTR.endAttempt();
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

function setStatus(kind, text) {
  const pill = document.getElementById("status-pill");
  pill.className = `status-pill ${kind}`;
  pill.textContent = text;
}

// --- Resource owner console ---
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
  DTR.endAttempt();
  await fetch(`${IDP}/admin/reset?session=${encodeURIComponent(sessionId)}`, { method: "POST" });
  document.getElementById("send-btn").disabled = false;
  document.getElementById("result-card").style.display = "none";
  setStatus("idle", "idle");
  appendLog("client", "session reset");
});
