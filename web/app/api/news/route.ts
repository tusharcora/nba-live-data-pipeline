import { NextRequest, NextResponse } from "next/server";
import { fetchFromApi } from "@/lib/fastapi-client";

export async function GET(request: NextRequest) {
  const reporter = request.nextUrl.searchParams.get("reporter");
  const limit = request.nextUrl.searchParams.get("limit");

  const params = new URLSearchParams();
  if (reporter) params.set("reporter", reporter);
  if (limit) params.set("limit", limit);
  const query = params.toString();

  try {
    const data = await fetchFromApi(`/news${query ? `?${query}` : ""}`);
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ status: "unreachable" }, { status: 502 });
  }
}
