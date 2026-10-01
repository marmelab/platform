import { z } from "npm:zod@3.23.8";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const Body = z.object({ name: z.string().min(1) });

Deno.serve(async (req) => {
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
  return Response.json({
    zod: parsed.success ? `valid: ${parsed.data.name}` : `invalid: ${parsed.error.issues[0].message}`,
    supabaseClient: typeof supabase.from === "function",
  });
});
