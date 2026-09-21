"""Guard against document generation returning to background service paths."""
import ast
import unittest
from pathlib import Path


class NoAutomaticResumeTests(unittest.TestCase):
    def test_services_do_not_generate_resumes_or_queue_startup_analysis(self):
        root = Path(__file__).resolve().parents[1]
        for service in ("linkedin", "jobstreet", "careersgov"):
            with self.subTest(service=service):
                tree = ast.parse((root / service / "companion/server.py").read_text(encoding="utf-8"))
                calls = [node for node in ast.walk(tree) if isinstance(node, ast.Call)]
                self.assertFalse(any(isinstance(call.func, ast.Name) and
                                     call.func.id == "create_tailored_resume" for call in calls))
                startup = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "run")
                self.assertFalse(any(isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and
                                     node.func.attr in ("enqueue", "enqueue_all", "refresh_analysis")
                                     for node in ast.walk(startup)))


if __name__ == "__main__":
    unittest.main()
