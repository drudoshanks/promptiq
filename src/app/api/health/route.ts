import { NextResponse } from "next/server";

import { pool } from "@/lib/db/client";

export const dynamic = "force-dynamic";

/** Liveness/readiness probe for deploy health checks (§16.2). */
export async function GET() {
  try {
    await pool.query("SELECT 1");
    return NextResponse.json({ status: "ok", database: "ok" }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ status: "degraded", database: "unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
