// ---------- Bridge status ----------
async function refresh() {
  const res = await chrome.runtime.sendMessage({ type: "popup_status" });
  if (!res) return;
  const dot = document.getElementById("status-dot");
  const text = document.getElementById("status-text");
  const takeOverBtn = document.getElementById("take-over-btn");
  if (res.status === "connected" && res.role === "active") {
    dot.className = "dot ok";
    text.textContent = "Active";
    takeOverBtn.style.display = "none";
  } else if (res.status === "connected" && res.role === "standby") {
    dot.className = "dot standby";
    text.textContent = "Standby";
    takeOverBtn.style.display = "block";
  } else {
    dot.className = "dot bad";
    text.textContent = "Disconnected";
    takeOverBtn.style.display = "none";
  }

  const count = res.sessionCount ?? 0;
  const sessionText = document.getElementById("session-text");
  if (count === 0) {
    sessionText.textContent = "none";
  } else {
    const tabs = (res.sessions ?? []).reduce((n, s) => n + s.tabCount, 0);
    sessionText.textContent = `${count} session${count > 1 ? "s" : ""}, ${tabs} tab${tabs !== 1 ? "s" : ""}`;
  }

  // Sync the auto-connect switch with state (only if user isn't actively toggling)
  const sw = document.getElementById("auto-connect-switch");
  if (sw && document.activeElement !== sw) sw.checked = !!res.connectionEnabled;
}

document.getElementById("take-over-btn").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "popup_take_over" });
  refresh();
});

document.getElementById("toggle-btn").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "popup_toggle" });
  refresh();
});
document.getElementById("auto-connect-switch").addEventListener("change", async () => {
  await chrome.runtime.sendMessage({ type: "popup_toggle" });
  refresh();
});

document.getElementById("end-session-btn").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "popup_end_all_sessions" });
  refresh();
});

refresh();
setInterval(refresh, 1500);

// ---------- Claude Sessions (read-only status) ----------
// Send-hint UI lives only in the in-page modal (⌘⇧M). Popup just shows
// the list so you can verify your session is registered + see queued hints.
async function refreshClaudeSessions() {
  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: "popup_get_claude_sessions" });
  } catch { return; }
  const sessions = (res && Array.isArray(res.sessions)) ? res.sessions : [];

  const empty = document.getElementById("claude-empty");
  const cta = document.getElementById("claude-cta");
  const list = document.getElementById("claude-list");

  for (const el of list.querySelectorAll(".session-row")) el.remove();

  if (sessions.length === 0) {
    empty.style.display = "block";
    cta.style.display = "none";
    return;
  }
  empty.style.display = "none";
  cta.style.display = "block";

  for (const s of sessions) {
    const row = document.createElement("div");
    row.className = "session-row";
    const name = document.createElement("span");
    name.className = "session-name";
    name.title = `${s.name} · ${s.sessionId}`;
    name.textContent = s.name || s.sessionId;
    const badge = document.createElement("span");
    badge.className = "session-badge" + (s.queuedCount ? " queued" : "");
    badge.textContent = s.queuedCount > 0 ? `${s.queuedCount} queued` : "idle";
    row.appendChild(name);
    row.appendChild(badge);
    list.insertBefore(row, empty);
  }
}

refreshClaudeSessions();
setInterval(refreshClaudeSessions, 1500);

// ---------- Visuals settings ----------
async function loadVisuals() {
  const v = (await chrome.storage.local.get(["visualsDefault"])).visualsDefault
    ?? { enabled: true, cursor: true, hud: true, slowMo: 0 };
  document.getElementById("visuals-cursor").checked = !!v.cursor;
  document.getElementById("visuals-hud").checked = !!v.hud;
  document.getElementById("visuals-slowmo").value = String(v.slowMo ?? 0);
}

async function saveVisuals() {
  const v = {
    enabled: true,
    cursor: document.getElementById("visuals-cursor").checked,
    hud:    document.getElementById("visuals-hud").checked,
    slowMo: Math.max(0, Math.min(5000, Number(document.getElementById("visuals-slowmo").value) || 0)),
  };
  await chrome.storage.local.set({ visualsDefault: v });
}

["visuals-cursor","visuals-hud","visuals-slowmo"].forEach((id) => {
  document.getElementById(id).addEventListener("change", saveVisuals);
});

loadVisuals();

// ---------- Notifications ----------
const notifEls = {
  sw:      () => document.getElementById("notif-switch"),
  onboard: () => document.getElementById("notif-onboard"),
  test:    () => document.getElementById("notif-test-btn"),
  confirm: () => document.getElementById("notif-confirm"),
  help:    () => document.getElementById("notif-help"),
  status:  () => document.getElementById("notif-status"),
};

async function refreshNotif() {
  let res;
  try { res = await chrome.runtime.sendMessage({ type: "popup_notif_status" }); } catch { return; }
  if (!res) return;
  const sw = notifEls.sw();
  if (sw && document.activeElement !== sw) sw.checked = !!res.enabled;

  // Chrome's own notification permission ("denied" = blocked at the browser
  // level, distinct from the macOS toggle). Re-show onboarding if it's denied
  // even after a prior verify, so a later revocation isn't a silent dead end.
  const denied = res.permission === "denied";
  const show = res.enabled && (!res.verified || denied);
  notifEls.onboard().style.display = show ? "block" : "none";

  // When the card is hidden, reset the sub-flow so it reopens clean (no stale
  // "Did you see it?" / help panel from a previous, abandoned attempt).
  if (!show) {
    notifEls.confirm().style.display = "none";
    notifEls.help().style.display = "none";
    notifEls.status().textContent = "";
  }

  // Tailor the lead text to the detectable cause.
  const lead = document.getElementById("notif-onboard-text");
  if (lead) {
    lead.textContent = denied
      ? "Chrome has notifications switched off for Mochi. Turn them on, then send a test."
      : "Let Mochi tap you on the shoulder when it needs you — instead of jumping in front of your work.";
  }
}

notifEls.sw().addEventListener("change", async (e) => {
  await chrome.runtime.sendMessage({ type: "popup_set_notif_enabled", enabled: e.target.checked });
  refreshNotif();
});

notifEls.test().addEventListener("click", async () => {
  notifEls.status().textContent = "";
  await chrome.runtime.sendMessage({ type: "popup_send_test_notification" });
  notifEls.confirm().style.display = "block";
  notifEls.help().style.display = "none";
});

document.getElementById("notif-yes-btn").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "popup_set_notif_verified", verified: true });
  notifEls.confirm().style.display = "none";
  notifEls.status().className = "status ok";
  notifEls.status().textContent = "🎉 You're all set!";
  setTimeout(refreshNotif, 1200);
});

document.getElementById("notif-no-btn").addEventListener("click", () => {
  notifEls.confirm().style.display = "none";
  notifEls.help().style.display = "block";
});

document.getElementById("notif-open-settings-btn").addEventListener("click", async () => {
  const r = await chrome.runtime.sendMessage({ type: "popup_open_os_notification_settings" });
  notifEls.status().className = r?.ok ? "status ok" : "status err";
  notifEls.status().textContent = r?.ok
    ? "Opened macOS settings — enable Google Chrome, then test again."
    : "Couldn't open settings automatically. Open System Settings → Notifications → Google Chrome.";
});

refreshNotif();
setInterval(refreshNotif, 2000);
