"use strict";

const state = { preview: null, saved: null, timer: 0 };
const elements = {
  connectionDot: document.querySelector("#connection-dot"),
  connectionText: document.querySelector("#connection-text"),
  databaseText: document.querySelector("#database-text"),
  form: document.querySelector("#job-form"),
  title: document.querySelector("#job-title"),
  company: document.querySelector("#job-company"),
  url: document.querySelector("#job-url"),
  location: document.querySelector("#job-location"),
  salary: document.querySelector("#job-salary"),
  workplace: document.querySelector("#job-workplace"),
  employment: document.querySelector("#job-employment"),
  posted: document.querySelector("#job-posted"),
  description: document.querySelector("#job-description"),
  auto: document.querySelector("#auto-capture"),
  refresh: document.querySelector("#refresh-fields"),
  save: document.querySelector("#save-job"),
  status: document.querySelector("#capture-status"),
  rematch: document.querySelector("#rematch"),
  analysis: document.querySelector("#analysis-summary"),
  skills: document.querySelector("#skills"),
  resume: document.querySelector("#resume-link"),
  letter: document.querySelector("#letter"),
  letterOutput: document.querySelector("#letter-output"),
  relatedSummary: document.querySelector("#related-summary"),
  relatedJobs: document.querySelector("#related-jobs"),
  dashboard: document.querySelector("#dashboard"),
  actionStatus: document.querySelector("#action-status"),
};

function setStatus(message, kind = "") {
  elements.status.textContent = message;
  elements.status.className = `status ${kind}`;
}

function setActionStatus(message, kind = "") {
  elements.actionStatus.textContent = message;
  elements.actionStatus.className = `status ${kind}`;
}

function message(type, values = {}) {
  return chrome.runtime.sendMessage({ type, ...values });
}

function isJobStreetJob(tab) {
  try {
    const url = new URL(tab?.url || "");
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    const pathJob = /^\/job\/\d+\/?$/i.test(url.pathname);
    const queryJob = /^\d+$/.test(url.searchParams.get("jobId") || "");
    return url.protocol === "https:"
      && /^(?:[a-z0-9-]+\.)*jobstreet\.com(?:\.[a-z]{2})?$/.test(hostname)
      && (pathJob || queryJob);
  } catch (_error) {
    return false;
  }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

async function sendToActive(messageValue) {
  const tab = await activeTab();
  if (!tab?.id || !isJobStreetJob(tab)) throw new Error("Open a JobStreet job-detail page in the active tab.");
  try {
    return await chrome.tabs.sendMessage(tab.id, messageValue);
  } catch (_error) {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    return chrome.tabs.sendMessage(tab.id, messageValue);
  }
}

function populateForm(job) {
  state.preview = job;
  const fields = {
    title: job.title,
    company: job.company,
    url: job.url,
    location: job.location,
    salary: job.salary,
    workplace: job.workplace_type,
    employment: job.employment_type,
    posted: job.posting_date,
    description: job.job_description,
  };
  for (const [name, value] of Object.entries(fields)) elements[name].value = value || "";
}

async function extractPreview() {
  const response = await sendToActive({ type: "EXTRACT_JOBSTREET_JOB" });
  if (!response?.ok) throw new Error(response?.error || "The visible JobStreet job could not be read.");
  populateForm(response.job);
  setStatus("Fields captured from the current visible JobStreet listing. Review or edit them before saving.");
  return response.job;
}

function payloadFromForm() {
  return {
    title: elements.title.value,
    company: elements.company.value,
    url: elements.url.value,
    location: elements.location.value,
    salary: elements.salary.value,
    workplace_type: elements.workplace.value,
    employment_type: elements.employment.value,
    posting_date: elements.posted.value,
    job_description: elements.description.value,
  };
}

function renderRelated(relatedJobs = []) {
  elements.relatedJobs.textContent = "";
  elements.relatedJobs.hidden = relatedJobs.length === 0;
  if (!relatedJobs.length) {
    elements.relatedSummary.textContent = "No matching LinkedIn record was found for this company and role.";
    return;
  }
  elements.relatedSummary.textContent = `${relatedJobs.length} possible LinkedIn match${relatedJobs.length === 1 ? "" : "es"} found in the shared database.`;
  for (const job of relatedJobs) {
    const link = document.createElement("a");
    link.className = "related-job";
    link.href = job.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    const heading = document.createElement("strong");
    heading.textContent = `${job.title} - ${job.company}`;
    const detail = document.createElement("small");
    detail.textContent = `${job.platform || "LinkedIn"} | ${job.match_score == null ? "not matched yet" : `${job.match_score}% resume match`} | ${job.status}`;
    link.append(heading, detail);
    elements.relatedJobs.appendChild(link);
  }
}

function renderAnalysis(job) {
  state.saved = job;
  const pending = job.match_score === null || job.match_score === undefined;
  elements.analysis.textContent = pending
    ? "Analysis pending. The companion is reading your newest local resume."
    : `${job.match_score}% match | ${job.recommendation || "review manually"}. ${job.match_reason || ""}`;
  elements.skills.hidden = pending;
  elements.skills.textContent = "";
  if (!pending) {
    for (const [label, value] of [["Matching", job.matching_skills], ["Missing", job.missing_skills]]) {
      const tag = document.createElement("span");
      tag.textContent = `${label}: ${value || "None"}`;
      elements.skills.appendChild(tag);
    }
  }
  elements.resume.hidden = !job.tailored_resume_url;
  if (job.tailored_resume_url) elements.resume.href = `http://127.0.0.1:8767${job.tailored_resume_url}`;
  elements.letter.disabled = pending;
}

async function loadJob(id) {
  const response = await message("GET_JOBSTREET_JOB", { jobId: id });
  if (!response?.ok) throw new Error(response?.error || "The saved job could not be read.");
  renderAnalysis(response.job);
  renderRelated(response.related_jobs || []);
  return response.job;
}

function pollAnalysis() {
  clearTimeout(state.timer);
  if (!state.saved?.id || state.saved.match_score !== null && state.saved.match_score !== undefined) return;
  state.timer = setTimeout(async () => {
    try {
      const job = await loadJob(state.saved.id);
      if (job.match_score === null || job.match_score === undefined) pollAnalysis();
    } catch (_error) {
      pollAnalysis();
    }
  }, 1600);
}

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  elements.save.disabled = true;
  setStatus("Saving this job to the unified local database...");
  try {
    const response = await message("SAVE_JOBSTREET_JOB", { job: payloadFromForm() });
    if (!response?.ok) throw new Error(response?.error || "The local companion could not save this job.");
    renderAnalysis(response.job);
    renderRelated(response.related_jobs || []);
    setStatus(`Saved job #${response.job.id}. Resume analysis is running.`);
    pollAnalysis();
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    elements.save.disabled = false;
  }
});

