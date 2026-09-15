import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from shared_tracker.autofill_profile import get_profile, validate_saved, allowed_extension
from shared_tracker.resume_profile import parse_resume, newest_resume, partial_date

SAMPLE = '''Alex Example
alex@example.org | +44 7700 900123 | linkedin.com/in/alex-example | alex.github.io | example.net/work
Address: 1 Example Street
Additional Address: Unit 02-03
City: Example City
Postal Code: 123456
Professional Summary
Analyst supporting reporting systems.
Core Skills
Data: Python, SQL
Tools: Git, Power BI
Professional Experience
Example Company | Data Analyst Jan 2023 - Present
Built validated reports.
Previous Company | Engineer Jun 2020 - Dec 2022
Maintained data pipelines.
Education
Example University - Bachelor of Science in Computing | Jun 2020
Certifications
Example Certificate
'''


class AutofillTests(unittest.TestCase):
    def test_extracts_facts_without_personal_defaults(self):
        profile, warnings = parse_resume(SAMPLE)
        self.assertEqual(profile['full_name'], 'Alex Example')
        self.assertEqual(profile['email'], 'alex@example.org')
        self.assertEqual(profile['first_name'], '')
        self.assertEqual(profile['street_name'], '1 Example Street')
        self.assertEqual(profile['additional_address'], 'Unit 02-03')
        self.assertEqual(profile['city'], 'Example City')
        self.assertEqual(profile['postal_code'], '123456')
        self.assertEqual(profile['website_url'], 'https://alex.github.io')
        self.assertEqual(profile['website_url_2'], 'https://example.net/work')
        self.assertNotIn('expected_salary', profile)
        self.assertEqual(profile['employment'][0]['start_date'], '2023-01')
        self.assertTrue(profile['employment'][0]['current'])
        self.assertEqual(profile['education'][0]['field_of_study'], 'Computing')
        self.assertEqual(profile['education'][0]['start_date'], '')
        self.assertEqual(profile['skills'], 'Python, SQL, Git, Power BI')
        self.assertTrue(warnings)

    def test_new_resume_refreshes_defaults_and_retains_only_saved_overrides(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            first = root/'first.pdf'; first.write_bytes(b'first')
            saved = root/'profile.local.json'
            saved.write_text(json.dumps({'overrides': {'notice_period': 'Two weeks'}}))
            with patch('shared_tracker.autofill_profile.read_resume', return_value=SAMPLE):
                before = get_profile(saved, [root])
            second = root/'second.docx'; second.write_bytes(b'new')
            os.utime(second, ns=(first.stat().st_mtime_ns + 1000000, first.stat().st_mtime_ns + 1000000))
            with patch('shared_tracker.autofill_profile.read_resume', return_value=SAMPLE.replace('Alex Example','Taylor Sample').replace('Python, SQL','Rust, SQL')):
                after = get_profile(saved, [root])
            self.assertEqual(after['profile']['full_name'], '')
            self.assertEqual(after['profile']['email'], '')
            self.assertEqual(after['profile']['street_name'], '')
            self.assertIn('Rust', after['profile']['skills'])
            self.assertEqual(after['profile']['education'][0]['institution'], 'Example University')
            self.assertEqual(after['profile']['employment'][0]['employer'], 'Example Company')
            self.assertEqual(after['profile']['notice_period'], 'Two weeks')
            self.assertNotEqual(before['revision'], after['revision'])
            self.assertEqual(after['source']['name'], 'second.docx')
            self.assertNotIn(str(root), json.dumps(after))

    def test_missing_or_unreadable_resume_does_not_use_stale_defaults(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            result = get_profile(root/'missing.json', [root])
            self.assertEqual(result['profile']['education'], [])
            self.assertEqual(result['overrides'], {})
            (root/'broken.pdf').write_bytes(b'broken')
            with patch('shared_tracker.autofill_profile.read_resume', side_effect=ValueError('Unreadable PDF')):
                result = get_profile(root/'missing.json', [root])
            self.assertEqual(result['defaults'], {})
            self.assertIn('could not be parsed', result['warnings'][0])

    def test_ignores_generated_resumes_and_rejects_invalid_profile(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root/'tailored.pdf').touch(); (root/'backup.docx').touch()
            self.assertIsNone(newest_resume([root]))
        for invalid in ({'overrides': {'password': 'x'}}, {'enabled': 'yes'}, {'overrides': {'employment': [{'current': 'yes'}]}},
                        {'overrides': {'prefix': 'Captain'}}, {'overrides': {'phone_device_type': 'Fax'}},
                        {'overrides': {'earliest_available_start_date': 'next week'}}):
            with self.assertRaises(ValueError): validate_saved(invalid)
        self.assertEqual(partial_date('2020'), '2020')
        self.assertEqual(partial_date('May 2020'), '2020-05')
        self.assertEqual(partial_date('Present'), '')

    def test_only_registered_extensions_read_private_profile(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            manifest = root/'chrome-helper/generated/com.job_application_assistant.launcher.json'
            manifest.parent.mkdir(parents=True)
            manifest.write_text(json.dumps({'allowed_origins':['chrome-extension://test/']}))
            with patch('shared_tracker.autofill_profile.WORKSPACE', root):
                self.assertTrue(allowed_extension('chrome-extension://test'))
                self.assertFalse(allowed_extension('https://test'))
                self.assertFalse(allowed_extension('chrome-extension://other'))


if __name__ == '__main__': unittest.main()
