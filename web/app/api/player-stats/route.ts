import { NextRequest, NextResponse } from "next/server";
import { fetchFromApi } from "@/lib/fastapi-client";

// Thin pass-through BFF route for `GET /player-stats?game_id=...` (repeatable).
// Used by the team detail page's roster view to fetch every player line
// across a whole season's worth of game_ids in one request.
export async function GET(request: NextRequest) {
  const gameIds = request.nextUrl.searchParams.getAll("game_id");

  const search = new URLSearchParams();
  for (const id of gameIds) search.append("game_id", id);

  try {
    const data = await fetchFromApi(`/player-stats?${search.toString()}`);
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ status: "unreachable" }, { status: 502 });
  }
}
