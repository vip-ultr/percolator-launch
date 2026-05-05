import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { User } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

export type AdminSessionResult =
  | { ok: true; user: User }
  | { ok: false; response: NextResponse };

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Verify Supabase Auth session (cookies) and membership in `admin_users`.
 * For Route Handlers that return PII using `getServiceClient()`.
 */
export async function requireAdminSession(): Promise<AdminSessionResult> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Admin auth is not configured" }, { status: 503 }),
    };
  }

  const cookieStore = await cookies();
  const supabase = createServerClient(
    supabaseUrl,
    supabaseAnonKey,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll() {
          /* read-only in Route Handlers */
        },
      },
    },
  );

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }
  if (!user.email) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }

  if (!user.email_confirmed_at) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }

  const email = normalizeEmail(user.email);

  const sb = getServiceClient();
  const { data: adminRow } = await sb
    .from("admin_users")
    .select("id")
    .eq("email", email)
    .maybeSingle();

  if (!adminRow) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    };
  }

  return { ok: true, user };
}
