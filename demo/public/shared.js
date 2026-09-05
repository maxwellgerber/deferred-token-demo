// Shared across all scenario pages: log tray rendering, hamburger menu, resizable tray,
// and a small pause/resume-polling helper. Loaded before each scenario's own app.js.

const logBody = document.getElementById("log-body");
const logCount = document.getElementById("log-count");
let events = 0;

function appendLog(actor, message, ts = Date.now(), detail = null) {
  events += 1;
  logCount.textContent = `${events} event${events === 1 ? "" : "s"}`;
  const line = document.createElement("div");
  line.className = `log-line ${actor}` + (detail ? " has-detail" : "");
  const time = new Date(ts).toLocaleTimeString([], { hour12: false });
  line.innerHTML = `<span class="chevron">${detail ? "▸" : ""}</span><span class="ts">${time}</span><span class="actor">${actor}</span><span class="msg"></span>`;
  line.querySelector(".msg").textContent = message;
  logBody.appendChild(line);

  if (detail) {
    const detailEl = document.createElement("div");
    detailEl.className = "log-detail";
    detailEl.innerHTML = renderLogDetail(detail);
    logBody.appendChild(detailEl);
    line.addEventListener("click", () => {
      const open = detailEl.classList.toggle("open");
      line.querySelector(".chevron").textContent = open ? "▾" : "▸";
    });
  }

  logBody.scrollTop = logBody.scrollHeight;
}

function renderLogDetail(detail) {
  const parts = [];
  if (detail.request) parts.push(`<div class="detail-label">Request</div><pre>${escapeHtml(formatWireDetail(detail.request))}</pre>`);
  if (detail.response) parts.push(`<div class="detail-label">Response</div><pre>${escapeHtml(formatWireDetail(detail.response))}</pre>`);
  return parts.join("");
}

function formatWireDetail(obj) {
  if (obj && typeof obj === "object" && "method" in obj) {
    const lines = [`${obj.method} ${obj.path || obj.url || ""}`];
    if (obj.headers) for (const [k, v] of Object.entries(obj.headers)) lines.push(`${k}: ${v}`);
    if (obj.body !== undefined) lines.push("", typeof obj.body === "string" ? obj.body : JSON.stringify(obj.body, null, 2));
    return lines.join("\n");
  }
  if (obj && typeof obj === "object" && "status" in obj) {
    const lines = [`HTTP ${obj.status}`];
    if (obj.body !== undefined) lines.push("", JSON.stringify(obj.body, null, 2));
    return lines.join("\n");
  }
  return JSON.stringify(obj, null, 2);
}

function escapeHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// --- Hamburger menu ---
function setupMenu() {
  const menuBtn = document.getElementById("menu-btn");
  const menuDropdown = document.getElementById("menu-dropdown");
  if (!menuBtn || !menuDropdown) return;
  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    menuDropdown.hidden = !menuDropdown.hidden;
  });
  document.addEventListener("click", (e) => {
    if (!menuDropdown.hidden && !menuDropdown.contains(e.target) && e.target !== menuBtn) menuDropdown.hidden = true;
  });
}
setupMenu();

// --- Resizable log tray ---
function setupTrayResize() {
  const tray = document.querySelector("footer.tray");
  const handle = document.getElementById("tray-resize-handle");
  if (!tray || !handle) return;
  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = tray.getBoundingClientRect().height;
    document.body.style.userSelect = "none";
    const onMove = (moveEvt) => {
      const delta = startY - moveEvt.clientY;
      const newHeight = Math.min(Math.max(startHeight + delta, 80), window.innerHeight - 160);
      tray.style.height = `${newHeight}px`;
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}
setupTrayResize();

// --- Pause/resume polling ---
// Contract for scenario app.js files:
// - Call DTR.beginAttempt() the moment a new request is sent (re-arms pause, clears terminal).
// - Call DTR.armResume(() => poll(code), timerId) every time schedulePoll() sets a timer, so
//   pausing can cancel a timer that was already scheduled before the pause click (not just
//   block *future* scheduling — a plain "check a flag before scheduling" check is not enough).
// - Call DTR.endAttempt() the moment the attempt reaches ANY terminal state (success, denied,
//   expired, or an unexpected error) so a stale "Resume polling" click can't re-poll an
//   already-redeemed/denied code and clobber the result that's already on screen.
window.DTR = {
  pollingPaused: false,
  resumeCallback: null,
  activeTimer: null,
  terminal: true, // no active attempt until beginAttempt() is called

  armResume(cb, timerId) {
    this.resumeCallback = cb;
    this.activeTimer = timerId ?? null;
  },

  clearActiveTimer() {
    if (this.activeTimer) clearTimeout(this.activeTimer);
    this.activeTimer = null;
  },

  beginAttempt() {
    this.terminal = false;
    this.pollingPaused = false;
    this.resumeCallback = null;
    this.clearActiveTimer();
    const btn = document.getElementById("pause-btn");
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Pause polling";
      btn.classList.remove("paused");
    }
  },

  endAttempt() {
    this.terminal = true;
    this.pollingPaused = false;
    this.resumeCallback = null;
    this.clearActiveTimer();
    const btn = document.getElementById("pause-btn");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "No polling";
      btn.classList.remove("paused");
    }
  },
};

function setupPauseButton() {
  const btn = document.getElementById("pause-btn");
  if (!btn) return;
  btn.disabled = true; // no active attempt at page load
  btn.textContent = "No polling";
  btn.addEventListener("click", () => {
    if (window.DTR.terminal) return; // guard against a stale click after the attempt resolved
    window.DTR.pollingPaused = !window.DTR.pollingPaused;
    btn.textContent = window.DTR.pollingPaused ? "Resume polling" : "Pause polling";
    btn.classList.toggle("paused", window.DTR.pollingPaused);
    if (window.DTR.pollingPaused) {
      window.DTR.clearActiveTimer();
      appendLog("client", "polling paused");
    } else if (window.DTR.resumeCallback) {
      appendLog("client", "polling resumed");
      window.DTR.resumeCallback();
    }
  });
}
setupPauseButton();
