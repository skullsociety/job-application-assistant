from __future__ import annotations

from datetime import date, datetime
from typing import Any
from urllib.parse import urlsplit
import hashlib
import sqlite3

VALID_STATUSES = {"saved", "reviewing", "ready_for_manual_submit", "submitted_manually", "rejected", "archived"}


def description_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def public_job(row: dict[str, Any]) -> dict[str, Any]:
    return {**row, "applied": bool(row.get("applied")), "followed_up": bool(row.get("followed_up"))}


def optional_http_url(value: str | None) -> str | None:
    if not value:
        return None
    parsed = urlsplit(value)
    if parsed.scheme not in {"https", "http"} or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("Captured links must be ordinary HTTP or HTTPS URLs without credentials.")
    return value


def validate_tracking(payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict) or not payload:
        raise ValueError("Choose a tracking value to update.")
    allowed = {"applied", "followed_up", "follow_up_date", "notes", "status"}
    if set(payload) - allowed:
        raise ValueError("Only application tracking fields can be changed here.")
    for key, value in payload.items():
        if key in {"applied", "followed_up"} and not isinstance(value, bool):
            raise ValueError(f"{key} must be true or false.")
        if key == "status" and value not in VALID_STATUSES:
            raise ValueError("Unknown application status.")
        if key == "notes" and (not isinstance(value, str) or len(value) > 10000):
            raise ValueError("Notes must be text of at most 10000 characters.")
        if key == "follow_up_date":
            if value is not None and not isinstance(value, str):
                raise ValueError("Use YYYY-MM-DD for the follow-up date.")
            if value and date.fromisoformat(value).isoformat() != value:
                raise ValueError("Use YYYY-MM-DD for the follow-up date.")
    if "status" in payload and "applied" in payload:
        if payload["status"] == "submitted_manually" and not payload["applied"]:
            raise ValueError("Application status and Applied must agree.")
    return dict(payload)


def update_tracking(connection: sqlite3.Connection, job_id: int, payload: dict) -> None:
    changes = validate_tracking(payload)
    connection.execute("BEGIN IMMEDIATE")
    row = connection.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
    if row is None:
        raise KeyError("This job no longer exists.")
    now = datetime.now().astimezone().isoformat(timespec="seconds")
    if "follow_up_date" in changes or "followed_up" in changes:
        changes["followed_up"] = bool(changes.get("follow_up_date", row["follow_up_date"]))
    if changes.get("status") == "submitted_manually":
        changes["applied"] = True
    if "applied" in changes:
        changes["applied_at"] = (row["applied_at"] or now) if changes["applied"] else None
        if changes["applied"] and "status" not in changes:
            changes["status"] = "submitted_manually"
        elif row["status"] == "submitted_manually" and "status" not in changes:
            changes["status"] = "saved"
    if "followed_up" in changes:
        changes["followed_up_at"] = (row["followed_up_at"] or now) if changes["followed_up"] else None
    changes["updated_at"] = now
    assignments = ", ".join(f"{key}=?" for key in changes)
    connection.execute(f"UPDATE jobs SET {assignments} WHERE id=?", (*changes.values(), job_id))
    for key, event in (("applied", "APPLICATION"), ("followed_up", "FOLLOW_UP")):
        if key in changes and bool(row[key]) != changes[key]:
            connection.execute("INSERT INTO job_events (job_id,event_type,source,confirmed_by_user) VALUES (?,?,'dashboard',1)",
                               (job_id, event + ("_MARKED" if changes[key] else "_UNMARKED")))
    connection.commit()
