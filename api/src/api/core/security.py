from fastapi import Header, HTTPException, status

from api.core.config import Settings


def require_api_key(x_api_key: str = Header(default="")) -> None:
    """Gate every route the BFF calls (docs/prd.md §08).

    The key lives only in the Next.js BFF's server-side env — never sent to
    or reachable from the browser.
    """
    settings = Settings()
    if not settings.api_service_key or x_api_key != settings.api_service_key:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid or missing API key")
