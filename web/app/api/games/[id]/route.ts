import { NextResponse } from "next/server";
import { fetchFromApi } from "@/lib/fastapi-client";

// Dedicated BFF route for the game detail page (app/games/[id]/page.tsx).
// Fans out to FastAPI `GET /games?game_id=<id>` (the game's own record --
// date, teams, final score) and `GET /player-stats?game_id=<id>` (the full
// box score for both teams) in parallel. `game` is `null` if no game with
// this id exists at all -- a real, distinct state from "the game exists
// but has no box score yet" (empty `playerStats.data`), which the page
// renders differently.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const [gamesResult, playerStats] = await Promise.all([
      fetchFromApi(`/games?game_id=${encodeURIComponent(id)}`),
      fetchFromApi(`/player-stats?game_id=${encodeURIComponent(id)}`),
    ]);
    return NextResponse.json({
      game: gamesResult.data[0] ?? null,
      playerStats,
    });
  } catch {
    return NextResponse.json({ status: "unreachable" }, { status: 502 });
  }
}
