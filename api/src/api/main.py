from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

from api.core.config import Settings
from api.core.rate_limit import limiter
from api.routers import games, live, quality

app = FastAPI(title="Live Box Score Pipeline API")

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
app.add_middleware(SlowAPIMiddleware)

# CORS lockdown (docs/prd.md §08): the browser never calls this API directly —
# only the Next.js BFF does, server-side. This middleware exists so that if a
# browser ever does try (misconfiguration, a bug in the BFF, a malicious
# page), the response carries no Access-Control-Allow-Origin header for any
# origin but the configured BFF origin, and the browser's own same-origin
# policy blocks the read. Every route here (games, live, quality, /health) is
# GET-only today, so allow_methods is intentionally narrow rather than a
# wildcard.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[Settings().allowed_origin],
    allow_methods=["GET"],
    allow_headers=["X-API-Key", "Content-Type"],
)

app.include_router(games.router)
app.include_router(live.router)
app.include_router(quality.router)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}
