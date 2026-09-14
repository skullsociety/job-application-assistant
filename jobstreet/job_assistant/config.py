"""Application configuration with safe local-file and environment overrides."""

from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent


@dataclass(frozen=True, slots=True)
class Settings:
    """Resolved local paths and visible-browser settings for the application."""

    database_path: Path
    export_path: Path
    log_path: Path
    browser_user_data_dir: Path
    browser_channel: str | None
    profile_path: Path
    tailored_resume_dir: Path
    tailored_resume_threshold: int
    resume_dir: Path
    resume_path: Path | None
    shared_with_linkedin: bool = False
    linkedin_project_dir: Path | None = None


def get_settings(config_path: Path | None = None) -> Settings:
    """Load defaults, then optional TOML settings, then local environment overrides."""
    runtime_root = _runtime_root()
    _load_dotenv(runtime_root / ".env")
    configured_path = os.getenv("JOB_ASSISTANT_CONFIG", "").strip()
    selected_config = config_path or (
        _resolve_path(configured_path, runtime_root) if configured_path else runtime_root / "config.toml"
    )
    file_values = _read_config(selected_config)
    data_dir = _resolve_path(_value("data_dir", file_values, "data"), runtime_root)
    linkedin_project_dir = _linkedin_project_dir(file_values, runtime_root)
    share_with_linkedin = _boolean(_value("share_linkedin_tracker", file_values, "true"))
    linkedin_database = linkedin_project_dir / "data" / "jobs.sqlite3" if linkedin_project_dir else None
    use_linkedin_tracker = bool(share_with_linkedin and linkedin_database)
    default_database = linkedin_database if use_linkedin_tracker else data_dir / "jobs.sqlite3"
    default_export = linkedin_project_dir / "exports" / "job_tracker.xlsx" if use_linkedin_tracker else runtime_root / "exports" / "job_tracker.xlsx"
    default_resume_dir = linkedin_project_dir / "resumes" if use_linkedin_tracker else runtime_root / "resumes"
    default_tailored_dir = linkedin_project_dir / "exports" / "tailored_resumes" if use_linkedin_tracker else runtime_root / "exports" / "tailored_resumes"
    browser = _value("browser", file_values, "chrome")
    browser_channel = None if browser.casefold() == "chromium" else browser
    return Settings(
        database_path=_resolve_path(_value("database_path", file_values, str(default_database)), runtime_root),
        export_path=_resolve_path(_value("export_path", file_values, str(default_export)), runtime_root),
        log_path=_resolve_path(_value("log_path", file_values, "logs/job_assistant.log"), runtime_root),
        browser_user_data_dir=_resolve_path(_value("browser_user_data_dir", file_values, str(data_dir / "browser-profile")), runtime_root),
        browser_channel=browser_channel,
        profile_path=_resolve_path(_value("profile_path", file_values, str(data_dir / "profile.json")), runtime_root),
        tailored_resume_dir=_resolve_path(_value("tailored_resume_dir", file_values, str(default_tailored_dir)), runtime_root),
        tailored_resume_threshold=_score_threshold(_value("tailored_resume_threshold", file_values, "70")),
        resume_dir=_resolve_path(_value("resume_dir", file_values, str(default_resume_dir)), runtime_root),
        resume_path=_optional_path(_value("resume_path", file_values, ""), runtime_root),
        shared_with_linkedin=use_linkedin_tracker,
        linkedin_project_dir=linkedin_project_dir,
    )


def _read_config(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        with path.open("rb") as config_file:
            values = tomllib.load(config_file)
    except tomllib.TOMLDecodeError as exc:
        raise ValueError(f"Invalid TOML configuration: {path}") from exc
    return values if isinstance(values, dict) else {}


def _load_dotenv(path: Path) -> None:
    """Load simple KEY=VALUE overrides without requiring a runtime dependency."""
    if not path.is_file():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key and key not in os.environ:
            os.environ[key] = value.strip().strip("\"'")


def _value(name: str, file_values: dict[str, Any], default: str) -> str:
    environment_names = {
        "browser_user_data_dir": ("JOB_ASSISTANT_USER_DATA_DIR", "JOB_ASSISTANT_BROWSER_USER_DATA_DIR"),
        "browser": ("JOB_ASSISTANT_BROWSER",),
        "linkedin_project_dir": ("JOBSTREET_LINKEDIN_PROJECT_DIR",),
        "share_linkedin_tracker": ("JOBSTREET_SHARE_LINKEDIN_TRACKER",),
    }
    for environment_name in environment_names.get(name, (f"JOB_ASSISTANT_{name.upper()}",)):
        value = os.getenv(environment_name)
        if value is not None:
            return value.strip() or default
    value = file_values.get(name, default)
    return str(value).strip() or default


def _runtime_root() -> Path:
    configured = os.getenv("JOB_ASSISTANT_HOME", "").strip()
    return Path(configured).expanduser().resolve() if configured else ROOT


def _resolve_path(value: str, root: Path) -> Path:
    path = Path(value).expanduser()
    return path if path.is_absolute() else root / path


def _optional_path(value: str, root: Path) -> Path | None:
    return _resolve_path(value, root) if value.strip() else None


def _linkedin_project_dir(file_values: dict[str, Any], runtime_root: Path) -> Path | None:
    configured = _value("linkedin_project_dir", file_values, "").strip()
    if configured:
        candidate = _resolve_path(configured, runtime_root).resolve()
        return candidate if candidate.is_dir() else None
    sibling = runtime_root.parent / "linkedin"
    return sibling if sibling.is_dir() else None


def _boolean(value: str) -> bool:
    normalized = value.strip().casefold()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ValueError("share_linkedin_tracker must be true or false.")


def _score_threshold(value: str) -> int:
    try:
        threshold = int(value)
    except ValueError as exc:
        raise ValueError("tailored_resume_threshold must be a whole number from 0 to 100.") from exc
    if not 0 <= threshold <= 100:
        raise ValueError("tailored_resume_threshold must be from 0 to 100.")
    return threshold
