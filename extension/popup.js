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
  sw:       () => document.getElementById("notif-switch"),
  test:     () => document.getElementById("notif-test-btn"),
  confirm:  () => document.getElementById("notif-confirm"),
  help:     () => document.getElementById("notif-help"),
  status:   () => document.getElementById("notif-status"),
  permWarn: () => document.getElementById("notif-perm-warn"),
};

async function refreshNotif() {
  let res;
  try { res = await chrome.runtime.sendMessage({ type: "popup_notif_status" }); } catch { return; }
  if (!res) return;
  const sw = notifEls.sw();
  if (sw && document.activeElement !== sw) sw.checked = !!res.enabled;
  // Surface a warning if Chrome itself is blocking notifications ("denied" is
  // the browser-level setting, distinct from the macOS toggle).
  notifEls.permWarn().style.display = (res.permission === "denied") ? "block" : "none";
}

notifEls.sw().addEventListener("change", async (e) => {
  await chrome.runtime.sendMessage({ type: "popup_set_notif_enabled", enabled: e.target.checked });
  refreshNotif();
});

// Always-available manual test. Fires a real toast regardless of the on/off
// toggle, then asks the user to confirm they saw it.
notifEls.test().addEventListener("click", async () => {
  notifEls.status().className = "status";
  notifEls.status().textContent = "Sent — look at the top-right corner of your screen.";
  notifEls.help().style.display = "none";
  const r = await chrome.runtime.sendMessage({ type: "popup_send_test_notification" });
  if (r && r.ok === false) {
    notifEls.status().className = "status err";
    notifEls.status().textContent = "Couldn't send a notification — check the service-worker console.";
    return;
  }
  notifEls.confirm().style.display = "block";
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

// ---------- Comment mode ----------
const cmBtn = document.getElementById("comment-toggle-btn");
const cmStatus = document.getElementById("comment-status");

async function refreshComment() {
  let res;
  try { res = await chrome.runtime.sendMessage({ type: "popup_comment_status" }); } catch { return; }
  if (!res) return;
  if (res.active) {
    cmBtn.textContent = "■ Stop commenting";
    cmBtn.classList.remove("primary");
    cmStatus.className = "status ok";
    cmStatus.textContent = `${res.count} comment${res.count === 1 ? "" : "s"} · open the bubble on the page`;
  } else {
    cmBtn.textContent = "💬 Start commenting";
    cmBtn.classList.add("primary");
    cmStatus.textContent = res.count ? `${res.count} saved comment${res.count === 1 ? "" : "s"} (resume on a page)` : "";
  }
}

cmBtn.addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: "popup_comment_status" });
  if (res && res.active) {
    await chrome.runtime.sendMessage({ type: "popup_stop_comment_session" });
    cmStatus.className = "status";
    cmStatus.textContent = "Stopped.";
  } else {
    const r = await chrome.runtime.sendMessage({ type: "popup_start_comment_session" });
    if (r && r.ok) {
      cmStatus.className = "status ok";
      cmStatus.textContent = "Started — look for the 💬 bubble at the bottom-right of the page.";
      setTimeout(() => window.close(), 700);
    } else {
      cmStatus.className = "status err";
      cmStatus.textContent = (r && r.error) || "Couldn't start on this page.";
    }
  }
  refreshComment();
});

refreshComment();
setInterval(refreshComment, 2000);
