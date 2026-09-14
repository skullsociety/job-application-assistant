"""Transparent local skill extraction and resume-to-job comparison."""

from __future__ import annotations

import re
from dataclasses import dataclass


SKILL_ALIASES: dict[str, tuple[str, ...]] = {
    "product management": ("product management", "product manager"),
    "product strategy": ("product strategy", "product vision"),
    "product discovery": ("product discovery", "problem discovery"),
    "product roadmap": ("product roadmap", "roadmap"),
    "product analytics": ("product analytics", "product metrics"),
    "market research": ("market research",),
    "user research": ("user research", "user interviews", "contextual enquiries"),
    "usability testing": ("usability testing", "usability test"),
    "requirements gathering": ("requirements gathering", "gather requirements", "business requirements", "actionable requirements"),
    "user stories": ("user stories", "user story"),
    "acceptance criteria": ("acceptance criteria",),
    "stakeholder management": ("stakeholder management", "manage stakeholders", "stakeholder engagement"),
    "workshop facilitation": ("facilitate", "facilitation", "workshops", "co-creation workshop"),
    "cross-functional leadership": ("cross-functional", "cross functional", "multi-disciplinary team"),
    "agile": ("agile", "sprint ceremonies", "sprint planning", "retrospectives"),
    "scrum": ("scrum", "scrum master"),
    "backlog management": ("product backlog", "backlog management", "prioritise the backlog", "prioritize the backlog"),
    "product launches": ("product launch", "product launches", "launch strategy", "adoption strategy"),
    "software development lifecycle": ("sdlc", "software development lifecycle"),
    "ci/cd": ("ci/cd", "continuous integration", "continuous delivery", "continuous deployment"),
    "cloud infrastructure": ("cloud infrastructure", "cloud platform", "cloud services"),
    "technical architecture": ("technical architecture", "architecture and feasibility", "solution architecture"),
    "rest api": ("rest api", "rest apis", "restful api"),
    "identity and authentication": ("identity/authentication", "identity and authentication", "identity management", "authentication concepts"),
    "devops": ("devops",),
    "cybersecurity": ("cybersecurity", "information security", "security engineering"),
    "automation": ("automation", "automated workflows", "process automation"),
    "software testing": ("software testing", "testing tools", "quality assurance", "test automation"),
    "uat": ("uat", "user acceptance testing"),
    "jira": ("jira",),
    "confluence": ("confluence",),
    "figma": ("figma",),
    "python": ("python",),
    "sql": ("sql",),
    "javascript": ("javascript",),
    "typescript": ("typescript",),
    "html": ("html",),
    "css": ("css",),
    "react": ("react",),
    "node.js": ("node.js", "nodejs"),
    "java": ("java",),
    "c#": ("c#",),
    "c++": ("c++",),
    "api development": ("api development", "api integration", "apis"),
    "aws": ("aws", "amazon web services"),
    "azure": ("azure",),
    "gcp": ("gcp", "google cloud platform"),
    "docker": ("docker",),
    "kubernetes": ("kubernetes",),
    "git": ("git",),
    "github": ("github",),
    "linux": ("linux",),
    "powershell": ("powershell",),
    "bash": ("bash",),
    "excel": ("excel",),
    "power bi": ("power bi", "powerbi"),
    "tableau": ("tableau",),
    "data analysis": ("data analysis", "data analytics", "data-driven decision", "data driven decision"),
    "data engineering": ("data engineering", "data pipeline", "data pipelines", "data ingestion", "data transformation"),
    "data modelling": ("data modelling", "data modeling"),
    "data quality": ("data quality", "data validation"),
    "data warehousing": ("data warehouse", "data warehousing"),
    "machine learning": ("machine learning", "deep learning", "scikit-learn", "tensorflow", "xgboost"),
    "artificial intelligence": ("artificial intelligence", "generative ai", "large language model", "llm"),
    "statistics": ("statistics", "statistical analysis"),
    "pandas": ("pandas",),
    "numpy": ("numpy",),
    "web scraping": ("web scraping", "web scraper"),
    "selenium": ("selenium",),
    "beautifulsoup": ("beautifulsoup", "beautiful soup"),
    "sap": ("sap",),
    "salesforce": ("salesforce",),
    "accounting": ("accounting",),
    "financial modelling": ("financial modelling", "financial modeling"),
    "budgeting": ("budgeting", "budget management"),
    "project management": ("project management", "project manager"),
    "programme management": ("programme management", "program management", "programme manager", "program manager"),
    "change management": ("change management",),
    "process improvement": ("process improvement", "process redesign", "process re-engineering", "process reengineering"),
    "business analysis": ("business analysis", "business analyst"),
    "communication": ("communication skills", "communicate", "written and verbal communication"),
    "analytical thinking": ("analytical skills", "analytical thinking", "strong analytical", "problem solving"),
}


@dataclass(frozen=True, slots=True)
class MatchResult:
    score: int | None
    job_skills: list[str]
    matching_skills: list[str]
    missing_skills: list[str]
    reason: str
    recommendation: str


def extract_skills(text: str) -> list[str]:
    """Return canonical skills explicitly recognized in the supplied text."""
    normalized = re.sub(r"\s+", " ", text.casefold()).strip()
    return [
        skill
        for skill, aliases in SKILL_ALIASES.items()
        if any(re.search(rf"(?<!\w){re.escape(alias)}(?!\w)", normalized) for alias in aliases)
    ]


def match_resume(resume_text: str, title: str, description: str) -> MatchResult:
    """Calculate transparent skill coverage; this is not a hiring prediction."""
    job_skills = extract_skills(f"{title}\n{description}")
    resume_skills = set(extract_skills(resume_text))
    matching = [skill for skill in job_skills if skill in resume_skills]
    missing = [skill for skill in job_skills if skill not in resume_skills]
    if len(job_skills) < 3:
        return MatchResult(
            score=None,
            job_skills=job_skills,
            matching_skills=matching,
            missing_skills=missing,
            reason="Too few recognized skills were found for a reliable automatic comparison.",
            recommendation="review manually",
        )
    score = round(len(matching) / len(job_skills) * 100)
    recommendation = "high compatibility" if score >= 70 else "low compatibility" if score < 35 else "review manually"
    return MatchResult(
        score=score,
        job_skills=job_skills,
        matching_skills=matching,
        missing_skills=missing,
        reason=f"The resume contains {len(matching)} of {len(job_skills)} recognized job skills.",
        recommendation=recommendation,
    )

