from fastapi import FastAPI

from api.routers import games, live, quality

app = FastAPI(title="Live Box Score Pipeline API")

app.include_router(games.router)
app.include_router(live.router)
app.include_router(quality.router)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}
