from fastapi import APIRouter, Depends

from api.core.security import require_api_key

router = APIRouter(prefix="/quality", tags=["quality"], dependencies=[Depends(require_api_key)])


@router.get("/")
def get_quality_metrics() -> dict:
    """Drift/agreement scorecard data from quality_metrics (docs/prd.md §07). Stub for now."""
    return {"data": [], "note": "stub"}
