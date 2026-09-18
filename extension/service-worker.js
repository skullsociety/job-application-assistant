"use strict";
importScripts(
  "native-lifecycle.js",
  "successfactors-worker.js",
  "sites/linkedin/worker.js",
  "sites/jobstreet/worker.js",
  "sites/careersgov/worker.js",
);

async function openDashboard() {
  return globalThis.JobStreetSite.openDashboard();
}

function siteFor(url) {
  if (globalThis.LinkedInSite.matches(url)) return globalThis.LinkedInSite;
  if (globalThis.JobStreetSite.matches(url)) return globalThis.JobStreetSite;
  if (globalThis.CareersGovSite.matches(url)) return globalThis.CareersGovSite;
  return null;
}

async function captureCurrentJob(tab) {
  const site = siteFor(tab?.url);
  if (!site) throw new Error("Open a LinkedIn, JobStreet, or Careers@Gov job listing first.");
  return site.captureCurrentJob(tab);
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({openPanelOnActionClick: true}).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "OPEN_UNIFIED_DASHBOARD") return false;
  openDashboard().then(() => sendResponse({ok: true})).catch(error => sendResponse({ok: false, error: error.message}));
  return true;
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  try {
    if (command === "capture-current-job") await captureCurrentJob(tab);
    if (command === "open-local-dashboard") await openDashboard();
  } catch (error) {
    const site = siteFor(tab?.url);
    if (site?.showStatus) await site.showStatus(tab?.id, error.message, "error");
    await chrome.action.setBadgeBackgroundColor({color: "#B32F43", tabId: tab?.id}).catch(() => {});
    await chrome.action.setBadgeText({text: "ERR", tabId: tab?.id}).catch(() => {});
  }
});

globalThis.UnifiedJobAssistant = {siteFor, captureCurrentJob, openDashboard};
