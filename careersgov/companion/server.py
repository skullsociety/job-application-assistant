"""Local-only storage service and dashboard for the Careers@Gov extension."""

from __future__ import annotations

import hashlib
import json
import queue
import re
import sqlite3
import threading
from contextlib import closing
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit, urlunsplit

from .excel_export import TRACKER_PATH, export_jobs
from .matching import extract_skills, match_resume
from .resume_tools import create_tailored_resume, latest_resume, read_resume
from .tracker import CAPTURE_FIELDS, SHARED_COLUMNS, description_hash, optional_http_url, public_job, validate_tracking
from shared_tracker.schema import DATABASE_PATH, EXTRA_COLUMNS, LOCAL_DATA, normalize_shared_rows

HOST = "127.0.0.1"
PORT = 8765
PROJECT_ROOT = Path(__file__).resolve().parent.parent
RESUME_DIR = LOCAL_DATA / "resumes"
TAILORED_RESUME_DIR = LOCAL_DATA / "exports" / "tailored_resumes"
HIGH_COMPATIBILITY_THRESHOLD = 70
GOVTECH_TAILORED_RESUME_THRESHOLD = 50
MAX_REQUEST_BYTES = 1_000_000


def _is_govtech_agency(company: str) -> bool:
    normalized = " ".join(company.casefold().split())
    return "govtech" in normalized or "government technology agency" in normalized


def _should_create_tailored_resume(score: int | None, company: str, default_threshold: int) -> bool:
    if score is None:
        return False
    if _is_govtech_agency(company):
        return score > GOVTECH_TAILORED_RESUME_THRESHOLD
    return score >= default_threshold


