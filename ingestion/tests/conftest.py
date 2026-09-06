import sys
from pathlib import Path

# Add parent directories to path so imports work
repo_root = Path(__file__).parent.parent.parent
sys.path.insert(0, str(repo_root / "db" / "src"))
sys.path.insert(0, str(repo_root / "quality" / "src"))
sys.path.insert(0, str(repo_root / "ingestion" / "src"))
