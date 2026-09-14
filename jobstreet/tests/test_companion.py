import tempfile
import unittest
from pathlib import Path

from companion.server import (
    CHROME_EXTENSION_ORIGIN,
    JobStreetStore,
    _is_extension_origin,
    cross_platform_matches,
    payload_to_job,
    render_dashboard,
    serialize_job,
)
from job_assistant.config import Settings
from job_assistant.database import JobRepository
from job_assistant.models import Job


class JobStreetCompanionTests(unittest.TestCase):
    def _settings(self, root: Path) -> Settings:
        return Settings(
            database_path=root / "data" / "jobs.sqlite3",
            export_path=root / "exports" / "job_tracker.xlsx",
            log_path=root / "logs" / "assistant.log",
            browser_user_data_dir=root / "data" / "browser-profile",
            browser_channel="chrome",
            profile_path=root / "data" / "profile.json",
            tailored_resume_dir=root / "exports" / "tailored_resumes",
            tailored_resume_threshold=70,
            resume_dir=root / "resumes",
            resume_path=None,
        )

    def _payload(self, url: str, description: str = "Build Python, SQL, and ETL data pipelines.") -> dict[str, str]:
        return {
            "title": "Data Engineer",
            "company": "Example Pte Ltd",
            "url": url,
            "location": "Singapore",
            "workplace_type": "Hybrid",
            "employment_type": "Full-time",
            "posting_date": "31 Aug 2026",
            "job_description": description,
        }

    def test_payload_uses_stable_jobstreet_url_and_shared_schema_fields(self) -> None:
        job = payload_to_job(self._payload("https://sg.jobstreet.com/job/12345?type=standard&ref=search"))
        self.assertEqual(job.url, "https://sg.jobstreet.com/job/12345")
        self.assertEqual(job.platform, "JobStreet")
        self.assertEqual(job.source, "jobstreet")
        self.assertEqual(serialize_job(job)["source"], "jobstreet")
        self.assertEqual(len(job.description_hash or ""), 64)
        self.assertIn("Skills mentioned: python, sql, etl", job.notes or "")

    def test_payload_accepts_jobstreet_split_view_url(self) -> None:
        job = payload_to_job(self._payload(
            "https://sg.jobstreet.com/data-jobs/in-Singapore?jobId=94300636&type=standard"
        ))
        self.assertEqual(job.url, "https://sg.jobstreet.com/job/94300636")

    def test_payload_requires_complete_description_and_real_jobstreet_url(self) -> None:
        with self.assertRaisesRegex(ValueError, "complete JobStreet job description"):
            payload_to_job(self._payload("https://sg.jobstreet.com/job/12345", ""))
        with self.assertRaisesRegex(ValueError, "full JobStreet listing URL"):
            payload_to_job(self._payload("https://evil-jobstreet.com/job/12345"))

    def test_extension_origin_is_restricted_to_stable_extension_id(self) -> None:
        self.assertTrue(_is_extension_origin(CHROME_EXTENSION_ORIGIN))
        self.assertFalse(_is_extension_origin("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"))

    def test_jobstreet_and_linkedin_records_share_one_database(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            settings = self._settings(Path(directory))
            with JobRepository(settings.database_path) as repository:
                linkedin = repository.upsert(Job(
                    "Senior Data Engineer",
                    "Example Limited",
                    "https://www.linkedin.com/jobs/view/98765/",
                    platform="LinkedIn",
                    source="linkedin",
                    job_description="Python SQL ETL",
                    match_score=88,
                ))
            store = JobStreetStore(settings)
            jobstreet = store.upsert_capture(self._payload("https://sg.jobstreet.com/job/12345"))
            all_jobs = store.list()
            self.assertEqual({job.source for job in all_jobs}, {"linkedin", "jobstreet"})
            related = store.related_to(jobstreet.id or 0)
            self.assertEqual([job.id for job in related], [linkedin.id])

    def test_cross_platform_matching_ignores_same_platform_and_company_suffixes(self) -> None:
        target = Job("Data Engineer", "Acme Pte Ltd", "https://sg.jobstreet.com/job/1", source="jobstreet")
        linkedin = Job("Data Engineer", "Acme Limited", "https://www.linkedin.com/jobs/view/2/", source="linkedin")
        another_jobstreet = Job("Data Engineer", "Acme", "https://sg.jobstreet.com/job/3", source="jobstreet")
        unrelated = Job("Marketing Manager", "Other Co", "https://www.linkedin.com/jobs/view/4/", source="linkedin")
        self.assertEqual(cross_platform_matches(target, [linkedin, another_jobstreet, unrelated]), [linkedin])

    def test_dashboard_is_unified_and_bulk_delete_is_not_exposed(self) -> None:
        document = render_dashboard([
            Job("Data Engineer", "Example", "https://sg.jobstreet.com/job/1", platform="JobStreet", source="jobstreet", id=1),
            Job("Data Analyst", "Example", "https://www.linkedin.com/jobs/view/2/", platform="LinkedIn", source="linkedin", id=2),
        ])
        self.assertIn("Unified Job Application Dashboard", document)
        self.assertIn("LinkedIn, JobStreet and Careers@Gov", document)
        self.assertIn("JobStreet", document)
        self.assertNotIn('id="clear"', document)


if __name__ == "__main__":
    unittest.main()
