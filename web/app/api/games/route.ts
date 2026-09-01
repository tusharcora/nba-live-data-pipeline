import { NextRequest, NextResponse } from "next/server";
import { fetchFromApi } from "@/lib/fastapi-client";

export async function GET(request: NextRequest) {
  try {
    const date = request.nextUrl.searchParams.get("date");
    const data = await fetchFromApi(`/games${date ? `?date=${date}` : ""}`);
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ status: "unreachable" }, { status: 502 });
  }
}
