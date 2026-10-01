Deno.serve((req) => {
  const mode = new URL(req.url).searchParams.get("mode");
  if (mode === "cpu") {
    const end = Date.now() + 10_000;
    let x = 0;
    while (Date.now() < end) x += Math.sqrt(x + 1);
    return Response.json({ x });
  }
  if (mode === "memory") {
    const chunks: number[][] = [];
    for (let i = 0; i < 10_000; i++) chunks.push(new Array(1_000_000).fill(i));
    return Response.json({ chunks: chunks.length });
  }
  return Response.json({ ok: true });
});
