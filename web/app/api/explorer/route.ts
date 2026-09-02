import { NextRequest, NextResponse } from "next/server";
import { fetchFromApi } from "@/lib/fastapi-client";

// Single dedicated BFF route for the Historical Explorer page, fanning out
// to both FastAPI `GET /games` (date-range search) and the new
// `GET /player-stats` (player-name / game-id lookup) — see PR description
// for why one route was chosen over two. Both upstream calls go through
// `fetchFromApi` (lib/fastapi-client.ts), so the `X-API-Key` header is
// attached server-side and never reaches the browser either way.
//
// Two request shapes, disambiguated by which query params are present:
//
// 1. Box-score lookup for a single game — `game_id` present, `start_date`
//    and `end_date` both absent (the per-game "view box score" expansion
//    on the explorer page). Only `/player-stats?game_id=` is called.
//      -> { games: null, playerStats: { data, count } }
//
// 2. Games search (default, including the page's initial "recent 20"
//    load with no params at all) — `/games` is always called, with
//    `start_date`/`end_date` passed through when present. `date` is never
//    sent, so `/games`'s "date cannot be combined with start_date/end_date"
//    mutual-exclusivity rule can't be tripped from this route. If
//    `player_name` is also present, `/player-stats?player_name=` is fetched
//    in parallel for the top-level player-name search field.
//      -> { games: { data, count }, playerStats: { data, count } | null }
//
// Errors (network failure, or a non-2xx from FastAPI — including a 400 for
// a malformed date or start_date > end_date) collapse to a single 502, same
// posture as the existing `/api/games` route — the explorer page's client
// side validates the date range before submitting, so a 400 here should be
// rare in practice.
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const gameId = params.get("game_id");
  const playerName = params.get("player_name");
  const startDate = params.get("start_date");
  const endDate = params.get("end_date");

  try {
    if (gameId && !startDate && !endDate) {
      const playerStats = await fetchFromApi(
        `/player-stats?game_id=${encodeURIComponent(gameId)}`
      );
      return NextResponse.json({ games: null, playerStats });
    }

    const gameParams = new URLSearchParams();
    if (startDate) gameParams.set("start_date", startDate);
    if (endDate) gameParams.set("end_date", endDate);
    const gamesQuery = gameParams.toString();

    const gamesPromise = fetchFromApi(`/games${gamesQuery ? `?${gamesQuery}` : ""}`);
    const playerStatsPromise = playerName
      ? fetchFromApi(`/player-stats?player_name=${encodeURIComponent(playerName)}`)
      : Promise.resolve(null);

    const [games, playerStats] = await Promise.all([
      gamesPromise,
      playerStatsPromise,
    ]);
    return NextResponse.json({ games, playerStats });
  } catch {
    return NextResponse.json({ status: "unreachable" }, { status: 502 });
  }
}
