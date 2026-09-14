"use strict";
let displayedRevision = document.querySelector('meta[name="jobs-revision"]').content;
const sortPreferenceKey = "unified-dashboard-sort-v1";
const tableBody = document.querySelector("tbody");
const sortButtons = [...document.querySelectorAll(".sort-button")];
const dashboardStatus = document.querySelector("#dashboard-status");
const dirtyRows = new Set();
const followUpSaveTimers = new Map();
let saving = false, refreshing = false, deferredRows = false, activeSort = null;

document.addEventListener("input", event => {
  if (event.target.matches(".tracking-notes, .tracking-status")) dirtyRows.add(event.target.dataset.id);
  if (event.target.matches(".follow-up-date")) queueFollowUpDate(event.target);
});
async function request(path, options = {}) {
  const response = await fetch(path, {cache: "no-store", ...options});
  const payload = await response.json();
  if (!response.ok || !payload.ok) throw new Error(payload.error || "The request did not finish.");
  return payload;
}
async function updateJob(id, payload, control, {disableControl = true, refresh = true} = {}) {
  saving = true;
  if (disableControl) control.disabled = true;
  try {
    const result = await request("/api/jobs/" + id + "/tracking", {
      method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(payload),
    });
    if ("notes" in payload) dirtyRows.delete(id);
    if ("follow_up_date" in payload) control.dataset.savedValue = payload.follow_up_date;
    dashboardStatus.className = result.excel_warning ? "" : "ok";
    dashboardStatus.textContent = result.excel_warning ? "Saved locally. Close Excel to refresh its file." : "Saved locally. Excel is updated.";
  } catch (error) { dashboardStatus.className = ""; dashboardStatus.textContent = error.message; }
  finally { if (disableControl) control.disabled = false; saving = false; }
  if (refresh) await refreshIfChanged(true);
}
function queueFollowUpDate(control, allowBlank = false) {
  clearTimeout(followUpSaveTimers.get(control.dataset.id));
  followUpSaveTimers.delete(control.dataset.id);
  const value = control.value;
  if (!value && !allowBlank) return;
  if (value && (!control.validity.valid || Number(value.slice(0, 4)) < 2000)) {
    dashboardStatus.className = "";
    dashboardStatus.textContent = "Enter the complete four-digit follow-up year (for example, 2026).";
    return;
  }
  const timer = setTimeout(async () => {
    followUpSaveTimers.delete(control.dataset.id);
    if (!control.isConnected || control.value === control.dataset.savedValue) return;
    await updateJob(control.dataset.id, {follow_up_date: control.value}, control, {disableControl: false, refresh: false});
  }, 750);
  followUpSaveTimers.set(control.dataset.id, timer);
}
tableBody.addEventListener("focusout", event => {
  if (event.target.matches(".follow-up-date")) queueFollowUpDate(event.target, true);
});
tableBody.addEventListener("change", event => {
  const control = event.target;
  if (control.matches(".applied-select")) updateJob(control.dataset.id, {applied: control.value === "1"}, control);
});
tableBody.addEventListener("click", async event => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.matches(".save-notes")) {
    const row = button.closest("tr");
    await updateJob(button.dataset.id, {notes: row.querySelector(".tracking-notes").value, status: row.querySelector(".tracking-status").value}, button);
  } else if (button.matches(".delete-job")) {
    if (!confirm("Delete this saved job from the common tracker and Excel? Generated PDFs are kept.")) return;
    saving = true; button.disabled = true;
    try {
      await request("/api/jobs/" + button.dataset.jobId, {method: "DELETE"});
      dirtyRows.delete(button.dataset.jobId);
    } catch (error) { dashboardStatus.textContent = error.message; }
    finally { saving = false; button.disabled = false; }
    await refreshIfChanged(true);
  }
});
document.querySelector("#rematch").addEventListener("click", async event => {
  event.target.disabled = true;
  try {
    const result = await request("/api/jobs/rematch", {method: "POST", headers: {"Content-Type": "application/json"}, body: "{}"});
    dashboardStatus.textContent = result.unavailable?.length ? "Matching queued; offline: " + result.unavailable.join(", ") : "Resume matching queued.";
  } catch (error) { dashboardStatus.textContent = error.message; }
  finally { event.target.disabled = false; }
});
function applySort(column, type, direction, remember = true) {
  activeSort = {column, type, direction};
  const rows = [...tableBody.querySelectorAll("[data-job-row]")];
  rows.sort((a, b) => {
    const left = a.cells[column].dataset.sort || "", right = b.cells[column].dataset.sort || "";
    if (!left || !right) return !left === !right ? 0 : !left ? 1 : -1;
    let result = type === "number" ? Number(left) - Number(right) : type === "date"
      ? Date.parse(left.replace(/^Closing on\s+/i, "")) - Date.parse(right.replace(/^Closing on\s+/i, ""))
      : left.localeCompare(right, undefined, {numeric: true, sensitivity: "base"});
    if (Number.isNaN(result)) result = left.localeCompare(right);
    return direction === "ascending" ? result : -result;
  });
  rows.forEach(row => tableBody.appendChild(row));
  sortButtons.forEach(button => {
    const active = Number(button.dataset.column) === column;
    button.closest("th").setAttribute("aria-sort", active ? direction : "none");
    button.querySelector(".sort-indicator").textContent = active ? direction === "ascending" ? "▲" : "▼" : "↕";
  });
  if (remember) { try { localStorage.setItem(sortPreferenceKey, JSON.stringify(activeSort)); } catch {} }
}
sortButtons.forEach(button => button.addEventListener("click", () => applySort(Number(button.dataset.column), button.dataset.type,
  button.closest("th").getAttribute("aria-sort") === "ascending" ? "descending" : "ascending")));
