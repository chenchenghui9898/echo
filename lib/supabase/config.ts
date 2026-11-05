export type EchoDataBackend = "json" | "supabase";

export function getEchoDataBackend(
  environment: NodeJS.ProcessEnv = process.env,
): EchoDataBackend {
  const value = environment.ECHO_DATA_BACKEND?.trim().toLowerCase() || "json";
  if (value === "json" || value === "supabase") return value;
  throw new Error("INVALID_ECHO_DATA_BACKEND");
}

export function getSupabasePublicConfig(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const url = environment.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const publishableKey = environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!url || !publishableKey) throw new Error("SUPABASE_PUBLIC_CONFIG_MISSING");
  return { url, publishableKey };
}
