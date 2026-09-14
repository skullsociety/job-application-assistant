"use strict";
const displayedRevision = document.querySelector('meta[name="jobs-revision"]').content;
const sortPreferenceKey = "careersgov-dashboard-sort-v2";
const tableBody = document.querySelector("tbody");
const sortButtons = [...document.querySelectorAll(".sort-button")];
const dashboardStatus = document.querySelector("#dashboard-status");
let dirty = false;
let saving = false;
const dirtyEditors = new Set();
document.addEventListener("input", event => {
  if (event.target.matches(".tracking-notes, .tracking-status")) {
    dirtyEditors.add(event.target);
    dirty = true;
  }
});

async function request(path, options = {}) {
  const response = await fetch(path, {cache: "no-store", ...options});
  const payload = await response.json();
  if (!response.ok || !payload.ok) throw new Error(payload.error || "The request did not finish.");
  return payload;
}

async function updateJob(id, payload, control) {
  saving = true;
  control.disabled = true;
  try {
    await request("/api/jobs/" + id + "/tracking", {
      method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(payload),
    });
    dashboardStatus.className = "ok";
    dashboardStatus.textContent = "Saved locally. Excel is updating.";
    const row = control.closest("tr");
    if ("notes" in payload) dirtyEditors.delete(row.querySelector(".tracking-notes"));
    if ("status" in payload) dirtyEditors.delete(row.querySelector(".tracking-status"));
    dirty = dirtyEditors.size > 0;
    // A status change on one row must not discard unsaved notes on another.
    if (!dirty) window.location.reload();
  } catch (error) {
    dashboardStatus.className = "";
    dashboardStatus.textContent = error.message;
  } finally { control.disabled = false; saving = false; }
}
document.querySelectorAll(".applied-select, .follow-up-select, .follow-up-date").forEach(control => {
  control.addEventListener("change", () => {
    const key = control.matches(".applied-select") ? "applied" : control.matches(".follow-up-select") ? "followed_up" : "follow_up_date";
    updateJob(control.dataset.id, {[key]: key === "follow_up_date" ? control.value : control.value === "1"}, control);
  });
});
document.querySelectorAll(".save-notes").forEach(button => button.addEventListener("click", () => {
  const row = button.closest("tr");
  updateJob(button.dataset.id, {notes: row.querySelector(".tracking-notes").value, status: row.querySelector(".tracking-status").value}, button);
}));
document.querySelector("#rematch").addEventListener("click", async event => {
  event.target.disabled = true;
  try {
    await request("/api/jobs/rematch", {method: "POST", headers: {"Content-Type": "application/json"}, body: "{}"});
    dashboardStatus.className = "ok";
    dashboardStatus.textContent = "Resume matching queued.";
  } catch (error) { dashboardStatus.textContent = error.message; }
  finally { event.target.disabled = false; }
});
document.querySelectorAll(".delete-job").forEach(button => button.addEventListener("click", async () => {
  if (!window.confirm("Delete this saved job? It will also be removed from the next Excel export. Generated PDFs are kept.")) return;
  saving = true;
  button.disabled = true;
  try {
    await request("/api/jobs/" + button.dataset.jobId, {method: "DELETE"});
    window.location.reload();
  } catch (error) { dashboardStatus.textContent = error.message; button.disabled = false; }
  finally { saving = false; }
}));

function applySort(column, type, direction, remember = true) {
  const rows = [...tableBody.querySelectorAll("[data-job-row]")];
  rows.sort((a, b) => {
    const left = a.cells[column].dataset.sort || "";
    const right = b.cells[column].dataset.sort || "";
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
  if (remember) { try { localStorage.setItem(sortPreferenceKey, JSON.stringify({column, type, direction})); } catch (_) {} }
}
sortButtons.forEach(button => button.addEventListener("click", () => {
  applySort(Number(button.dataset.column), button.dataset.type, button.closest("th").getAttribute("aria-sort") === "ascending" ? "descending" : "ascending");
}));
try {
  const sort = JSON.parse(localStorage.getItem(sortPreferenceKey));
  if (Number.isInteger(sort?.column) && sort.column >= 0 && sort.column < sortButtons.length) {
    applySort(sort.column, sortButtons[sort.column].dataset.type, sort.direction, false);
  }
} catch (_) {}
async function refreshIfChanged() {
  if (dirty || saving || document.hidden || document.querySelector("details[open]") || document.activeElement?.matches("input,textarea,select,button")) return;
  try { const data = await request("/api/jobs"); if (data.revision !== displayedRevision) window.location.reload(); } catch (_) {}
}
setInterval(refreshIfChanged, 2000);
window.addEventListener("focus", refreshIfChanged);
