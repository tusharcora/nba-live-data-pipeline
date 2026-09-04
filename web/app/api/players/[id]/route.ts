import { NextResponse } from "next/server";
import { fetchFromApi } from "@/lib/fastapi-client";

// Dedicated BFF route for the player detail page (app/players/[id]/page.tsx).
// Fans out to FastAPI `GET /player-stats?player_id=<id>` -- every game this
// player has a stat line for, most-recent first (see
// api/src/api/routers/player_stats.py). The page derives averages, the
// last-10 game log, and per-team date ranges from this one response
// client-side, rather than adding new backend aggregate endpoints -- a
// player's full career is at most a few thousand rows, small enough that
// client-side aggregation is simpler than new SQL for now.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const playerStats = await fetchFromApi(
      `/player-stats?player_id=${encodeURIComponent(id)}`
    );
    return NextResponse.json({ playerStats });
  } catch {
    return NextResponse.json({ status: "unreachable" }, { status: 502 });
  }
}
