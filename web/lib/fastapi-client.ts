// Server-only: the API key never reaches the browser (docs/prd.md §08).
// Every future BFF route calls FastAPI through this helper, not fetch() directly.

const BASE_URL = process.env.FASTAPI_BASE_URL ?? "http://localhost:8000";
const API_KEY = process.env.API_SERVICE_KEY ?? "";

export async function fetchFromApi(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { ...init.headers, "X-API-Key": API_KEY },
  });
  if (!res.ok) {
    throw new Error(`FastAPI ${path} responded ${res.status}`);
  }
  return res.json();
}