class JobStore:
    """Small SQLite store with stable-URL upserts."""

    def __init__(
        self,
        path: Path = DATABASE_PATH,
        resume_dir: Path = RESUME_DIR,
        tailored_resume_dir: Path = TAILORED_RESUME_DIR,
        high_compatibility_threshold: int = HIGH_COMPATIBILITY_THRESHOLD,
    ) -> None:
        self.path = path
        self.resume_dir = resume_dir
        self.tailored_resume_dir = tailored_resume_dir
        self.high_compatibility_threshold = high_compatibility_threshold
        self._resume_cache: tuple[Path, int, str] | None = None
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if self.path.resolve() == DATABASE_PATH.resolve():
            from linkedin.job_assistant.database import JobRepository
            with JobRepository(self.path):
                pass
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout = 30000")
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    def _initialize(self) -> None:
        with closing(self._connect()) as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS jobs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    url TEXT NOT NULL UNIQUE,
                    title TEXT NOT NULL,
                    company TEXT NOT NULL,
                    employment_type TEXT,
                    closing_date TEXT,
                    description TEXT,
                    key_skills TEXT,
                    match_score INTEGER,
                    matching_skills TEXT,
                    missing_skills TEXT,
                    match_reason TEXT,
                    recommendation TEXT,
                    resume_name TEXT,
                    tailored_resume_path TEXT,
                    captured_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            existing = {row[1] for row in connection.execute("PRAGMA table_info(jobs)").fetchall()}
            if "source" not in existing and connection.execute("SELECT 1 FROM jobs LIMIT 1").fetchone():
                backup = self.path.with_name(self.path.name + ".pre-v0.9.0.bak")
                if not backup.exists():
                    with closing(sqlite3.connect(backup)) as destination:
                        connection.backup(destination)
            migrations = {
                **EXTRA_COLUMNS,
                "key_skills": "TEXT",
                "match_score": "INTEGER",
                "matching_skills": "TEXT",
                "missing_skills": "TEXT",
                "match_reason": "TEXT",
                "recommendation": "TEXT",
                "resume_name": "TEXT",
                "tailored_resume_path": "TEXT",
                **SHARED_COLUMNS,
            }
            for column, column_type in migrations.items():
                if column not in existing:
                    connection.execute(f"ALTER TABLE jobs ADD COLUMN {column} {column_type}")
            connection.execute("""
                UPDATE jobs SET job_description = COALESCE(job_description, description),
                    date_found = COALESCE(date_found, substr(captured_at, 1, 10)),
                    first_seen_at = COALESCE(first_seen_at, captured_at),
                    last_seen_at = COALESCE(last_seen_at, updated_at),
                    created_at = COALESCE(created_at, captured_at)
            """)
            for row in connection.execute("SELECT id, job_description FROM jobs WHERE description_hash IS NULL").fetchall():
                connection.execute("UPDATE jobs SET description_hash = ? WHERE id = ?",
                                   (description_hash(row["job_description"] or ""), row["id"]))
            connection.commit()

    def upsert(self, payload: dict[str, Any], analyze: bool = True) -> dict[str, Any]:
        job = validate_job(payload)
        now = datetime.now().astimezone().isoformat(timespec="seconds")
        skills = ", ".join(extract_skills(f"{job['title']}\n{job.get('job_description') or ''}"))
        capture = {
            **job, "key_skills": skills, "matching_skills": "", "missing_skills": skills,
            "source_job_id": job["url"].rsplit("/", 1)[-1],
            "match_score": None, "match_reason": "Resume comparison is queued and will update automatically.",
            "recommendation": "analysis pending", "resume_name": None, "tailored_resume_path": None,
            "description_hash": description_hash(job["job_description"] or ""),
            "last_seen_at": now, "updated_at": now,
        }
        with closing(self._connect()) as connection:
            connection.execute("BEGIN IMMEDIATE")
            previous = connection.execute("SELECT id FROM jobs WHERE url = ?", (job["url"],)).fetchone()
            if previous:
                assignments = ", ".join(f"{column} = ?" for column in capture)
                connection.execute(
                    f"UPDATE jobs SET {assignments}, seen_count = seen_count + 1 WHERE id = ?",
                    (*capture.values(), previous["id"]),
                )
                job_id = previous["id"]
            else:
                capture.update(captured_at=now, first_seen_at=now, created_at=now, date_found=now[:10])
                columns = ", ".join(capture)
                placeholders = ", ".join("?" for _ in capture)
                cursor = connection.execute(f"INSERT INTO jobs ({columns}) VALUES ({placeholders})", tuple(capture.values()))
                job_id = cursor.lastrowid
            connection.commit()
        if analyze:
            self._update_analysis(self.get(job_id))
        return self.get(job_id)

    def update_tracking(self, job_id: int, payload: dict[str, Any]) -> dict[str, Any]:
        changes = validate_tracking(payload)
        now = datetime.now().astimezone().isoformat(timespec="seconds")
        with closing(self._connect()) as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
            if row is None:
                raise KeyError(f"No captured job found with id {job_id}.")
            if "status" in changes and changes["status"] == "submitted_manually":
                changes["applied"] = True
            if "applied" in changes:
                changes["applied_at"] = (row["applied_at"] or now) if changes["applied"] else None
                changes["status"] = "submitted_manually" if changes["applied"] else "saved"
            if "follow_up_date" in changes or "followed_up" in changes:
                changes["followed_up"] = bool(changes.get("follow_up_date", row["follow_up_date"]))
            if "followed_up" in changes:
                changes["followed_up_at"] = (row["followed_up_at"] or now) if changes["followed_up"] else None
            changes["updated_at"] = now
            assignments = ", ".join(f"{column} = ?" for column in changes)
            connection.execute(f"UPDATE jobs SET {assignments} WHERE id = ?", (*changes.values(), job_id))
            connection.commit()
        return self.get(job_id)

    def get(self, job_id: int) -> dict[str, Any]:
        with closing(self._connect()) as connection:
            row = connection.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        if row is None:
            raise KeyError(f"No captured job found with id {job_id}.")
        return public_job(dict(row))

    def list_jobs(self, include_all: bool = False) -> list[dict[str, Any]]:
        with closing(self._connect()) as connection:
            where = "" if include_all else " WHERE source='careersgov'"
            rows = connection.execute("SELECT * FROM jobs" + where + " ORDER BY updated_at DESC, id DESC").fetchall()
        return [public_job(dict(row)) for row in rows]

    def delete(self, job_id: int) -> None:
        """Delete one stored dashboard record without removing generated files."""
        with closing(self._connect()) as connection:
            cursor = connection.execute("DELETE FROM jobs WHERE id = ?", (job_id,))
            connection.commit()
        if cursor.rowcount == 0:
            raise KeyError(f"No captured job found with id {job_id}.")

    def refresh_analysis(self) -> None:
        """Re-run matching for existing captures after startup or resume changes."""
        for job in self.list_jobs():
            self._update_analysis(job)

    def analyze_job(self, job_id: int) -> None:
        """Run the heavier resume comparison for one previously stored job."""
        self._update_analysis(self.get(job_id))

    def _latest_resume_text(self) -> tuple[Path, str]:
        resume_path = latest_resume(self.resume_dir)
        modified = resume_path.stat().st_mtime_ns
        if self._resume_cache and self._resume_cache[:2] == (resume_path, modified):
            return resume_path, self._resume_cache[2]
        resume_text = read_resume(resume_path)
        self._resume_cache = (resume_path, modified, resume_text)
        return resume_path, resume_text

    def _update_analysis(self, job: dict[str, Any]) -> None:
        if job.get("source") != "careersgov":
            return
        key_skills = extract_skills(f"{job['title']}\n{job.get('description') or ''}")
        analysis: dict[str, Any] = {
            "key_skills": ", ".join(key_skills),
            "match_score": None,
            "matching_skills": "",
            "missing_skills": ", ".join(key_skills),
            "match_reason": "No source resume is available for comparison.",
            "recommendation": "review manually",
            "resume_name": None,
            "tailored_resume_path": None,
        }
        try:
            resume_path, resume_text = self._latest_resume_text()
            match = match_resume(resume_text, str(job["title"]), str(job.get("description") or ""))
            analysis.update(
                match_score=match.score,
                matching_skills=", ".join(match.matching_skills),
                missing_skills=", ".join(match.missing_skills),
                match_reason=match.reason,
                recommendation=match.recommendation,
                resume_name=resume_path.name,
            )
            company = str(job["company"])
            if _should_create_tailored_resume(match.score, company, self.high_compatibility_threshold):
                output = create_tailored_resume(
                    resume_text,
                    int(job["id"]),
                    company,
                    str(job["title"]),
                    match,
                    self.tailored_resume_dir,
                )
                analysis["tailored_resume_path"] = output.name
                if _is_govtech_agency(company) and match.score is not None and match.score < self.high_compatibility_threshold:
                    analysis["recommendation"] = "GovTech tailored resume created because compatibility is above 50%"
        except Exception as exc:
            analysis["match_reason"] = f"Resume processing unavailable: {exc}"

        with closing(self._connect()) as connection:
            connection.execute(
                """
                UPDATE jobs SET
                    key_skills = ?, match_score = ?, matching_skills = ?, missing_skills = ?,
                    match_reason = ?, recommendation = ?, resume_name = ?, tailored_resume_path = ?
                WHERE id = ? AND description_hash = ? AND title = ?
                """,
                (
                    analysis["key_skills"], analysis["match_score"], analysis["matching_skills"],
                    analysis["missing_skills"], analysis["match_reason"], analysis["recommendation"],
                    analysis["resume_name"], analysis["tailored_resume_path"], int(job["id"]),
                    job.get("description_hash"), job["title"],
                ),
            )
            connection.commit()


