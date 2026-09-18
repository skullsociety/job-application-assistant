from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from shared_tracker.cover_letters import generate_cover_letter, save_cover_letter


class CoverLetterTests(unittest.TestCase):
    def test_draft_only_names_shared_skills(self) -> None:
        letter = generate_cover_letter("Data Analyst", "Example Co", "Python and SQL required", ["python"])
        self.assertIn("Data Analyst", letter)
        self.assertIn("Example Co", letter)
        self.assertIn("Python", letter)
        self.assertNotIn("SQL", letter)

    def test_description_is_required(self) -> None:
        with self.assertRaises(ValueError):
            generate_cover_letter("Analyst", "Example", "", ["python"])

    def test_txt_file_is_saved_with_job_id_and_safe_name(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = save_cover_letter(25, "Data / Engineer", "Example: Co", "Draft\n", Path(directory))
            self.assertEqual(path.name, "25_example_co_data_engineer_cover_letter.txt")
            self.assertEqual(path.read_text(encoding="utf-8"), "Draft\n")


if __name__ == "__main__":
    unittest.main()
