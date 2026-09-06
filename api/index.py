import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / "src"))

from api.main import app  # noqa: E402