def canonicalize_careers_gov_url(value: str) -> str:
    """Accept only HTTPS Careers@Gov job pages and remove tracking fragments."""
    parsed = urlsplit(value.strip())
    if parsed.scheme.casefold() != "https" or (parsed.hostname or "").casefold() != "jobs.careers.gov.sg":
        raise ValueError("Only Careers@Gov job URLs can be captured.")
    path = parsed.path.rstrip("/")
    if not path.startswith("/jobs/"):
        raise ValueError("Open a full Careers@Gov job-detail page before capturing.")
    return urlunsplit(("https", "jobs.careers.gov.sg", path, "", ""))


def validate_job(payload: dict[str, Any]) -> dict[str, Any]:
    """Validate and normalise the small payload accepted from the extension."""
    if not isinstance(payload, dict):
        raise ValueError("The capture payload must be an object.")
    title = _optional_text(payload.get("title"), 500) or ""
    company = _optional_text(payload.get("company"), 500) or ""
    if not title or not company:
        raise ValueError("The job title and agency must both be visible.")
    if len(title) > 500 or len(company) > 500:
        raise ValueError("The captured title or agency is unexpectedly long.")
    description = _optional_text(payload.get("job_description") or payload.get("description"), 500_000) or ""
    if len(description) > 500_000:
        raise ValueError("The captured job description is unexpectedly large.")
    return {
        "url": canonicalize_careers_gov_url(str(payload.get("url", ""))),
        "title": title,
        "company": company,
        **{field: _optional_text(payload.get(field), 2000 if field.endswith("_url") else 200) for field in CAPTURE_FIELDS},
        "company_url": optional_http_url(_optional_text(payload.get("company_url"), 2000)),
        "application_url": optional_http_url(_optional_text(payload.get("application_url"), 2000)),
        "platform": "Careers@Gov",
        "source": "careersgov",
        "job_description": description or None,
        "description": description or None,
    }


