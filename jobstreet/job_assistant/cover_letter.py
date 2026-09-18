from __future__ import annotations

from shared_tracker.cover_letters import generate_cover_letter as render_cover_letter

from .models import Job
from .resume_matcher import match_resume_to_job


def generate_cover_letter(resume_text: str, job: Job) -> str:
    """Create a concise, evidence-bound cover letter from local resume and job text."""
    result = match_resume_to_job(resume_text, job)
    return render_cover_letter(job.title, job.company, job.job_description or "", result.matching_skills)
