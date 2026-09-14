from __future__ import annotations

import re
from dataclasses import dataclass

from .models import Job
from .resume_matcher import MatchResult


SENSITIVE_QUESTION_MARKERS = ("gender", "race", "ethnicity", "disability", "veteran", "date of birth", "age", "religion", "sexual orientation", "nationality")


@dataclass(frozen=True)
class DraftAnswer:
    question: str
    answer: str


def generate_draft_answers(questions: list[str], job: Job, result: MatchResult | None) -> list[DraftAnswer]:
    drafts: list[DraftAnswer] = []
    skills = ", ".join(result.matching_skills[:5]) if result and result.matching_skills else "relevant experience"
    for question in questions:
        lowered = question.casefold()
        if any(marker in lowered for marker in SENSITIVE_QUESTION_MARKERS):
            answer = "Manual answer required: this personal question should be answered directly by you."
        elif "why" in lowered and any(word in lowered for word in ("interest", "company", "role", "apply")):
            answer = f"I am interested in the {job.title} role at {job.company} because it aligns with my experience in {skills}. I would welcome the opportunity to contribute those strengths to the team."
        elif any(word in lowered for word in ("experience", "qualified", "background", "skill")):
            answer = f"My background includes {skills}, which align with the requirements highlighted for this {job.title} role. I would be glad to discuss relevant examples from my experience."
        else:
            answer = "Draft unavailable. Please answer this question in your own words after reviewing the prompt."
        drafts.append(DraftAnswer(question, answer))
    return drafts


def _clean(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()
