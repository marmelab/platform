Deno.serve((req) => {
  const [, payload] = (req.headers.get("authorization") ?? "").split(".");
  const claims = payload ? JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) : null;
  return Response.json({ app: Deno.env.get("APP_NAME"), ok: true, claims });
});
