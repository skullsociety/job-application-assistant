"use strict";
const COMPANION_BASE = "http://127.0.0.1:8765";
const AUTO_CAPTURE_KEY = "careersGovAutoCapture";
const state = {job: null, tabId: null, tabUrl: null, dirty: false, savedId: null, refreshToken: 0};
const elements = {
  form: document.querySelector("#job-form"),
  connectionText: document.querySelector("#connection-text"),
  connectionDot: document.querySelector("#connection-dot"),
  autoCapture: document.querySelector("#auto-capture"),
  refresh: document.querySelector("#refresh-fields"),
  save: document.querySelector("#save-job"),
  status: document.querySelector("#capture-status"),
  summary: document.querySelector("#analysis-summary"),
  skills: document.querySelector("#skills"),
  resume: document.querySelector("#resume-link"),
  rematch: document.querySelector("#rematch"),
  dashboard: document.querySelector("#dashboard"),
  profile: document.querySelector("#profile"),
  openJobs: document.querySelector("#open-jobs"),
};
function setStatus(message, error = false) {
  elements.status.textContent = message;
  elements.status.className = error ? "status error" : "status";
}
async function request(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(COMPANION_BASE + path, {...options, cache: "no-store", signal: controller.signal});
    const result = await response.json();
    if (!response.ok || result.ok === false) throw new Error(result.error || "The local request failed.");
    return result;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("The companion timed out. Check the dashboard before retrying.");
    throw error;
  } finally { clearTimeout(timeout); }
}
async function activeTab() {
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  if (!tab?.id || !tab.url?.startsWith("https://jobs.careers.gov.sg/jobs/")) throw new Error("Open a Careers@Gov job page. Manual entry remains available.");
  return tab;
}
function populateForm(job, tab) {
  state.job = job; state.tabId = tab.id; state.tabUrl = tab.url; state.savedId = null;
  for (const input of elements.form.querySelectorAll("[name]")) input.value = job[input.name] || "";
  state.dirty = false;
}
async function refreshPreview(force = false) {
  if (state.dirty && !force) { setStatus("Unsaved edits kept. Use Refresh fields to switch listings."); return; }
  if (state.dirty && !window.confirm("Replace your unsaved field edits with the visible page?")) return;
  const token = ++state.refreshToken;
  try {
    const tab = await activeTab();
    let response;
    try { response = await chrome.tabs.sendMessage(tab.id, {type: "EXTRACT_JOB"}); }
    catch (_) {
      await chrome.scripting.executeScript({target: {tabId: tab.id}, files: ["capture-core.js", "content.js"]});
      response = await chrome.tabs.sendMessage(tab.id, {type: "EXTRACT_JOB"});
    }
    if (!response?.ok) throw new Error(response?.error || "The listing is not ready.");
    if (token !== state.refreshToken || state.dirty && !force) return;
    populateForm(response.job, tab);
    setStatus("Listing ready. Missing fields are left blank.");
    await pollAnalysis();
  } catch (error) { if (token === state.refreshToken) setStatus(error.message, true); }
}
function renderAnalysis(job) {
  elements.resume.hidden = true;
  elements.resume.removeAttribute("href");
  elements.skills.replaceChildren();
  elements.skills.hidden = !job;
  if (!job) { elements.summary.textContent = "Capture a job to view its resume match."; return; }
  state.savedId = job.id;
  const score = job.match_score == null ? job.recommendation === "analysis pending" ? "Analysis pending" : "Not scored" : job.match_score + "% match";
  elements.summary.textContent = "#" + job.id + " · " + score + " · " + (job.recommendation || "Review manually") + ". " + (job.match_reason || "");
  for (const [label, value] of [["Matching", job.matching_skills], ["Missing", job.missing_skills]]) {
    const line = document.createElement("p");
    line.textContent = label + ": " + (value || "None");
    elements.skills.appendChild(line);
  }
  if (job.tailored_resume_path) {
    elements.resume.href = COMPANION_BASE + "/tailored/" + encodeURIComponent(job.tailored_resume_path);
    elements.resume.hidden = false;
  }
}
let polling = false;
async function pollAnalysis() {
  if (polling) return;
  polling = true;
  try {
    const url = state.job?.url;
    const data = await request("/api/jobs");
    elements.connectionText.textContent = "Connected on this computer";
    elements.connectionDot.className = "dot online";
    if (url && url === state.job?.url) renderAnalysis(data.jobs.find(job => job.url === url) || null);
  } catch (_) {
    elements.connectionText.textContent = "Start the CareersGov companion";
    elements.connectionDot.className = "dot";
  } finally { polling = false; }
}
elements.form.addEventListener("input", () => { state.dirty = true; });
elements.form.addEventListener("submit", async event => {
  event.preventDefault();
  elements.save.disabled = true;
  setStatus("Saving locally…");
  try {
    const job = {...(state.job || {}), source: "careersgov", platform: "Careers@Gov"};
    for (const input of elements.form.querySelectorAll("[name]")) job[input.name] = input.value.trim();
    job.description = job.job_description;
    const result = await request("/api/jobs", {method: "POST", headers: {"Content-Type": "text/plain;charset=UTF-8"}, body: JSON.stringify(job)});
    state.job = result.job; state.dirty = false;
    renderAnalysis(result.job);
    setStatus("Captured job #" + result.job.id + ". Analysis is updating.");
  } catch (error) { setStatus(error.message, true); }
  finally { elements.save.disabled = false; }
});
elements.refresh.addEventListener("click", () => refreshPreview(true));
elements.autoCapture.addEventListener("change", () => chrome.storage.local.set({[AUTO_CAPTURE_KEY]: elements.autoCapture.checked}));
elements.rematch.addEventListener("click", async () => {
  elements.rematch.disabled = true;
  try {
    await request("/api/jobs/rematch", {method: "POST", headers: {"Content-Type": "text/plain"}, body: "{}"});
    setStatus("Matching all saved jobs again.");
  } catch (error) { setStatus(error.message, true); }
  finally { elements.rematch.disabled = false; }
});
elements.dashboard.addEventListener("click", async () => {
  const tabs = await chrome.tabs.query({url: "http://127.0.0.1:8767/*"});
  if (tabs[0]?.id) await chrome.tabs.update(tabs[0].id, {active: true});
  else await chrome.tabs.create({url: "http://127.0.0.1:8767/"});
});
elements.profile.addEventListener("click", () => chrome.runtime.sendMessage({ type: "OPEN_SF_PROFILE" }));
elements.openJobs.addEventListener("click", () => chrome.tabs.create({url: "https://jobs.careers.gov.sg/"}));
chrome.tabs.onActivated.addListener(() => refreshPreview());
chrome.tabs.onUpdated.addListener((id, info) => { if (id === state.tabId && (info.status === "complete" || info.url)) refreshPreview(); });
chrome.storage.local.get(AUTO_CAPTURE_KEY).then(data => { elements.autoCapture.checked = data[AUTO_CAPTURE_KEY] !== false; });
chrome.storage.onChanged.addListener((changes, area) => { if (area === "local" && changes[AUTO_CAPTURE_KEY]) elements.autoCapture.checked = changes[AUTO_CAPTURE_KEY].newValue !== false; });
refreshPreview();
pollAnalysis();
setInterval(pollAnalysis, 2500);
