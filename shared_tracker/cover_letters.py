"""Evidence-bound cover-letter drafts and private text-file output."""

from __future__ import annotations

import re
from pathlib import Path

from .schema import LOCAL_DATA


COVER_LETTER_DIR = LOCAL_DATA / "exports" / "cover_letters"


def generate_cover_letter(title: str, company: str, description: str, matching_skills: list[str]) -> str:
    """Mention only job skills also found in the current resume."""
    if not description or not description.strip():
        raise ValueError("Capture the job description before generating a cover letter.")
    skills = list(dict.fromkeys(skill.strip() for skill in matching_skills if skill.strip()))[:6]
    if skills:
        skill_list = _join_skills([_display_skill(skill) for skill in skills])
        evidence = (
            f"The description highlights skills that overlap with my resume, including {skill_list}. "
            "I would welcome the opportunity to discuss how I have applied these skills and how they could support this role."
        )
    else:
        evidence = (
            "I have reviewed the responsibilities in the job description. "
            "I would welcome the opportunity to discuss which parts of my resume are most relevant to this role."
        )
    return "\n\n".join([
        "Dear Hiring Team,",
        f"I am writing to apply for the {title.strip()} position at {company.strip()}.",
        evidence,
        f"I am interested in contributing to {company.strip()} and would appreciate the opportunity to discuss my application.",
        "Thank you for your consideration.",
        "Sincerely,",
    ]) + "\n"


def save_cover_letter(job_id: int, title: str, company: str, letter: str,
                      output_dir: Path = COVER_LETTER_DIR) -> Path:
    """Keep generated personal drafts out of the Git-tracked source tree."""
    if job_id < 1:
        raise ValueError("A saved job ID is required.")
    output_dir.mkdir(parents=True, exist_ok=True)
    name = f"{job_id}_{_slug(company)}_{_slug(title)}_cover_letter.txt"
    path = output_dir / name
    path.write_text(letter, encoding="utf-8")
    return path


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", value.casefold()).strip("_")[:55] or "job"


def _join_skills(skills: list[str]) -> str:
    if len(skills) == 1:
        return skills[0]
    if len(skills) == 2:
        return f"{skills[0]} and {skills[1]}"
    return f"{', '.join(skills[:-1])}, and {skills[-1]}"


def _display_skill(skill: str) -> str:
    return skill.upper() if skill.casefold() in {"sql", "aws", "gcp", "api", "etl", "seo", "sap", "jira"} else skill.title()
