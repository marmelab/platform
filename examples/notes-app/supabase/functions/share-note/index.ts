import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const reply = (status: number, body: Record<string, unknown>) => Response.json(body, { status, headers: cors });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply(405, { error: "Use POST" });

  const { note_id, email, permission } = await req.json().catch(() => ({}));
  if (typeof note_id !== "string" || typeof email !== "string" || !["read", "edit"].includes(permission)) {
    return reply(400, { error: "Expected { note_id, email, permission: 'read' | 'edit' }" });
  }

  const url = Deno.env.get("SUPABASE_URL")!;
  const caller = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: auth, error: authError } = await caller.auth.getUser();
  if (authError || !auth.user) return reply(401, { error: "Not signed in" });

  const { data: note } = await caller.from("notes").select("author_id").eq("id", note_id).maybeSingle();
  if (!note || note.author_id !== auth.user.id) return reply(403, { error: "Only the author of a note can share it" });

  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: target, error: lookupError } = await admin
    .from("profiles")
    .select("id, email, display_name")
    .eq("email", email.trim().toLowerCase())
    .maybeSingle();
  if (lookupError) return reply(500, { error: lookupError.message });
  if (!target) return reply(404, { error: `${email.trim()} has no account in this app` });
  if (target.id === auth.user.id) return reply(400, { error: "You are the author of this note" });

  const { error } = await caller
    .from("note_shares")
    .upsert({ note_id, user_id: target.id, permission }, { onConflict: "note_id,user_id" });
  if (error) return reply(400, { error: error.message });

  return reply(200, { note_id, permission, user: target });
});
