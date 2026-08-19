import { createClient } from "@supabase/supabase-js";

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Set these as environment variables " +
      "(locally in a .env you load yourself, or as GitHub Actions secrets)."
  );
}

// Service-role key: bypasses Row Level Security entirely. Server-side / CI use only —
// never import this file from anything that ships to the browser.
export const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
