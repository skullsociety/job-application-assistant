"""Local storage, resume analysis, and dashboard for the JobStreet extension.

The service listens only on this computer. The Chrome side panel accepts manual
listing details, while Python retains the existing SQLite, resume, PDF, and
Excel workflow shared with the LinkedIn assistant when available.
"""

from __future__ import annotations

import hashlib
import html
import json
import queue
import re
import shutil
import threading
from dataclasses import asdict
from datetime import datetime
from difflib import SequenceMatcher
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit
from urllib.request import Request, urlopen

from job_assistant.config import Settings, get_settings
from shared_tracker.schema import WORKSPACE
from shared_tracker.tracking import update_tracking
from shared_tracker.dashboard import render as render_shared_dashboard
from shared_tracker.autofill_profile import get_profile, save_profile, allowed_extension, allowed_extension_request
from job_assistant.cover_letter import generate_cover_letter
from job_assistant.database import JobRepository
from job_assistant.draft_answers import generate_draft_answers
from job_assistant.exporter import export_jobs
from shared_tracker.exporter import export_database
from job_assistant.models import Job
from job_assistant.profile import load_profile
from job_assistant.resume_matcher import extract_skills, match_resume_to_job
from job_assistant.resume_reader import latest_resume, read_resume
from job_assistant.tailored_resume import create_tailored_resume
from job_assistant.urls import canonicalize_job_url, is_jobstreet_hostname
from shared_tracker.cover_letters import save_cover_letter

HOST = "127.0.0.1"
PORT = 8767
MAX_REQUEST_BYTES = 1_000_000
CHROME_EXTENSION_ORIGIN = "chrome-extension://kbgmahagnbefnlfjghabpfagaknmbfjd"
VERIFICATION_MARKERS = (
    "security verification",
    "verify your identity",
    "unusual activity",
    "captcha",
    "robot check",
)
INVALID_JOB_TITLES = frozenset({
    "applicant insights",
    "be among the first applicants",
    "be among the top applicants",
    "job search",
    "jobs",
    "recommended jobs",
    "top applicant",
    "you d be a top applicant",
    "you re a top applicant",
    "search jobs",
    "jobstreet",
})


