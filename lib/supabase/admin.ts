import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { getSupabaseAdminConfig } from "./config";

let adminClient: SupabaseClient | undefined;

export function createSupabaseAdminClient() {
  if (adminClient) return adminClient;
  const { url, secretKey } = getSupabaseAdminConfig();
  adminClient = createClient(url, secretKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  return adminClient;
}
