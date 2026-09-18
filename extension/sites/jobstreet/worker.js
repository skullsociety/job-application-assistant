"use strict";
(() => {

const COMPANION_BASE = "http://127.0.0.1:8767";
const NATIVE_HOST_NAME = "com.job_application_assistant.launcher";
const AUTO_CAPTURE_KEY = "jobstreetAutoCapture";
let nativeStartPromise = null;

async function rawRequest(path, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${COMPANION_BASE}${path}`, { cache: "no-store", ...options, signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.ok) throw new Error(body.error || `Local companion request failed (${response.status}).`);
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

function isConnectionError(error) {
  return error?.name === "AbortError" || error instanceof TypeError;
}

function requestNativeStart() {
  return globalThis.JobAssistantLifecycle.start();
}

async function ensureCompanionRunning() {
  try {
    await rawRequest("/api/health", {}, 700);
    return;
  } catch (error) {
    if (!isConnectionError(error)) throw error;
  }
  if (!nativeStartPromise) nativeStartPromise = requestNativeStart().finally(() => { nativeStartPromise = null; });
  await nativeStartPromise;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rawRequest("/api/health", {}, 700);
      return;
    } catch (error) {
      if (!isConnectionError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error("Chrome launched the local helper, but the companion did not become ready.");
}

async function request(path, options = {}) {
  try {
    return await rawRequest(path, options);
  } catch (error) {
    if (!isConnectionError(error)) throw error;
  }
  await ensureCompanionRunning();
  return rawRequest(path, options);
}

function isJobStreetHostname(hostname) {
  const normalized = String(hostname || "").toLowerCase().replace(/\.$/, "");
  return /^(?:[a-z0-9-]+\.)*jobstreet\.com(?:\.[a-z]{2})?$/.test(normalized);
}

function isJobStreetJob(value) {
  try {
    const url = new URL(value || "");
    const pathJob = /^\/job\/\d+\/?$/i.test(url.pathname);
    const queryJob = /^\d+$/.test(url.searchParams.get("jobId") || "");
    return url.protocol === "https:" && isJobStreetHostname(url.hostname) && (pathJob || queryJob);
  } catch (_error) {
    return false;
  }
}

async function captureSettings() {
  const data = await chrome.storage.local.get(AUTO_CAPTURE_KEY);
  if (data[AUTO_CAPTURE_KEY] === undefined) {
    await chrome.storage.local.set({ [AUTO_CAPTURE_KEY]: true });
    return { autoCapture: true };
  }
  return { autoCapture: data[AUTO_CAPTURE_KEY] !== false };
}

async function broadcastSettings() {
  const settings = await captureSettings();
  const tabs = await chrome.tabs.query({
    url: [
      "https://jobstreet.com/*",
      "https://*.jobstreet.com/*",
      "https://jobstreet.com.sg/*",
      "https://*.jobstreet.com.sg/*",
    ],
  });
  await Promise.all(tabs.filter((tab) => tab.id).map((tab) => chrome.tabs.sendMessage(tab.id, {
    type: "JOBSTREET_SETTINGS_UPDATED",
    autoCapture: settings.autoCapture,
  }).catch(() => {})));
}

async function showStatus(tabId, message, kind = "pending") {
  if (!tabId) return;
  try {
    await chrome.tabs.sendMessage(tabId, { type: "SHOW_JOBSTREET_STATUS", message, kind });
  } catch (_error) {
    // The side panel still reports the error when a page no longer has the content script.
  }
}

function saveJob(job) {
  return request("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(job || {}),
  });
}

async function captureCurrentJob(tab) {
  if (!tab?.id || !isJobStreetJob(tab.url)) throw new Error("Open a fully loaded JobStreet job-detail page first.");
  let extraction;
  try {
    extraction = await chrome.tabs.sendMessage(tab.id, { type: "EXTRACT_JOBSTREET_JOB" });
  } catch (_error) {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["sites/jobstreet/content.js"] });
    extraction = await chrome.tabs.sendMessage(tab.id, { type: "EXTRACT_JOBSTREET_JOB" });
  }
  if (!extraction?.ok) throw new Error(extraction?.error || "The visible JobStreet job could not be extracted.");
  await showStatus(tab.id, "Saving the visible JobStreet job locally…");
  const saved = await saveJob(extraction.job);
  await showStatus(tab.id, `Captured job #${saved.job.id}. Resume analysis is running.`, "success");
  await chrome.action.setBadgeText({ text: "OK", tabId: tab.id });
  await chrome.action.setBadgeBackgroundColor({ color: "#087a55", tabId: tab.id });
  return saved;
}

async function openDashboard() {
  await request("/api/health");
  const target = "http://127.0.0.1:8767/";
  const existing = await chrome.tabs.query({ url: "http://127.0.0.1:8767/*" });
  if (existing[0]?.id) {
    await chrome.tabs.update(existing[0].id, { active: true });
    await chrome.windows.update(existing[0].windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url: target });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  captureSettings().then(ensureCompanionRunning).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => captureSettings().then(ensureCompanionRunning).catch(() => {}));

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "AUTO_CAPTURE_JOBSTREET_JOB") {
    captureCurrentJob(sender.tab)
      .then((saved) => sendResponse({ ok: true, saved }))
      .catch(async (error) => {
        await showStatus(sender.tab?.id, error.message, "error");
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }
  if (message?.type === "SAVE_JOBSTREET_JOB") {
    saveJob(message.job).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "GET_JOBSTREET_SETTINGS") {
    captureSettings().then((settings) => sendResponse({ ok: true, ...settings }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "SAVE_JOBSTREET_SETTINGS") {
    chrome.storage.local.set({ [AUTO_CAPTURE_KEY]: message.autoCapture !== false })
      .then(broadcastSettings)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "GET_JOBSTREET_JOB") {
    request(`/api/jobs/${message.jobId}`).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "JOBSTREET_COMPANION_HEALTH") {
    request("/api/health").then((body) => sendResponse({ ok: true, body })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "REMATCH_JOBSTREET_JOBS") {
    request("/api/jobs/rematch", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
      .then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "GENERATE_JOBSTREET_COVER_LETTER") {
    request(`/api/jobs/${message.jobId}/cover-letter`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
      .then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "OPEN_JOBSTREET_DASHBOARD") {
    openDashboard().then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  return false;
});

globalThis.JobStreetSite = { captureCurrentJob, openDashboard, showStatus, matches: (url) => isJobStreetJob(url) };
})();
