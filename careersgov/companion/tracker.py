"""LinkedIn/JobStreet-compatible fields, without coupling the three databases."""

from __future__ import annotations

import hashlib
from datetime import date
from typing import Any
from urllib.parse import urlsplit

# Additive migration: legacy Careers@Gov columns and local IDs are retained.
SHARED_COLUMNS = {
    "platform": "TEXT NOT NULL DEFAULT 'Careers@Gov'",
    "source": "TEXT NOT NULL DEFAULT 'careersgov'",
    "job_description": "TEXT",
    "location": "TEXT", "salary": "TEXT", "workplace_type": "TEXT",
    "posting_date": "TEXT", "company_url": "TEXT", "application_url": "TEXT",
    "application_method": "TEXT", "seniority_level": "TEXT", "applicant_count": "TEXT",
    "linkedin_job_id": "TEXT", "description_hash": "TEXT",
    "date_found": "TEXT", "first_seen_at": "TEXT", "last_seen_at": "TEXT",
    "seen_count": "INTEGER NOT NULL DEFAULT 1", "created_at": "TEXT",
    "notes": "TEXT", "status": "TEXT NOT NULL DEFAULT 'saved'",
    "priority": "TEXT", "interest_level": "TEXT", "tags": "TEXT",
    "applied": "INTEGER NOT NULL DEFAULT 0", "applied_at": "TEXT",
    "follow_up_date": "TEXT", "followed_up": "INTEGER NOT NULL DEFAULT 0",
    "followed_up_at": "TEXT",
}
CAPTURE_FIELDS = (
    "location", "salary", "workplace_type", "employment_type", "posting_date",
    "closing_date", "company_url", "application_url", "application_method",
    "seniority_level", "applicant_count",
)
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
        if (payload["status"] == "submitted_manually") != payload["applied"]:
            raise ValueError("Application status and Applied must agree.")
    return dict(payload)
