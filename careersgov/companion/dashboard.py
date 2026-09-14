"""Compact local tracker using the LinkedIn / JobStreet dashboard layout."""

from __future__ import annotations

from datetime import datetime
from html import escape
from pathlib import Path
from typing import Any
from urllib.parse import quote

from .tracker import VALID_STATUSES


def display_date(value: str | None) -> str:
    if not value:
        return "—"
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).strftime("%d %b %Y")
    except ValueError:
        return value


def e(value: Any) -> str:
    return escape(str(value or ""), quote=True)


def render(jobs: list[dict[str, Any]], revision: str) -> str:
    rows = []
    for job in jobs:
        identifier = int(job["id"])
        title = e(job["title"])
        score = job.get("match_score")
        score_text = f"{score}%" if score is not None else "Analysis pending" if job.get("recommendation") == "analysis pending" else "Not scored"
        metadata = " · ".join(str(job[key]) for key in ("platform", "location", "workplace_type", "employment_type") if job.get(key))
        resume = job.get("tailored_resume_path")
        resume_link = f'<a href="/tailored/{quote(Path(resume).name)}" target="_blank" rel="noreferrer">Open tailored PDF</a>' if resume else "—"
        options = "".join(f'<option value="{status}"{" selected" if job.get("status", "saved") == status else ""}>{status.replace("_", " ")}</option>' for status in sorted(VALID_STATUSES))
        rows.append(
            f'<tr data-job-row data-id="{identifier}" class="{"applied-row" if job.get("applied") else ""}">'
            f'<td class="position" data-sort="{title}"><a href="{e(job["url"])}" target="_blank" rel="noreferrer">{title}</a>'
            f'<strong>{e(job["company"])}</strong><small>#{identifier} · {e(metadata)}</small>'
            f'<small>{e(job.get("salary") or "Salary not shown")}</small>'
            f'<details><summary>Job details &amp; notes</summary><div class="detail">'
            f'<p>Posted: {e(job.get("posting_date") or "Not shown")}</p>'
            f'<p class="description">{e(job.get("job_description") or job.get("description"))}</p>'
            f'<label>Status<select class="tracking-status" data-id="{identifier}">{options}</select></label>'
            f'<label>Notes<textarea class="tracking-notes" data-id="{identifier}" maxlength="10000" rows="3">{e(job.get("notes"))}</textarea></label>'
            f'<button class="save-notes" data-id="{identifier}" type="button">Save notes &amp; status</button></div></details></td>'
            f'<td data-sort="{e(job.get("first_seen_at") or job.get("captured_at"))}">{e(display_date(job.get("first_seen_at") or job.get("captured_at")))}'
            f'<small>Seen {job.get("seen_count", 1)} times</small></td>'
            f'<td data-sort="{score if score is not None else ""}"><b>{score_text}</b><small>{e(job.get("recommendation") or "review manually")}</small>'
            f'<details><summary>Skills &amp; reasoning</summary><div class="detail"><p><b>Key skills:</b> {e(job.get("key_skills") or "None recognized")}</p>'
            f'<p><b>Matching:</b> {e(job.get("matching_skills") or "None")}</p>'
            f'<p><b>Missing:</b> {e(job.get("missing_skills") or "None")}</p><p>{e(job.get("match_reason"))}</p></div></details></td>'
            f'<td data-sort="{int(bool(job.get("applied")))}"><select class="applied-select" data-id="{identifier}" aria-label="Application status for {title}">'
            f'<option value="0"{"" if job.get("applied") else " selected"}>Not applied</option><option value="1"{" selected" if job.get("applied") else ""}>Applied</option></select>'
            f'<small>{e(display_date(job.get("applied_at")) if job.get("applied") else "Not applied")}</small></td>'
            f'<td data-sort="{int(bool(job.get("followed_up")))}"><select class="follow-up-select" data-id="{identifier}" aria-label="Follow-up status for {title}">'
            f'<option value="0"{"" if job.get("followed_up") else " selected"}>No</option><option value="1"{" selected" if job.get("followed_up") else ""}>Yes</option></select>'
            f'<label>Follow-up date<input class="follow-up-date" data-id="{identifier}" type="date" value="{e(job.get("follow_up_date"))}"></label></td>'
            f'<td data-sort="{1 if resume else 0}">{resume_link}</td>'
            f'<td data-sort="{e(job.get("closing_date"))}">{e(job.get("closing_date") or "Not shown")}</td>'
            f'<td><button class="delete-job" data-job-id="{identifier}" type="button">Delete</button></td></tr>'
        )
    columns = [("Position", "text"), ("Captured", "date"), ("Match", "number"), ("Applied?", "number"), ("Followed up?", "number"), ("Resume", "number"), ("Closing", "date")]
    headers = "".join(f'<th aria-sort="none"><button class="sort-button" data-column="{index}" data-type="{kind}">{label} <span class="sort-indicator" aria-hidden="true">↕</span></button></th>' for index, (label, kind) in enumerate(columns))
    template = Path(__file__).with_name("dashboard.html").read_text(encoding="utf-8")
    return template.replace("{{REVISION}}", revision).replace("{{COUNT}}", str(len(jobs))).replace(
        "{{APPLIED}}", str(sum(bool(job.get("applied")) for job in jobs))).replace(
        "{{FOLLOWED}}", str(sum(bool(job.get("followed_up")) for job in jobs))).replace(
        "{{HEADERS}}", headers).replace("{{ROWS}}", "".join(rows) or '<tr><td colspan="8" class="empty">No jobs captured yet.</td></tr>')
