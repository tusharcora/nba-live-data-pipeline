from fastapi import FastAPI
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

from api.core.rate_limit import limiter
from api.routers import games, live, quality

app = FastAPI(title="Live Box Score Pipeline API")

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
app.add_middleware(SlowAPIMiddleware)

app.include_router(games.router)
app.include_router(live.router)
app.include_router(quality.router)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}