try {
  const sort = JSON.parse(localStorage.getItem(sortPreferenceKey));
  if (Number.isInteger(sort?.column) && sort.column >= 0 && sort.column < sortButtons.length) applySort(sort.column, sortButtons[sort.column].dataset.type, sort.direction, false);
} catch {}
function mergeDashboard(documentUpdate) {
  const scrollPosition = {left: window.scrollX, top: window.scrollY};
  const incoming = [...documentUpdate.querySelectorAll("tbody [data-job-row]")];
  const ids = new Set(incoming.map(row => row.dataset.id));
  deferredRows = false;
  for (const row of [...tableBody.querySelectorAll("[data-job-row]")]) {
    if (!ids.has(row.dataset.id)) { dirtyRows.delete(row.dataset.id); row.remove(); }
  }
  for (const next of incoming) {
    const old = tableBody.querySelector('[data-job-row][data-id="' + next.dataset.id + '"]');
    if (!old) { tableBody.appendChild(next); continue; }
    const activeEditor = old.contains(document.activeElement) && document.activeElement.matches("input,textarea,select");
    if (dirtyRows.has(next.dataset.id) || activeEditor) { deferredRows = true; continue; }
    const open = [...old.querySelectorAll("details")].map(detail => detail.open);
    [...next.querySelectorAll("details")].forEach((detail, i) => { detail.open = open[i] || false; });
    old.replaceWith(next);
  }
  tableBody.querySelectorAll("tr:not([data-job-row])").forEach(row => row.remove());
  if (!incoming.length) tableBody.innerHTML = '<tr><td colspan="8" class="empty">No jobs captured yet.</td></tr>';
  const summary = documentUpdate.querySelector("header p");
  if (summary) document.querySelector("header p").textContent = summary.textContent;
  if (activeSort && !(tableBody.contains(document.activeElement) && document.activeElement.matches("input,textarea,select"))) {
    applySort(activeSort.column, activeSort.type, activeSort.direction, false);
  }
  window.scrollTo(scrollPosition);
}
async function refreshIfChanged(force = false) {
  if (saving || refreshing) return;
  if (tableBody.contains(document.activeElement) && document.activeElement.matches("input,textarea,select")) {
    deferredRows = true;
    return;
  }
  refreshing = true;
  try {
    const data = await request("/api/jobs");
    if (!force && !deferredRows && data.revision === displayedRevision) return;
    const response = await fetch("/", {cache: "no-store"});
    if (!response.ok) throw new Error("Dashboard refresh failed.");
    const updated = new DOMParser().parseFromString(await response.text(), "text/html");
    mergeDashboard(updated);
    displayedRevision = updated.querySelector('meta[name="jobs-revision"]').content;
  } catch (error) { dashboardStatus.textContent = "Dashboard reconnecting: " + error.message; }
  finally { refreshing = false; }
}
setInterval(refreshIfChanged, 1500);
window.addEventListener("focus", () => refreshIfChanged(true));
document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshIfChanged(true); });
