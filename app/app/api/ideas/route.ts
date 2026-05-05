import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { getClientIp } from "@/lib/get-client-ip";
import { createMemoryRateLimiter } from "@/lib/memory-rate-limit";

export const dynamic = 'force-dynamic';

// 5 ideas per IP per hour (resets on cold start — fine for serverless)
const rateLimiter = createMemoryRateLimiter({ limit: 5, windowMs: 3600_000 });

function sanitize(str: string): string {
  return str
    .replace(/[<>&"'`\\]/g, "")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim();
}

const TABLE = "ideas";

export async function GET() {
  try {
    const sb = getServiceClient();
    const { data, error } = await sb.from(TABLE)
      .select("id, handle, idea, created_at")
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) {
      // Table might not exist yet — empty feed is accurate
      if (error.code === "42P01") return NextResponse.json([]);
      console.error("GET /api/ideas Supabase error:", error);
      return NextResponse.json(
        { error: "Ideas feed temporarily unavailable." },
        { status: 503 },
      );
    }

    return NextResponse.json(data ?? []);
  } catch (err) {
    console.error("GET /api/ideas error:", err);
    return NextResponse.json(
      { error: "Ideas feed temporarily unavailable." },
      { status: 503 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const ip = getClientIp(req);

    if (rateLimiter.isLimited(ip)) {
      return NextResponse.json(
        { error: "Rate limited — max 5 ideas per hour" },
        { status: 429 }
      );
    }

    const body = await req.json();
    const handle = sanitize(String(body.handle ?? ""));
    const idea = sanitize(String(body.idea ?? ""));
    const contact = body.contact ? sanitize(String(body.contact)) : null;

    if (!handle || handle.length > 30) {
      return NextResponse.json(
        { error: "Handle required (max 30 chars)" },
        { status: 400 }
      );
    }
    if (!idea || idea.length > 500) {
      return NextResponse.json(
        { error: "Idea required (max 500 chars)" },
        { status: 400 }
      );
    }

    const sb = getServiceClient();
    const { error } = await sb.from(TABLE)
      .insert({ handle, idea, contact, ip });

    if (error) throw error;

    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (err) {
    console.error("POST /api/ideas error:", err);
    return NextResponse.json(
      { error: "Failed to submit idea" },
      { status: 500 }
    );
  }
}
