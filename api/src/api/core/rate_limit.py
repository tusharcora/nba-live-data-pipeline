from slowapi import Limiter
from slowapi.util import get_remote_address


def _key_by_api_key(request) -> str:
    """Rate-limit per caller identity, not per IP.

    By the time a route's dependencies run, `require_api_key` has already
    validated `X-API-Key` — every legitimate caller is the single BFF
    holding that one key, so keying by the header value (falling back to
    remote address only if it's somehow missing) is what actually
    distinguishes callers here, unlike a public multi-client API.
    """
    return request.headers.get("x-api-key") or get_remote_address(request)


limiter = Limiter(key_func=_key_by_api_key)

DEFAULT_RATE_LIMIT = "100/minute"
