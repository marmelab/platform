import { greeting } from "../_shared/greeting.ts";

const bootedAt = new Date().toISOString();

Deno.serve((req) =>
  Response.json({
    message: greeting(Deno.env.get("APP_NAME") ?? "?"),
    url: req.url,
    supabaseUrl: Deno.env.get("SUPABASE_URL"),
    slug: Deno.env.get("SUPABASE_FUNCTION_SLUG"),
    bootedAt,
  })
);
