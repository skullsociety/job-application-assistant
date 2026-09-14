"""Small command entry point and reusable local resume-matching workflow."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

from .config import Settings
from .database import JobRepository
from .exporter import export_jobs
from .models import Job
from .resume_matcher import match_resume_to_job
from .resume_reader import read_resume
from .tailored_resume import create_tailored_resume


def match_resume(
    repository: JobRepository,
    resume_path: Path,
    job_id: int | None,
    settings: Settings,
    *,
    reporter: Callable[[str], None] = print,
) -> None:
    """Score one or all saved job descriptions and refresh the unified tracker."""
    resume_text = read_resume(resume_path)
    jobs = [_required_job(repository, job_id)] if job_id else repository.list()
    matched_count = 0
    for job in jobs:
        if job.source == "careersgov":
            reporter(f"#{job.id}: use the shared dashboard to run Careers@Gov matching with its own resume rules")
            continue
        if not job.job_description:
            reporter(f"#{job.id}: skipped - no saved job description")
            continue
        result = match_resume_to_job(resume_text, job)
        repository.save_match(
            _job_id(job),
            score=result.score,
            matching_skills=", ".join(result.matching_skills),
            missing_skills=", ".join(result.missing_skills),
            reason=result.reason,
            recommendation=result.recommendation,
        )
        if result.score >= settings.tailored_resume_threshold:
            output = create_tailored_resume(resume_text, job, result, settings.tailored_resume_dir)
            repository.set_tailored_resume_path(_job_id(job), output.name)
        else:
            repository.set_tailored_resume_path(_job_id(job), None)
        matched_count += 1
    export_jobs(repository.list(), settings.export_path)
    reporter(f"Matched {matched_count} job(s).")


def _required_job(repository: JobRepository, job_id: int | None) -> Job:
    if job_id is None:
        raise ValueError("A job ID is required.")
    job = repository.get(job_id)
    if not job:
        raise KeyError(f"No saved job found with id {job_id}.")
    return job


def _job_id(job: Job) -> int:
    if job.id is None:
        raise RuntimeError("The saved job does not have an identifier.")
    return job.id


if __name__ == "__main__":
    from companion.server import run

    run()