def _optional_text(value: Any, maximum: int) -> str | None:
    if value is not None and not isinstance(value, str):
        raise ValueError("Captured text fields must be strings.")
    text = str(value or "").strip()
    if len(text) > maximum:
        raise ValueError("A captured field is unexpectedly long.")
    return text or None


class BackgroundProcessor:
    """Serialise analysis and debounce Excel exports without delaying captures."""

    def __init__(self, store: JobStore) -> None:
        self.store = store
        self._analysis_queue: queue.Queue[int | None] = queue.Queue()
        self._export_requested = threading.Event()
        self._stop_requested = threading.Event()
        self._analysis_thread = threading.Thread(
            target=self._analysis_loop,
            name="CareersGovAnalysis",
            daemon=True,
        )
        self._export_thread = threading.Thread(
            target=self._export_loop,
            name="CareersGovExcelExport",
            daemon=True,
        )
        self._analysis_thread.start()
        self._export_thread.start()

    def enqueue(self, job_id: int) -> None:
        self._analysis_queue.put(job_id)

    def request_export(self) -> None:
        self._export_requested.set()

    def _analysis_loop(self) -> None:
        while not self._stop_requested.is_set():
            job_id = self._analysis_queue.get()
            if job_id is None:
                return
            batch = [job_id]
            while True:
                try:
                    queued = self._analysis_queue.get_nowait()
                except queue.Empty:
                    break
                if queued is None:
                    return
                batch.append(queued)
            for queued_id in dict.fromkeys(batch):
                try:
                    self.store.analyze_job(queued_id)
                except Exception as exc:
                    print(f"Analysis failed for job #{queued_id}: {exc}")
            self._export_requested.set()

    def _export_loop(self) -> None:
        while not self._stop_requested.is_set():
            if not self._export_requested.wait(timeout=0.5):
                continue
            self._export_requested.clear()
            while self._export_requested.wait(timeout=0.5):
                self._export_requested.clear()
            if not self._stop_requested.is_set():
                _refresh_excel_tracker(self.store)

    def close(self) -> None:
        self._stop_requested.set()
        self._analysis_queue.put(None)
        self._export_requested.set()
        self._analysis_thread.join(timeout=2)
        self._export_thread.join(timeout=2)


