importScripts("native-lifecycle.js");
importScripts("successfactors-worker.js");

const COMPANION_BASE = "http://127.0.0.1:8765";
const CAPTURE_COMMAND = "capture-current-job";
const DASHBOARD_COMMAND = "open-local-dashboard";
const JOB_BATCH_KEY = "careersGovOpenedJobBatch";

async function saveJob(job) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(`${COMPANION_BASE}/api/jobs`, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify(job),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    return {
      ok: response.ok && body.ok,
      body,
      error: body.error || (response.ok ? "The companion returned an invalid response." : `Save failed (${response.status}).`),
    };
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Capture timed out. Check the dashboard—the job may still have been saved.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function settleStatus(statusPromise) {
  await Promise.race([
    statusPromise,
    new Promise((resolve) => setTimeout(resolve, 800)),
  ]).catch(() => {});
}

async function withTimeout(promise, milliseconds, message) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function sendToJobTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (_error) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["capture-core.js", "content.js"] });
    return chrome.tabs.sendMessage(tabId, message);
  }
}

async function showCaptureStatus(tabId, message, kind) {
  try {
    await sendToJobTab(tabId, { type: "SHOW_CAPTURE_STATUS", message, kind });
  } catch (_error) {
    // The action badge still provides feedback if the page cannot show a toast.
  }
}

function showCaptureBadge(text, color) {
  chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
  chrome.action.setBadgeText({ text }).catch(() => {});
  setTimeout(() => chrome.action.setBadgeText({ text: "" }).catch(() => {}), 3500);
}

async function captureCurrentJob(commandTab) {
  let tab = commandTab;
  try {
    if (!tab?.id) {
      [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    }
    if (!tab?.id || !tab.url?.startsWith("https://jobs.careers.gov.sg/")) {
      throw new Error("Open a Careers@Gov job page before pressing Ctrl+Q.");
    }

    showCaptureBadge("...", "#8B2858");
    await settleStatus(showCaptureStatus(tab.id, "Capturing this job…", "pending"));
    const extraction = await withTimeout(
      sendToJobTab(tab.id, { type: "EXTRACT_JOB" }),
      6000,
      "The page took too long to read. Refresh it and try Ctrl+Q again.",
    );
    if (!extraction?.ok) {
      throw new Error(extraction?.error || "The job could not be extracted.");
    }

    const saved = await saveJob(extraction.job);
    if (!saved.ok) {
      throw new Error(saved.error || "The local companion could not save this job.");
    }
    const message = `Captured job #${saved.body.job.id}. Analysis is updating.`;
    await settleStatus(showCaptureStatus(tab.id, message, "success"));
    showCaptureBadge("OK", "#227B52");
  } catch (error) {
    if (tab?.id) await settleStatus(showCaptureStatus(tab.id, error.message, "error"));
    showCaptureBadge("ERR", "#B32F43");
  }
}

async function openLocalDashboard() {
  const dashboardUrl = "http://127.0.0.1:8767/";
  const existing = await chrome.tabs.query({ url: "http://127.0.0.1:8767/*" });
  const tab = existing.find((candidate) => candidate.url === dashboardUrl) || existing[0];
  if (tab?.id) {
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url: dashboardUrl });
}

async function existingBatch() {
  const stored = await chrome.storage.session.get(JOB_BATCH_KEY);
  const batch = stored[JOB_BATCH_KEY];
  if (!batch?.tabs?.length) return null;
  const openTabs = [];
  for (const item of batch.tabs) {
    try {
      const tab = await chrome.tabs.get(item.id);
      openTabs.push({ id: tab.id, url: tab.url || item.url });
    } catch (_error) {
      // Tabs closed manually are removed from the active batch.
    }
  }
  if (!openTabs.length) {
    await chrome.storage.session.remove(JOB_BATCH_KEY);
    return null;
  }
  return { ...batch, tabs: openTabs };
}

async function openPageJobLinks(urls, sourceTabId) {
  const activeBatch = await existingBatch();
  if (activeBatch) {
    throw new Error(`There are still ${activeBatch.tabs.length} queued job tabs. Press Ctrl+] to finish them first.`);
  }
  const uniqueUrls = [...new Set((urls || []).filter((url) => url.startsWith("https://jobs.careers.gov.sg/jobs/")))];
  if (!uniqueUrls.length) throw new Error("No Careers@Gov job links were found on this page.");
  const opened = [];
  for (const url of uniqueUrls) {
    const tab = await chrome.tabs.create({ url, active: false });
    opened.push({ id: tab.id, url });
  }
  await chrome.storage.session.set({
    [JOB_BATCH_KEY]: {
      sourceTabId,
      createdAt: new Date().toISOString(),
      tabs: opened,
    },
  });
  return { ok: true, opened: opened.length };
}

