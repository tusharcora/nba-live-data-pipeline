from fastapi import APIRouter, Depends

from api.core.security import require_api_key

router = APIRouter(prefix="/games", tags=["games"], dependencies=[Depends(require_api_key)])


@router.get("/")
def list_games() -> dict:
    """Reconciled games from Gold (docs/prd.md §06, §11). Stub for now."""
    return {"data": [], "note": "stub"}