class CompanionHandler(BaseHTTPRequestHandler):
    """Serve a read-only dashboard and a narrowly scoped extension API."""

    store: JobStore
    processor: BackgroundProcessor | None = None
    server_version = "CareersGovCompanion/0.1"

    def do_OPTIONS(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        origin = self.headers.get("Origin", "")
        if not _is_extension_origin(origin):
            self.send_error(HTTPStatus.FORBIDDEN, "Only the Chrome extension may write to this companion.")
            return
        self.send_response(HTTPStatus.NO_CONTENT)
        self._cors_headers(origin)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        assets = {"/dashboard.css": "text/css", "/dashboard.js": "application/javascript"}
        if self.path in assets:
            path = Path(__file__).with_name(self.path[1:])
            self._send_file(path, assets[self.path])
            return
        if self.path == "/exports/job_tracker.xlsx":
            self._send_file(TRACKER_PATH, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
            return
        if self.path == "/":
            self.send_response(HTTPStatus.FOUND)
            self.send_header("Location", "http://127.0.0.1:8767/")
            self.end_headers()
            return
        if self.path == "/api/health":
            self._send_json(HTTPStatus.OK, {"ok": True, "service": "Careers@Gov Companion", "database_path": str(self.store.path), "shared_tracker": True})
            return
        if self.path == "/api/jobs":
            jobs = self.store.list_jobs()
            self._send_json(HTTPStatus.OK, {"ok": True, "jobs": jobs, "revision": _jobs_revision(jobs)})
            return
        detail_match = re.fullmatch(r"/api/jobs/(\d+)", self.path)
        if detail_match:
            try:
                self._send_json(HTTPStatus.OK, {"ok": True, "job": self.store.get(int(detail_match[1]))})
            except KeyError:
                self._send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "This job no longer exists."})
            return
        if self.path.startswith("/tailored/"):
            self._send_tailored_resume(self.path.removeprefix("/tailored/"))
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        origin = self.headers.get("Origin", "")
        tracking_match = re.fullmatch(r"/api/jobs/(\d+)/(tracking|application|follow-up)", self.path)
        if tracking_match or self.path == "/api/jobs/rematch":
            if not (_is_extension_origin(origin) or _is_dashboard_origin(origin)):
                self._send_json(HTTPStatus.FORBIDDEN, {"ok": False, "error": "Use the local dashboard or extension."})
                return
            self._update_tracker(tracking_match, origin)
            return
        if not _is_extension_origin(origin):
            self._send_json(
                HTTPStatus.FORBIDDEN,
                {"ok": False, "error": "Only the installed Chrome extension may save jobs."},
            )
            return
        if self.path != "/api/jobs":
            self._send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "Unknown endpoint."}, origin)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > MAX_REQUEST_BYTES:
                raise ValueError("The capture request has an invalid size.")
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            saved = self.store.upsert(payload, analyze=False)
            if self.processor is not None:
                self.processor.enqueue(int(saved["id"]))
                analysis_queued = True
                export_warning = None
            else:
                self.store.analyze_job(int(saved["id"]))
                saved = self.store.get(int(saved["id"]))
                analysis_queued = False
                export_warning = _refresh_excel_tracker(self.store)
        except (ValueError, json.JSONDecodeError) as exc:
            self._send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)}, origin)
            return
        except Exception as exc:
            self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": str(exc)}, origin)
            return
        response: dict[str, Any] = {
            "ok": True,
            "job": saved,
            "analysis_queued": analysis_queued,
            "excel_tracker": str(TRACKER_PATH),
        }
        if export_warning:
            response["excel_warning"] = export_warning
        self._send_json(HTTPStatus.OK, response, origin)

    def _update_tracker(self, match: re.Match[str] | None, origin: str) -> None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > MAX_REQUEST_BYTES:
                raise ValueError("Invalid request size.")
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("The request must be an object.")
            if match:
                saved = self.store.update_tracking(int(match[1]), payload)
                if self.processor:
                    self.processor.request_export()
                else:
                    _refresh_excel_tracker(self.store)
                self._send_json(HTTPStatus.OK, {"ok": True, "job": saved}, origin)
            else:
                if not self.processor:
                    self._send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"ok": False, "error": "Background matching is unavailable."}, origin)
                    return
                jobs = self.store.list_jobs()
                for job in jobs:
                    self.processor.enqueue(int(job["id"]))
                self._send_json(HTTPStatus.ACCEPTED, {"ok": True, "queued": len(jobs)}, origin)
        except KeyError:
            self._send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "This job no longer exists."}, origin)
        except (ValueError, TypeError) as exc:
            self._send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)}, origin)
        except Exception:
            self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": "The local update could not be completed."}, origin)

    def _send_file(self, path: Path, content_type: str) -> None:
        if not path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        body = path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_DELETE(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        origin = self.headers.get("Origin", "")
        if not _is_dashboard_origin(origin):
            self._send_json(
                HTTPStatus.FORBIDDEN,
                {"ok": False, "error": "Jobs can only be deleted from the local dashboard."},
            )
            return
        prefix = "/api/jobs/"
        identifier = self.path.removeprefix(prefix)
        if not self.path.startswith(prefix) or not identifier.isdigit():
            self._send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "Unknown endpoint."})
            return
        job_id = int(identifier)
        try:
            self.store.delete(job_id)
            if self.processor is not None:
                self.processor.request_export()
                export_queued = True
                export_warning = None
            else:
                export_queued = False
                export_warning = _refresh_excel_tracker(self.store)
        except KeyError as exc:
            self._send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": str(exc)})
            return
        except Exception as exc:
            self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": str(exc)})
            return
        response: dict[str, Any] = {"ok": True, "deleted_id": job_id, "excel_update_queued": export_queued}
        if export_warning:
            response["excel_warning"] = export_warning
        self._send_json(HTTPStatus.OK, response)

    def _send_json(self, status: HTTPStatus, payload: dict[str, Any], origin: str = "") -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if _is_extension_origin(origin):
            self._cors_headers(origin)
        self.end_headers()
        self.wfile.write(body)

    def _send_html(self, document: str) -> None:
        body = document.encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_tailored_resume(self, encoded_name: str) -> None:
        name = unquote(encoded_name)
        if not name or Path(name).name != name or not name.casefold().endswith(".pdf"):
            self.send_error(HTTPStatus.BAD_REQUEST)
            return
        path = self.store.tailored_resume_dir / name
        if not path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        body = path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/pdf")
        self.send_header("Content-Disposition", f'inline; filename="{name}"')
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _cors_headers(self, origin: str) -> None:
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Vary", "Origin")

    def log_message(self, format: str, *args: object) -> None:
        timestamp = datetime.now().astimezone().strftime("%H:%M:%S")
        print(f"[{timestamp}] {self.address_string()} - {format % args}")