async function waitForTabReady(tabId, timeoutMs = 20000) {
  const current = await chrome.tabs.get(tabId);
  if (current.status === "complete") return current;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("The job tab did not finish loading.")), timeoutMs);
    const onUpdated = (changedId, changeInfo, tab) => {
      if (changedId === tabId && changeInfo.status === "complete") finish(null, tab);
    };
    const onRemoved = (removedId) => {
      if (removedId === tabId) finish(new Error("The job tab was closed before capture."));
    };
    function finish(error, tab) {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      if (error) reject(error);
      else resolve(tab);
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
}

async function captureOpenedJobTabs() {
  const batch = await existingBatch();
  if (!batch) throw new Error("No queued job tabs were found. Press Ctrl+[ on a results page first.");
  const total = batch.tabs.length;
  let captured = 0;
  const failed = [];
  showCaptureBadge("...", "#8B2858");
  for (let index = 0; index < batch.tabs.length; index += 1) {
    const item = batch.tabs[index];
    await settleStatus(showCaptureStatus(batch.sourceTabId, `Capturing ${index + 1} of ${total}…`, "pending"));
    try {
      const tab = await waitForTabReady(item.id);
      if (!tab.url?.startsWith("https://jobs.careers.gov.sg/jobs/") || tab.url.includes("/api/v1/auth/error")) {
        throw new Error("The tab did not load a valid job listing.");
      }
      const extraction = await withTimeout(
        sendToJobTab(item.id, { type: "EXTRACT_JOB" }),
        7000,
        "The job page took too long to read.",
      );
      if (!extraction?.ok) throw new Error(extraction?.error || "The job could not be extracted.");
      const saved = await saveJob(extraction.job);
      if (!saved.ok) throw new Error(saved.error || "The local companion could not save this job.");
      captured += 1;
      await chrome.tabs.remove(item.id);
    } catch (error) {
      failed.push({ ...item, error: error.message });
    }
  }
  if (failed.length) {
    await chrome.storage.session.set({ [JOB_BATCH_KEY]: { ...batch, tabs: failed } });
  } else {
    await chrome.storage.session.remove(JOB_BATCH_KEY);
  }
  const summary = failed.length
    ? `Captured ${captured} of ${total}. ${failed.length} failed tab${failed.length === 1 ? " was" : "s were"} left open for review.`
    : `Captured ${captured} job${captured === 1 ? "" : "s"} and closed all processed tabs.`;
  await settleStatus(showCaptureStatus(batch.sourceTabId, summary, failed.length ? "error" : "success"));
  showCaptureBadge(failed.length ? "ERR" : "OK", failed.length ? "#B32F43" : "#227B52");
  return { ok: true, captured, failed: failed.length, total, summary };
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "AUTO_CAPTURE_CAREERSGOV_JOB") {
    (async () => {
      const settings = await chrome.storage.local.get("careersGovAutoCapture");
      if (settings.careersGovAutoCapture === false) throw new Error("Automatic capture is off.");
      if (!_sender.tab?.url?.startsWith("https://jobs.careers.gov.sg/jobs/")) throw new Error("Capture requires a Careers@Gov job page.");
      const sourceUrl = new URL(_sender.tab.url);
      sourceUrl.search = ""; sourceUrl.hash = "";
      if (sourceUrl.href.replace(/\/$/, "") !== message.job?.url) throw new Error("The captured page changed.");
      return saveJob(message.job);
    })().then(sendResponse).catch(error => sendResponse({ok: false, error: error.message}));
    return true;
  }
  if (message?.type === "COMPANION_HEALTH") {
    fetch(`${COMPANION_BASE}/api/health`, { cache: "no-store" })
      .then(async (response) => ({ ok: response.ok, body: await response.json() }))
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "SAVE_JOB") {
    saveJob(message.job)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "OPEN_PAGE_JOB_LINKS") {
    openPageJobLinks(message.urls, _sender.tab?.id)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "CAPTURE_OPENED_JOB_TABS") {
    captureOpenedJobTabs()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === CAPTURE_COMMAND) captureCurrentJob(tab);
  if (command === DASHBOARD_COMMAND) openLocalDashboard();
});
