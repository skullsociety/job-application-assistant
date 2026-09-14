from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from companion.server import JobStore, _is_dashboard_origin, _jobs_revision, _should_create_tailored_resume, canonicalize_careers_gov_url, render_dashboard, validate_job
from companion.matching import extract_skills, match_resume
from companion.resume_tools import create_tailored_resume


SAMPLE_JOB = {
    "url": "https://jobs.careers.gov.sg/jobs/hrp/17856331/example?utm_source=test#details",
    "title": "Business Analyst",
    "company": "Ministry of Manpower",
    "employment_type": "Permanent/Contract",
    "closing_date": "Closing on 31 Jul 2026",
    "description": "What the role is\nBuild useful public services.",
}


class CompanionTests(unittest.TestCase):
    def test_govtech_uses_strict_above_fifty_tailored_resume_rule(self) -> None:
        self.assertTrue(_should_create_tailored_resume(51, "Government Technology Agency", 70))
        self.assertTrue(_should_create_tailored_resume(64, "GovTech Singapore", 70))
        self.assertFalse(_should_create_tailored_resume(50, "Government Technology Agency", 70))
        self.assertFalse(_should_create_tailored_resume(69, "Another Agency", 70))
        self.assertTrue(_should_create_tailored_resume(70, "Another Agency", 70))

    def test_canonicalizes_careers_gov_url(self) -> None:
        self.assertEqual(
            canonicalize_careers_gov_url(SAMPLE_JOB["url"]),
            "https://jobs.careers.gov.sg/jobs/hrp/17856331/example",
        )

    def test_rejects_another_domain(self) -> None:
        with self.assertRaises(ValueError):
            validate_job({**SAMPLE_JOB, "url": "https://example.com/jobs/1"})

    def test_upsert_updates_one_stable_job(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = JobStore(root / "jobs.sqlite3", root / "resumes", root / "tailored")
            first = store.upsert(SAMPLE_JOB)
            second = store.upsert({**SAMPLE_JOB, "title": "Senior Business Analyst"})
            self.assertEqual(first["id"], second["id"])
            self.assertIn("business analysis", first["key_skills"])
            self.assertEqual(store.list_jobs()[0]["title"], "Senior Business Analyst")

    def test_fast_upsert_queues_analysis_without_scoring_inline(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = JobStore(root / "jobs.sqlite3", root / "resumes", root / "tailored")
            saved = store.upsert(SAMPLE_JOB, analyze=False)
            self.assertIsNone(saved["match_score"])
            self.assertEqual(saved["recommendation"], "analysis pending")
            self.assertIn("business analysis", saved["key_skills"])

    def test_delete_removes_only_the_selected_job(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = JobStore(root / "jobs.sqlite3", root / "resumes", root / "tailored")
            first = store.upsert(SAMPLE_JOB, analyze=False)
            second = store.upsert(
                {**SAMPLE_JOB, "url": "https://jobs.careers.gov.sg/jobs/hrp/17856332/example"},
                analyze=False,
            )
            store.delete(first["id"])
            self.assertEqual([job["id"] for job in store.list_jobs()], [second["id"]])
            with self.assertRaises(KeyError):
                store.delete(first["id"])

    def test_extracts_greenhouse_product_skills(self) -> None:
        description = (
            "Define product strategy and roadmap. Lead user research and usability testing. "
            "Manage the product backlog in an agile environment using JIRA and Confluence. "
            "Work with SDLC, CI/CD, cloud infrastructure, REST APIs, DevOps, security, and automation."
        )
        skills = extract_skills(description)
        self.assertIn("product strategy", skills)
        self.assertIn("user research", skills)
        self.assertIn("backlog management", skills)
        self.assertIn("ci/cd", skills)
        self.assertIn("rest api", skills)
        self.assertIn("jira", skills)

    def test_match_reports_transparent_skill_coverage(self) -> None:
        result = match_resume(
            "Product manager experienced in product strategy, agile delivery, JIRA, and user research.",
            "Product Manager",
            "Product strategy, agile delivery, JIRA, user research, cloud infrastructure, and REST APIs.",
        )
        self.assertIsNotNone(result.score)
        self.assertIn("product management", result.matching_skills)
        self.assertIn("cloud infrastructure", result.missing_skills)

    def test_high_match_can_create_a_tailored_pdf(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            result = match_resume(
                "Product manager with product strategy, agile, JIRA, and user research experience.",
                "Product Manager",
                "Product strategy, agile, JIRA, and user research.",
            )
            self.assertIsNotNone(result.score)
            output = create_tailored_resume(
                "Test Candidate | test@example.com\n\nProfessional Summary\nProduct manager with product strategy and agile experience.\n\nCore Skills\nJIRA, user research",
                1,
                "Test Agency",
                "Product Manager",
                result,
                Path(directory),
            )
            self.assertTrue(output.is_file())
            self.assertTrue(output.name.startswith("1_tailored_resume_"))
            self.assertGreater(output.stat().st_size, 1000)

    def test_dashboard_revision_changes_with_job_data(self) -> None:
        first = _jobs_revision([{"id": 1, "title": "Analyst"}])
        second = _jobs_revision([{"id": 1, "title": "Senior Analyst"}])
        self.assertNotEqual(first, second)

    def test_dashboard_has_persistent_sort_controls(self) -> None:
        document = render_dashboard([])
        self.assertEqual(document.count('class="sort-button"'), 7)
        script = Path(__file__).with_name("dashboard.js").read_text(encoding="utf-8")
        self.assertIn("careersgov-dashboard-sort", script)
        self.assertIn('aria-sort="none"', document)

    def test_dashboard_has_confirmed_delete_action(self) -> None:
        document = render_dashboard(
            [
                {
                    "id": 7,
                    "url": "https://jobs.careers.gov.sg/jobs/hrp/7/example",
                    "title": "Data Analyst",
                    "company": "Example Agency",
                    "updated_at": "2026-07-22T10:00:00+08:00",
                }
            ]
        )
        self.assertIn('class="delete-job" data-job-id="7"', document)
        script = Path(__file__).with_name("dashboard.js").read_text(encoding="utf-8")
        self.assertIn("window.confirm", script)
        self.assertIn('method: "DELETE"', script)
        self.assertTrue(_is_dashboard_origin("http://127.0.0.1:8765"))
        self.assertFalse(_is_dashboard_origin("https://example.com"))


if __name__ == "__main__":
    unittest.main()
