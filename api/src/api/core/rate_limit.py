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

# Because every legitimate caller shares the single BFF-held API key, this
# limit is a GLOBAL ceiling on all real end-user traffic combined, not a
# per-user allowance. A real load test (docs/prd.md §09, 2026-09-02, 30
# simulated concurrent dashboard users — well within the PRD's own "20-50
# concurrent viewers during a live game window" scenario) hit this at
# 100/minute: ~48% of otherwise-healthy requests came back 429 purely from
# normal app traffic, not abuse (p95 latency itself was ~20ms, comfortably
# under the <300ms target). Raised to comfortably cover that scenario with
# headroom while still bounding a genuinely malicious scraper.
DEFAULT_RATE_LIMIT = "600/minute"
