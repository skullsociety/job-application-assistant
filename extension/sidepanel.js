"use strict";
const frame = document.querySelector("#site-panel");
const home = document.querySelector("#home");
const siteLabel = document.querySelector("#current-site");
const homeMessage = document.querySelector("#home-message");
const status = document.querySelector("#status");
let currentSite = "";

function classify(urlValue) {
  try {
    const url = new URL(urlValue || "");
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (host === "linkedin.com" || host.endsWith(".linkedin.com")) return {key: "linkedin", label: "LinkedIn", panel: "sites/linkedin/sidepanel.html"};
    if (/^(?:[a-z0-9-]+\.)*jobstreet\.com(?:\.[a-z]{2})?$/.test(host)) return {key: "jobstreet", label: "JobStreet", panel: "sites/jobstreet/sidepanel.html"};
    if (host === "jobs.careers.gov.sg") return {key: "careersgov", label: "Careers@Gov", panel: "sites/careersgov/sidepanel.html"};
    if (host.endsWith(".myworkdayjobs.com")) return {key: "application", label: "Workday application"};
    if (/(^|\.)(successfactors\.(?:com|eu)|sapsf\.(?:com|eu|cn)|hr\.cloud\.sap|jobs\.hr\.cloud\.sap\.com)$/.test(host)) return {key: "application", label: "SuccessFactors application"};
  } catch (_error) {}
  return {key: "other", label: "Unsupported page"};
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({active: true, lastFocusedWindow: true});
  return tab;
}

async function render() {
  const tab = await activeTab();
  const site = classify(tab?.url);
  siteLabel.textContent = site.label;
  if (site.panel) {
    home.hidden = true;
    frame.hidden = false;
    if (currentSite !== site.key) frame.src = site.panel;
  } else {
    frame.hidden = true;
    home.hidden = false;
    if (site.key === "application") {
      homeMessage.textContent = `${site.label} detected. Safe autofill is active; review every value before continuing.`;
    } else {
      homeMessage.textContent = "Open LinkedIn, JobStreet, Careers@Gov, Workday, or SuccessFactors.";
    }
  }
  currentSite = site.key;
}

document.querySelector("#dashboard").addEventListener("click", async () => {
  const response = await chrome.runtime.sendMessage({type: "OPEN_UNIFIED_DASHBOARD"});
  status.textContent = response?.ok ? "Dashboard opened." : response?.error || "The dashboard could not be opened.";
});
document.querySelector("#profile").addEventListener("click", () => chrome.runtime.sendMessage({type: "OPEN_SF_PROFILE"}));
chrome.tabs.onActivated.addListener(render);
chrome.tabs.onUpdated.addListener((_tabId, change) => { if (change.url || change.status === "complete") render(); });
render();

globalThis.UnifiedSidePanel = {classify};
