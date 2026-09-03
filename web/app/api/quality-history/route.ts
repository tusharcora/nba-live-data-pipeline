import { NextRequest, NextResponse } from "next/server";
import { fetchFromApi } from "@/lib/fastapi-client";

// Mirrors `app/api/quality/route.ts`'s fetch-through pattern, plus
// `check_name` query-param forwarding in the style of `app/api/games/route.ts`
// (which forwards `?date=`). Unlike `date` on `/games`, `check_name` is a
// *required* param on the FastAPI route (`api/src/api/routers/quality.py`'s
// `get_quality_history` uses `Query(...)`, no default) — omitting it there
// is a 422. Rather than forwarding an absent/empty param straight through
// and letting FastAPI 422, this route rejects it at the BFF boundary with a
// 400, so callers get a same-origin, same-shape error without an extra hop.
export async function GET(request: NextRequest) {
  const checkName = request.nextUrl.searchParams.get("check_name");
  if (!checkName) {
    return NextResponse.json(
      { status: "error", message: "check_name query param is required" },
      { status: 400 }
    );
  }

  try {
    const data = await fetchFromApi(
      `/quality/history?check_name=${encodeURIComponent(checkName)}`
    );
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ status: "unreachable" }, { status: 502 });
  }
}
