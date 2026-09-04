import { NextResponse } from "next/server";
import { fetchFromApi } from "@/lib/fastapi-client";
import { namesForAbbreviation } from "@/lib/box-score";

// Dedicated BFF route for the team detail page (app/teams/[abbreviation]/page.tsx).
// The Gold `games` table has no team-id column (see api/src/api/routers/games.py),
// so every historical full name a franchise has played under (namesForAbbreviation)
// is passed as a repeated `?team=` param -- FastAPI matches home_team OR away_team
// against any of them.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ abbreviation: string }> }
) {
  const { abbreviation } = await params;
  const names = namesForAbbreviation(abbreviation.toUpperCase());

  if (names.length === 0) {
    return NextResponse.json({ games: null });
  }

  const search = new URLSearchParams();
  for (const name of names) search.append("team", name);

  try {
    const games = await fetchFromApi(`/games?${search.toString()}`);
    return NextResponse.json({ games });
  } catch {
    return NextResponse.json({ status: "unreachable" }, { status: 502 });
  }
}