class JobStreetStore:
    """Thread-safe facade that opens a short-lived SQLite connection per action."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._export_lock = threading.Lock()
        # Finish schema upgrades before the health endpoint can report ready.
        with self._repository():
            pass

    def _repository(self) -> JobRepository:
        return JobRepository(self.settings.database_path)

    def upsert_capture(self, payload: dict[str, Any]) -> Job:
        job = payload_to_job(payload)
        with self._repository() as repository:
            saved = repository.upsert(job)
            # A re-capture must not show a score for an older description while
            # the current description is being analysed in the background.
            return repository.reset_match(_job_id(saved))

    def get(self, job_id: int) -> Job:
        with self._repository() as repository:
            job = repository.get(job_id)
        if not job:
            raise KeyError(f"No saved job found with id {job_id}.")
        return job

    def list(self) -> list[Job]:
        with self._repository() as repository:
            return repository.list()

    def related_to(self, job_id: int) -> list[Job]:
        target = self.get(job_id)
        return cross_platform_matches(target, self.list())

    def save_analysis(self, job_id: int, *, score: int, matching: str, missing: str, reason: str, recommendation: str, expected_hash: str | None = None) -> Job | None:
        with self._repository() as repository:
            return repository.save_match(
                job_id,
                score=score,
                matching_skills=matching,
                missing_skills=missing,
                reason=reason,
                recommendation=recommendation,
                expected_hash=expected_hash,
            )

    def set_applied(self, job_id: int, applied: bool) -> Job:
        with self._repository() as repository:
            return repository.set_applied(job_id, applied)

    def update_tracking(self, job_id: int, payload: dict) -> Job:
        with self._repository() as repository:
            update_tracking(repository.connection, job_id, payload)
            return repository.get(job_id)

    def set_followed_up(self, job_id: int, followed_up: bool) -> Job:
        with self._repository() as repository:
            return repository.set_followed_up(job_id, followed_up)

    def set_tailored_resume(self, job_id: int, path: str | None, *, expected_hash: str | None = None) -> Job:
        with self._repository() as repository:
            return repository.set_tailored_resume_path(job_id, path, expected_hash=expected_hash)

    def mark_analysis_error(self, job_id: int, message: str) -> None:
        """Make a local resume/PDF failure visible instead of leaving a job pending forever."""
        with self._repository() as repository:
            repository.mark_analysis_error(job_id, message)

    def delete(self, job_id: int) -> None:
        with self._repository() as repository:
            repository.delete(job_id)

    def clear(self) -> int:
        with self._repository() as repository:
            return repository.delete_all()

    def export(self) -> str | None:
        """Overwrite the one tracker file; an open Excel workbook never loses a capture."""
        with self._export_lock:
            try:
                export_database(self.settings.database_path, self.settings.export_path)
            except OSError as exc:
                message = str(exc)
                print(f"Excel tracker was not refreshed: {message}")
                return message
        return None

    def delete_outputs(self) -> int:
        """Remove generated output only; never remove the resume, profile, or browser session."""
        removed = 0
        if self.settings.export_path.is_file():
            self.settings.export_path.unlink()
            removed += 1
        if self.settings.tailored_resume_dir.is_dir():
            removed += sum(1 for path in self.settings.tailored_resume_dir.rglob("*") if path.is_file())
            shutil.rmtree(self.settings.tailored_resume_dir)
        return removed


class BackgroundProcessor:
    """Match and export after the page capture has already been acknowledged."""

    def __init__(self, store: JobStreetStore) -> None:
        self.store = store
        self._queue: queue.Queue[int | None] = queue.Queue()
        self._stopped = threading.Event()
        self._worker = threading.Thread(target=self._run, name="jobstreet-analysis", daemon=True)
        self._worker.start()

    def enqueue(self, job_id: int) -> None:
        self._queue.put(job_id)

    def enqueue_all(self) -> int:
        jobs = [job for job in self.store.list() if job.source == "jobstreet"]
        for job in jobs:
            self.enqueue(_job_id(job))
        return len(jobs)

    def close(self) -> None:
        self._stopped.set()
        self._queue.put(None)
        self._worker.join(timeout=3)

    def _run(self) -> None:
        while not self._stopped.is_set():
            job_id = self._queue.get()
            if job_id is None:
                return
            try:
                self._analyse(job_id)
            except Exception as exc:  # Keep subsequent jobs moving after one bad PDF or page capture.
                print(f"Analysis for job #{job_id} did not finish: {exc}")
                self.store.mark_analysis_error(job_id, str(exc))
                self.store.export()
            finally:
                self._queue.task_done()

    def _analyse(self, job_id: int) -> None:
        job = self.store.get(job_id)
        if job.source != "jobstreet":
            return
        if not job.job_description:
            return
        resume_path = configured_resume(self.store.settings)
        resume_text = read_resume(resume_path)
        result = match_resume_to_job(resume_text, job)
        saved = self.store.save_analysis(
            job_id,
            score=result.score,
            matching=", ".join(result.matching_skills),
            missing=", ".join(result.missing_skills),
            reason=result.reason,
            recommendation=result.recommendation,
            expected_hash=job.description_hash,
        )
        if saved is None:
            return  # A newer capture has already queued its own analysis.
        if result.score >= self.store.settings.tailored_resume_threshold:
            output = create_tailored_resume(resume_text, saved, result, self.store.settings.tailored_resume_dir)
            self.store.set_tailored_resume(job_id, output.name, expected_hash=job.description_hash)
            print(f"Job #{job_id}: {result.score}% match; tailored resume created: {output.name}")
        else:
            self.store.set_tailored_resume(job_id, None, expected_hash=job.description_hash)
            print(f"Job #{job_id}: {result.score}% match; review recommendation: {result.recommendation}.")
        self.store.export()


def payload_to_job(payload: dict[str, Any]) -> Job:
    """Validate captured or user-entered listing fields without accepting credentials."""
    if not isinstance(payload, dict):
        raise ValueError("The job must be an object.")
    title = _job_title(payload.get("title"))
    company = _text(payload.get("company"), "Company")
    url = canonicalize_job_url(_text(payload.get("url"), "Job URL"))
    parsed = urlsplit(url)
    if not is_jobstreet_hostname(parsed.hostname) or not re.fullmatch(r"/job/\d+", parsed.path):
        raise ValueError("Capture or enter a full JobStreet listing URL such as https://sg.jobstreet.com/job/12345678.")
    description = _optional_text(payload.get("job_description"))
    if not description:
        raise ValueError("Capture or enter the complete JobStreet job description before saving.")
    if len(description) > 250_000:
        raise ValueError("The job description is too large to store.")
    if any(marker in description.casefold() for marker in VERIFICATION_MARKERS):
        raise ValueError("The captured text appears to be a verification page rather than a job description.")
    skills = extract_skills(description)
    notes = "\n\n".join((
        f"Skills mentioned: {', '.join(skills) if skills else 'None recognized from the job description.'}",
        f"Job description: {description}",
    ))
    captured_at = datetime.now().astimezone().isoformat(timespec="seconds")
    return Job(
        title=title,
        company=company,
        url=url,
        company_url=_optional_http_url(payload.get("company_url"), "Company URL"),
        application_url=_optional_http_url(payload.get("application_url"), "Application URL"),
        application_method=_optional_text(payload.get("application_method")),
        platform="JobStreet",
        source="jobstreet",
        location=_optional_text(payload.get("location")),
        salary=_optional_text(payload.get("salary")),
        workplace_type=_optional_text(payload.get("workplace_type")),
        employment_type=_optional_text(payload.get("employment_type")),
        seniority_level=_optional_text(payload.get("seniority_level")),
        applicant_count=_optional_text(payload.get("applicant_count")),
        posting_date=_optional_text(payload.get("posting_date")),
        closing_date=_optional_text(payload.get("closing_date")),
        key_skills=", ".join(skills),
        source_job_id=url.rstrip("/").rsplit("/", 1)[-1],
        job_description=description,
        description_hash=hashlib.sha256(description.encode("utf-8")).hexdigest(),
        first_seen_at=captured_at,
        last_seen_at=captured_at,
        notes=notes,
    )


def _text(value: Any, label: str) -> str:
    cleaned = _optional_text(value)
    if not cleaned:
        raise ValueError(f"{label} is required.")
    return cleaned


def _job_title(value: Any) -> str:
    title = _text(value, "Job title")
    normalized = re.sub(r"[^a-z0-9]+", " ", title.casefold()).strip()
    if not any(character.isalnum() for character in title) or normalized in INVALID_JOB_TITLES:
        raise ValueError("Enter the actual JobStreet job title.")
    return title


def _optional_text(value: Any) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("Captured fields must be text.")
    cleaned = re.sub(r"\s+", " ", value).strip()
    return cleaned or None


def _optional_http_url(value: Any, label: str) -> str | None:
    cleaned = _optional_text(value)
    if not cleaned:
        return None
    parsed = urlsplit(cleaned)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError(f"{label} must be an HTTP or HTTPS address.")
    return cleaned


def _job_id(job: Job) -> int:
    if job.id is None:
        raise RuntimeError("The saved job does not have an identifier.")
    return job.id


def configured_resume(settings: Settings) -> Path:
    """Use the newest resume folder item, retaining the existing optional fallback."""
    try:
        return latest_resume(settings.resume_dir)
    except (FileNotFoundError, ValueError):
        if settings.resume_path and settings.resume_path.is_file():
            return settings.resume_path
        raise


def serialize_job(job: Job) -> dict[str, Any]:
    """Return only tracker information needed by the extension and dashboard."""
    data = asdict(job)
    if job.tailored_resume_path:
        data["tailored_resume_url"] = f"/api/jobs/{job.id}/resume"
    else:
        data["tailored_resume_url"] = None
    return data


def cross_platform_matches(target: Job, jobs: list[Job]) -> list[Job]:
    """Find likely copies of a role on another platform using stable local fields."""
    target_company = _identity_text(target.company, company=True)
    target_title = _identity_text(target.title)
    ranked: list[tuple[float, Job]] = []
    for candidate in jobs:
        if target.id is not None and candidate.id == target.id or candidate.source == target.source:
            continue
        company_score = SequenceMatcher(None, target_company, _identity_text(candidate.company, company=True)).ratio()
        title_score = SequenceMatcher(None, target_title, _identity_text(candidate.title)).ratio()
        if company_score >= 0.86 and title_score >= 0.74:
            ranked.append(((company_score * 0.45) + (title_score * 0.55), candidate))
    return [candidate for _, candidate in sorted(ranked, key=lambda item: item[0], reverse=True)[:5]]


def _identity_text(value: str, *, company: bool = False) -> str:
    normalized = re.sub(r"[^a-z0-9]+", " ", value.casefold()).strip()
    if company:
        noise = {"pte", "ltd", "limited", "private", "inc", "incorporated", "llc", "corp", "corporation"}
        normalized = " ".join(token for token in normalized.split() if token not in noise)
    return normalized


def _revision(jobs: list[Job]) -> str:
    values = [serialize_job(job) for job in jobs]
    raw = json.dumps(values, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


class CompanionHandler(BaseHTTPRequestHandler):
    """Minimal, origin-checked HTTP API used by the private extension and dashboard."""

    store: JobStreetStore
    processor: BackgroundProcessor

    def do_OPTIONS(self) -> None:  # noqa: N802 - standard library handler hook
        origin = self.headers.get("Origin", "")
        if not _is_extension_origin(origin) and not (self.path == "/api/autofill-profile" and allowed_extension(origin)):
            self._json(HTTPStatus.FORBIDDEN, {"ok": False, "error": "Only the installed Chrome extension may use this endpoint."})
            return
        self.send_response(HTTPStatus.NO_CONTENT)
        self._cors_headers(origin)
        self.send_header("Access-Control-Allow-Methods", "GET, POST")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Job-Assistant-Extension")
        self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802 - standard library handler hook
        origin = self.headers.get("Origin", "")
        if self.path == "/api/autofill-profile":
            if not allowed_extension_request(origin, self.headers.get("X-Job-Assistant-Extension", "")):
                self._json(HTTPStatus.FORBIDDEN, {"ok": False, "error": "Open the autofill profile inside your job-assistant extension."})
            else:
                try:
                    self._json(HTTPStatus.OK, {"ok": True, **get_profile()}, origin)
                except (OSError, ValueError, TypeError):
                    self._json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "The local autofill profile could not be read. Check or restore your private profile file."}, origin)
            return
        if self.path in {"/dashboard.css", "/dashboard.js"}:
            self._file(WORKSPACE / "shared_tracker" / self.path[1:], "text/css" if self.path.endswith(".css") else "application/javascript")
            return
        if self.path == "/exports/job_tracker.xlsx":
            warning = self.store.export()
            if warning:
                self._json(HTTPStatus.CONFLICT, {"ok": False, "error": warning})
            else:
                self._file(self.store.settings.export_path, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
            return
        resume_match = re.fullmatch(r"/api/jobs/(\d+)/resume", self.path)
        if resume_match:
            try:
                job = self.store.get(int(resume_match[1]))
                name = job.tailored_resume_path
                if not name or Path(name).name != name:
                    raise KeyError("No tailored resume is stored for this job.")
                self._file(self.store.settings.tailored_resume_dir / name, "application/pdf")
            except KeyError as exc:
                self._json(HTTPStatus.NOT_FOUND, {"ok": False, "error": str(exc)})
            return
        if self.path == "/":
            self._html(render_dashboard(self.store.list()))
            return
        if self.path == "/api/health":
            self._json(HTTPStatus.OK, {
                "ok": True,
                "service": "JobStreet Job Application Assistant",
                "database_path": str(self.store.settings.database_path),
                "shared_with_linkedin": self.store.settings.shared_with_linkedin,
                "shared_tracker": True,
            }, origin)
            return
        if self.path == "/api/jobs":
            jobs = self.store.list()
            self._json(HTTPStatus.OK, {"ok": True, "jobs": [serialize_job(job) for job in jobs], "revision": _revision(jobs)}, origin)
            return
        if self.path.startswith("/api/jobs/") and self.path.removeprefix("/api/jobs/").isdigit():
            try:
                job_id = int(self.path.rsplit("/", 1)[-1])
                self._json(HTTPStatus.OK, {
                    "ok": True,
                    "job": serialize_job(self.store.get(job_id)),
                    "related_jobs": [serialize_job(job) for job in self.store.related_to(job_id)],
                }, origin)
            except KeyError as exc:
                self._json(HTTPStatus.NOT_FOUND, {"ok": False, "error": str(exc)}, origin)
            return
        if self.path == "/api/profile":
            if not _is_extension_origin(origin):
                self._json(HTTPStatus.FORBIDDEN, {"ok": False, "error": "Only the installed Chrome extension may read the safe local profile."})
                return
            try:
                profile = load_profile(self.store.settings.profile_path)
            except FileNotFoundError:
                profile = {}
            self._json(HTTPStatus.OK, {"ok": True, "profile": profile}, origin)
            return
        if self.path.startswith("/tailored/"):
            self._tailored_resume(self.path.removeprefix("/tailored/"))
            return
        self._json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "Unknown endpoint."}, origin)

    def do_POST(self) -> None:  # noqa: N802 - standard library handler hook
        origin = self.headers.get("Origin", "")
        if self.path == "/api/autofill-profile":
            if not allowed_extension_request(origin, self.headers.get("X-Job-Assistant-Extension", "")):
                self._json(HTTPStatus.FORBIDDEN, {"ok": False, "error": "Only your job-assistant extensions may edit the profile."})
                return
            try:
                self._json(HTTPStatus.OK, {"ok": True, **save_profile(self._payload())}, origin)
            except (ValueError, TypeError) as exc:
                self._json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)}, origin)
            return
        if not _is_extension_origin(origin) and not _is_dashboard_origin(origin):
            self._json(HTTPStatus.FORBIDDEN, {"ok": False, "error": "This local service only accepts requests from its extension or dashboard."})
            return
        try:
            payload = self._payload()
            if self.path == "/api/jobs":
                if not _is_extension_origin(origin):
                    raise PermissionError("Only the Chrome extension may save a job.")
                saved = self.store.upsert_capture(payload)
                warning = self.store.export()
                self.processor.enqueue(_job_id(saved))
                response: dict[str, Any] = {
                    "ok": True,
                    "job": serialize_job(saved),
                    "related_jobs": [serialize_job(job) for job in self.store.related_to(_job_id(saved))],
                    "analysis_queued": True,
                }
                if warning:
                    response["excel_warning"] = warning
                self._json(HTTPStatus.OK, response, origin)
                return
            if self.path == "/api/jobs/rematch":
                if not _is_extension_origin(origin) and not _is_dashboard_origin(origin):
                    raise PermissionError("Only the Chrome extension or local dashboard may request resume matching.")
                count = self.processor.enqueue_all()
                unavailable = []
                for port, platform in ((8765, "Careers@Gov"), (8766, "LinkedIn")):
                    try:
                        request = Request(f"http://127.0.0.1:{port}/api/jobs/rematch", data=b"{}",
                                          headers={"Origin": "http://127.0.0.1:8767", "Content-Type": "application/json"})
                        with urlopen(request, timeout=3) as response:
                            count += json.load(response).get("queued", 0)
                    except (OSError, ValueError):
                        unavailable.append(platform)
                self._json(HTTPStatus.OK, {"ok": True, "queued": count, "unavailable": unavailable}, origin)
                return
            tracking_match = re.fullmatch(r"/api/jobs/(\d+)/tracking", self.path)
            if tracking_match:
                if not _is_dashboard_origin(origin):
                    raise PermissionError("Use the local dashboard to update tracking.")
                saved = self.store.update_tracking(int(tracking_match[1]), payload)
                warning = self.store.export()
                self._json(HTTPStatus.OK, {"ok": True, "job": serialize_job(saved), "excel_warning": warning}, origin)
                return
            if self.path == "/api/jobs/clear":
                raise PermissionError("Bulk deletion is disabled because this database may contain LinkedIn jobs.")
            application_match = re.fullmatch(r"/api/jobs/(\d+)/application", self.path)
            if application_match:
                if not _is_dashboard_origin(origin):
                    raise PermissionError("Application status can only be changed from the local dashboard.")
                applied = payload.get("applied")
                if not isinstance(applied, bool):
                    raise ValueError("Applied must be true or false.")
                saved = self.store.set_applied(int(application_match.group(1)), applied)
                warning = self.store.export()
                response = {"ok": True, "job": serialize_job(saved)}
                if warning:
                    response["excel_warning"] = warning
                self._json(HTTPStatus.OK, response, origin)
                return
            follow_up_match = re.fullmatch(r"/api/jobs/(\d+)/follow-up", self.path)
            if follow_up_match:
                if not _is_dashboard_origin(origin):
                    raise PermissionError("Follow-up status can only be changed from the local dashboard.")
                followed_up = payload.get("followed_up")
                if not isinstance(followed_up, bool):
                    raise ValueError("Followed up must be true or false.")
                saved = self.store.set_followed_up(int(follow_up_match.group(1)), followed_up)
                warning = self.store.export()
                response = {"ok": True, "job": serialize_job(saved)}
                if warning:
                    response["excel_warning"] = warning
                self._json(HTTPStatus.OK, response, origin)
                return
            match = re.fullmatch(r"/api/jobs/(\d+)/(drafts|cover-letter)", self.path)
            if match and _is_extension_origin(origin):
                job = self.store.get(int(match.group(1)))
                resume = read_resume(configured_resume(self.store.settings))
                if match.group(2) == "cover-letter":
                    letter = generate_cover_letter(resume, job)
                    path = save_cover_letter(int(job.id), job.title, job.company, letter)
                    self._json(HTTPStatus.OK, {"ok": True, "cover_letter": letter, "file_path": str(path)}, origin)
                else:
                    questions = payload.get("questions", [])
                    if not isinstance(questions, list) or not all(isinstance(item, str) for item in questions):
                        raise ValueError("Questions must be a list of visible text prompts.")
                    result = match_resume_to_job(resume, job) if job.job_description else None
                    drafts = generate_draft_answers(questions[:20], job, result)
                    self._json(HTTPStatus.OK, {"ok": True, "drafts": [asdict(draft) for draft in drafts]}, origin)
                return
            self._json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "Unknown endpoint."}, origin)
        except PermissionError as exc:
            self._json(HTTPStatus.FORBIDDEN, {"ok": False, "error": str(exc)}, origin)
        except (KeyError, FileNotFoundError, ValueError, json.JSONDecodeError) as exc:
            self._json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)}, origin)
        except Exception as exc:
            self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": str(exc)}, origin)

    def do_DELETE(self) -> None:  # noqa: N802 - standard library handler hook
        origin = self.headers.get("Origin", "")
        identifier = self.path.removeprefix("/api/jobs/")
        if not _is_dashboard_origin(origin) or not self.path.startswith("/api/jobs/") or not identifier.isdigit():
            self._json(HTTPStatus.FORBIDDEN, {"ok": False, "error": "Jobs can only be deleted from the local dashboard."})
            return
        try:
            self.store.delete(int(identifier))
            warning = self.store.export()
            response: dict[str, Any] = {"ok": True, "deleted_id": int(identifier)}
            if warning:
                response["excel_warning"] = warning
            self._json(HTTPStatus.OK, response)
        except KeyError as exc:
            self._json(HTTPStatus.NOT_FOUND, {"ok": False, "error": str(exc)})
        except Exception as exc:
            self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": str(exc)})

    def _payload(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length < 0 or length > MAX_REQUEST_BYTES:
            raise ValueError("The request has an invalid size.")
        if not length:
            return {}
        value = json.loads(self.rfile.read(length).decode("utf-8"))
        if not isinstance(value, dict):
            raise ValueError("The request body must be a JSON object.")
        return value

    def _json(self, status: HTTPStatus, payload: dict[str, Any], origin: str = "") -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if _is_extension_origin(origin) or (self.path == "/api/autofill-profile" and allowed_extension(origin)):
            self._cors_headers(origin)
        self.end_headers()
        self.wfile.write(body)

    def _html(self, document: str) -> None:
        body = document.encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _tailored_resume(self, encoded_name: str) -> None:
        name = unquote(encoded_name)
        if not name or Path(name).name != name or not name.casefold().endswith(".pdf"):
            self.send_error(HTTPStatus.BAD_REQUEST)
            return
        path = self.store.settings.tailored_resume_dir / name
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

    def _file(self, path: Path, content_type: str) -> None:
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

    def _cors_headers(self, origin: str) -> None:
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Vary", "Origin")

    def log_message(self, format: str, *args: object) -> None:
        timestamp = datetime.now().astimezone().strftime("%H:%M:%S")
        print(f"[{timestamp}] {self.address_string()} - {format % args}")


def _is_extension_origin(origin: str) -> bool:
    return origin == CHROME_EXTENSION_ORIGIN


def _is_dashboard_origin(origin: str) -> bool:
    return origin in {f"http://{HOST}:{PORT}", "http://127.0.0.1:8767"}


def render_dashboard(jobs: list[Job]) -> str:
    """Render the compact live tracker; detailed capture fields remain in SQLite."""
    return render_shared_dashboard([asdict(job) for job in jobs], _revision(jobs))


def run() -> None:
    """Start the local-only companion before refresh work so its dashboard is ready immediately."""
    settings = get_settings()
    store = JobStreetStore(settings)
    processor = BackgroundProcessor(store)
    CompanionHandler.store = store
    CompanionHandler.processor = processor
    server = ThreadingHTTPServer((HOST, PORT), CompanionHandler)
    server_thread = threading.Thread(target=server.serve_forever, name="jobstreet-dashboard", daemon=True)
    server_thread.start()
    print("JobStreet Chrome companion is running locally.")
    if settings.shared_with_linkedin:
        print(f"Using shared LinkedIn database: {settings.database_path}")
    else:
        print(f"Using local JobStreet database: {settings.database_path}")
    print(f"Dashboard: http://{HOST}:{PORT}/")
    try:
        # The dashboard is already available while this one-time startup refresh
        # exports existing rows and queues resume matching.
        store.export()
        queued = processor.enqueue_all()
        print(f"Queued {queued} saved job(s) for resume refresh. Leave this window open while using the extension.")
        while server_thread.is_alive():
            server_thread.join(timeout=0.5)
    except KeyboardInterrupt:
        print("\nStopping JobStreet Chrome companion.")
    finally:
        server.shutdown()
        server_thread.join(timeout=3)
        server.server_close()
        processor.close()


if __name__ == "__main__":
    run()
