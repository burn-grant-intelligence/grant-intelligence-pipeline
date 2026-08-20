import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  // Thrown at build/runtime if env vars are missing on Vercel — a clear signal
  // rather than a silent blank page.
  throw new Error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY environment variables."
  );
}

// This uses the publishable/anon key — safe for the browser as long as
// Row Level Security policies are set (see supabase/policies.sql).
export const supabase = createClient(url, anonKey);
