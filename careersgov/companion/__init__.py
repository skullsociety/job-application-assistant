"""Local companion for the Careers@Gov Chrome extension prototype."""

import sys
from pathlib import Path

_workspace = Path(__file__).resolve().parents[2]
if str(_workspace) not in sys.path:
    sys.path.insert(0, str(_workspace))
