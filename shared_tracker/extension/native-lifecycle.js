"use strict";
// A persistent native connection is a lease on the shared local assistants.
// Closing the last browser window releases it even if Chrome background mode is on.
(() => {
  const HOST = "com.job_application_assistant.launcher";
  let port = null;
  let pending = null;
  let resolvePending;
  let rejectPending;
  let responseTimer;
  let retryTimer;
  let wanted = false;
  function settle(error, result) {
    clearTimeout(responseTimer);
    if (error) rejectPending?.(error); else resolvePending?.(result);
    pending = null; resolvePending = rejectPending = null;
  }
  async function hasWindows() {
    return (await chrome.windows.getAll({windowTypes: ["normal", "popup"]})).length > 0;
  }
  async function start() {
    wanted = await hasWindows();
    if (!wanted) return {ok: false, error: "Open a Chrome window first."};
    if (pending) return pending;
    pending = new Promise((resolve, reject) => { resolvePending = resolve; rejectPending = reject; });
    const result = pending;
    responseTimer = setTimeout(() => settle(new Error("The shared helper did not become ready. Check local-data/logs.")), 90000);
    if (!port) {
      try {
        port = chrome.runtime.connectNative(HOST);
        port.onMessage.addListener(message => {
          if (!message.ok) settle(new Error(message.error || "The shared helper could not start."));
          else settle(null, message);
        });
        port.onDisconnect.addListener(() => {
          const message = chrome.runtime.lastError?.message;
          port = null;
          settle(new Error(message || "The shared helper disconnected."));
          clearTimeout(retryTimer);
          if (wanted) retryTimer = setTimeout(() => start().catch(() => {}), 10000);
        });
      } catch (error) { settle(error); return result; }
    }
    try { port.postMessage({action: "start"}); } catch (error) { settle(error); }
    return result;
  }
  async function syncWindows() {
    wanted = await hasWindows();
    if (wanted) { start().catch(() => {}); return; }
    clearTimeout(retryTimer);
    if (port) { const old = port; port = null; old.disconnect(); }
    settle(new Error("Chrome windows are closed."));
  }
  globalThis.JobAssistantLifecycle = {start};
  chrome.runtime.onStartup.addListener(() => syncWindows().catch(() => {}));
  chrome.runtime.onInstalled.addListener(() => syncWindows().catch(() => {}));
  chrome.windows.onCreated.addListener(() => syncWindows().catch(() => {}));
  chrome.windows.onRemoved.addListener(() => syncWindows().catch(() => {}));
  syncWindows().catch(() => {});
})();
