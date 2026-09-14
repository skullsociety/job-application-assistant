import json
import tempfile
import threading
import unittest
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from companion.server import CompanionHandler, JobStreetStore
from job_assistant.config import Settings
from job_assistant.database import JobRepository
from job_assistant.models import Job


class SharedHttpTests(unittest.TestCase):
    def test_shared_dashboard_tracking_export_resume_and_delete(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            settings = Settings(database_path=root/'jobs.sqlite3', export_path=root/'jobs.xlsx', log_path=root/'log',
                                browser_user_data_dir=root/'browser', browser_channel='chrome', profile_path=root/'profile',
                                tailored_resume_dir=root/'tailored', tailored_resume_threshold=70,
                                resume_dir=root/'resumes', resume_path=None)
            store = JobStreetStore(settings)
            with JobRepository(settings.database_path) as repo:
                job = repo.upsert(Job('Analyst', 'Agency', 'https://jobs.careers.gov.sg/jobs/greenhouse/555',
                                     platform='Careers@Gov', source='careersgov', closing_date='2026-12-31', key_skills='Python'))
                repo.set_tailored_resume_path(job.id, 'one.pdf')
            pdf = settings.tailored_resume_dir/'one.pdf'
            pdf.parent.mkdir(parents=True)
            pdf.write_bytes(b'%PDF-test')
            class Handler(CompanionHandler):
                def log_message(self, *_): pass
            Handler.store = store
            Handler.processor = SimpleNamespace(enqueue_all=lambda: 0)
            server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            connection = HTTPConnection('127.0.0.1', server.server_port)
            try:
                connection.request('GET', f'/api/jobs/{job.id}/resume')
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                self.assertEqual(response.read(), b'%PDF-test')
                for route in ('/', '/dashboard.js', '/dashboard.css', '/api/jobs', '/exports/job_tracker.xlsx'):
                    connection.request('GET', route)
                    response = connection.getresponse()
                    self.assertEqual(response.status, 200, route)
                    response.read()
                for origin, status in (('https://evil.invalid', 403), ('http://127.0.0.1:8767', 200)):
                    connection.request('POST', f'/api/jobs/{job.id}/tracking', json.dumps({'applied': True, 'notes': 'My note'}),
                                       {'Origin': origin, 'Content-Type': 'application/json'})
                    response = connection.getresponse()
                    self.assertEqual(response.status, status)
                    response.read()
                saved = store.get(job.id)
                with patch('companion.server.allowed_extension', side_effect=lambda origin: origin in {'chrome-extension://linkedin', 'chrome-extension://jobstreet', 'chrome-extension://careersgov'}), patch('companion.server.get_profile', return_value={'profile': {'first_name': 'Example'}}), patch('companion.server.save_profile', return_value={'profile': {'first_name': 'Edited'}}):
                    for origin in ('chrome-extension://linkedin', 'chrome-extension://jobstreet', 'chrome-extension://careersgov', 'https://evil.invalid', ''):
                        for method in ('GET', 'POST'):
                            connection.request(method, '/api/autofill-profile', '{}' if method == 'POST' else None, {'Origin': origin, 'Content-Type': 'application/json'})
                            response = connection.getresponse()
                            self.assertEqual(response.status, 200 if origin.startswith('chrome-extension://') else 403)
                            body = json.loads(response.read())
                            if response.status == 200:
                                self.assertEqual(response.getheader('Access-Control-Allow-Origin'), origin)
                            else:
                                self.assertNotIn('profile', body)
                self.assertEqual(saved.closing_date, '2026-12-31')
                self.assertTrue(saved.applied)
                self.assertEqual(saved.notes, 'My note')
                connection.request('DELETE', f'/api/jobs/{job.id}', headers={'Origin': 'http://127.0.0.1:8767'})
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                response.read()
                self.assertEqual(store.list(), [])
                self.assertTrue(pdf.exists())
            finally:
                connection.close(); server.shutdown(); server.server_close(); thread.join()

    def test_old_analysis_cannot_replace_a_new_description(self):
        with tempfile.TemporaryDirectory() as directory:
            with JobRepository(Path(directory)/'jobs.sqlite3') as repo:
                job = repo.upsert(Job('Analyst', 'Agency', 'https://sg.jobstreet.com/job/1', description_hash='old'))
                repo.upsert(Job('Analyst', 'Agency', job.url, description_hash='new'))
                saved = repo.save_match(job.id, score=90, matching_skills='Python', missing_skills='', reason='old', recommendation='apply', expected_hash='old')
                self.assertIsNone(saved)
                self.assertIsNone(repo.get(job.id).match_score)


if __name__ == '__main__': unittest.main()
