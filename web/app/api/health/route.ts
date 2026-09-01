import { NextResponse } from "next/server";
import { fetchFromApi } from "@/lib/fastapi-client";

export async function GET() {
  try {
    const data = await fetchFromApi("/health");
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ status: "unreachable" }, { status: 502 });
  }
}
