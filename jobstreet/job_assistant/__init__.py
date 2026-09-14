"""Local, human-in-the-loop job application assistant."""

import sys
from pathlib import Path

_workspace = Path(__file__).resolve().parents[2]
if (_workspace / "shared_tracker").is_dir() and str(_workspace) not in sys.path:
    sys.path.insert(0, str(_workspace))