elements.refresh.addEventListener("click", async () => {
  elements.refresh.disabled = true;
  setStatus("Reading the current visible JobStreet listing…");
  try {
    await extractPreview();
  } catch (error) {
    setStatus(`${error.message} You can still enter the fields manually.`, "error");
  } finally {
    elements.refresh.disabled = false;
  }
});

elements.auto.addEventListener("change", async () => {
  const response = await message("SAVE_JOBSTREET_SETTINGS", { autoCapture: elements.auto.checked });
  setStatus(
    response?.ok
      ? elements.auto.checked
        ? "Automatic capture is on for fully loaded JobStreet job pages."
        : "Automatic capture is off; use Refresh fields or Save and match manually."
      : response?.error || "The automatic-capture setting could not be saved.",
    response?.ok ? "" : "error",
  );
});

elements.rematch.addEventListener("click", async () => {
  const response = await message("REMATCH_JOBSTREET_JOBS");
  setStatus(response?.ok ? `Queued ${response.queued} saved job(s) for matching.` : response?.error || "Matching could not be queued.", response?.ok ? "" : "error");
  if (response?.ok && state.saved) {
    renderAnalysis({ ...state.saved, match_score: null });
    pollAnalysis();
  }
});

elements.letter.addEventListener("click", async () => {
  try {
    const response = await message("GENERATE_JOBSTREET_COVER_LETTER", { jobId: state.saved.id });
    if (!response?.ok) throw new Error(response?.error || "Could not create a draft.");
    elements.letterOutput.textContent = response.cover_letter;
    elements.letterOutput.hidden = false;
  } catch (error) {
    setStatus(error.message, "error");
  }
});

elements.dashboard.addEventListener("click", async () => {
  const response = await message("OPEN_JOBSTREET_DASHBOARD");
  setActionStatus(response?.ok ? "Unified dashboard opened." : response?.error || "The dashboard could not be opened.", response?.ok ? "" : "error");
});

(async () => {
  const settings = await message("GET_JOBSTREET_SETTINGS");
  if (settings?.ok) elements.auto.checked = settings.autoCapture !== false;
  const response = await message("JOBSTREET_COMPANION_HEALTH");
  const online = Boolean(response?.ok);
  elements.connectionDot.className = `dot ${online ? "online" : ""}`;
  elements.connectionText.textContent = online ? "Connected on this computer" : "Automatic companion startup needs attention";
  if (response?.body?.database_path) {
    elements.databaseText.textContent = response.body.shared_with_linkedin
      ? `Shared LinkedIn tracker: ${response.body.database_path}`
      : `Local JobStreet tracker: ${response.body.database_path}`;
  }
  if (!online) {
    setStatus(response?.error || "Run the setup and Chrome integration commands, then reopen this panel.", "error");
    return;
  }
  try {
    await extractPreview();
  } catch (error) {
    setStatus(`${error.message} You can still enter a listing manually.`, "error");
  }
})();
