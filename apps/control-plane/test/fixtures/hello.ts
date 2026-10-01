// Edge function used by the e2e test: reads the caller's todos through SUPABASE_URL (RLS applies).
Deno.serve(async (req) => {
  const { name } = await req.json().catch(() => ({ name: "world" }));
  const response = await fetch(`${Deno.env.get("SUPABASE_URL")}/rest/v1/todos?select=title`, {
    headers: {
      apikey: Deno.env.get("SUPABASE_ANON_KEY")!,
      Authorization: req.headers.get("Authorization") ?? "",
    },
  });
  console.log(`hello called for ${name}: rest status ${response.status}`);
  return Response.json({
    message: `hello ${name}`,
    greeting: Deno.env.get("GREETING") ?? null,
    todos: await response.json(),
    has_service_key: !!Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
  });
});
