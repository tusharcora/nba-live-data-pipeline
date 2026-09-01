from fastapi import APIRouter, Depends

from api.core.security import require_api_key

router = APIRouter(prefix="/live", tags=["live"], dependencies=[Depends(require_api_key)])


@router.get("/")
def get_live_state() -> dict:
    """Live game state, SSE in a later week (docs/prd.md §04, §11). Stub for now."""
    return {"data": [], "note": "stub"}