def _is_extension_origin(origin: str) -> bool:
    parsed = urlsplit(origin)
    return parsed.scheme == "chrome-extension" and bool(parsed.hostname) and not parsed.path.strip("/")


def _is_dashboard_origin(origin: str) -> bool:
    return origin in {f"http://{HOST}:{PORT}", "http://127.0.0.1:8767"}


def _jobs_revision(jobs: list[dict[str, Any]]) -> str:
    """Return a stable fingerprint so an open dashboard can detect saved changes."""
    serialized = json.dumps(jobs, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def _refresh_excel_tracker(store: JobStore) -> str | None:
    """Refresh the XLSX without allowing an Excel lock to break job capture."""
    try:
        from shared_tracker.exporter import export_database
        export_database(store.path, TRACKER_PATH)
    except Exception as exc:
        warning = str(exc)
        print(f"Excel tracker was not refreshed: {warning}")
        return warning
    return None


def render_dashboard(jobs: list[dict[str, Any]]) -> str:
    from .dashboard import render

    return render(jobs, _jobs_revision(jobs))


def run() -> None:
    store = JobStore()
    processor = BackgroundProcessor(store)
    CompanionHandler.store = store
    CompanionHandler.processor = processor
    server = ThreadingHTTPServer((HOST, PORT), CompanionHandler)
    # Bind before slow PDF / Excel work so the extension can connect immediately.
    for job in store.list_jobs():
        processor.enqueue(int(job["id"]))
    processor.request_export()
    print("Careers@Gov companion is running locally.")
    print(f"Dashboard: http://{HOST}:{PORT}/")
    print("Leave this window open. Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping Careers@Gov companion.")
    finally:
        server.server_close()
        processor.close()


if __name__ == "__main__":
    run()
