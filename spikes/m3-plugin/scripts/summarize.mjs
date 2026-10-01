// Usage: node summarize.mjs run.jsonl  -> markdown summary of a stream-json transcript
import { readFileSync } from "node:fs";
const lines = readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const out = [];
const short = (s, n = 300) => {
  s = typeof s === "string" ? s : JSON.stringify(s);
  s = s.replace(/plat_[A-Za-z0-9_-]+/g, "plat_***").replace(/up_[A-Za-z0-9_-]{20,}/g, "up_***").replace(/eyJ[A-Za-z0-9_.-]{20,}/g, "eyJ***");
  return s.length > n ? s.slice(0, n) + "…" : s;
};
let step = 0;
for (const m of lines) {
  if (m.type === "assistant") {
    for (const c of m.message.content) {
      if (c.type === "text" && c.text.trim()) out.push(`- **Claude** : ${short(c.text.trim(), 600)}`);
      if (c.type === "tool_use") out.push(`- ${++step}. \`${c.name.replace("mcp__plugin_platform_platform__", "mcp:")}\` ${short(c.input, 250)}`);
    }
  } else if (m.type === "user" && Array.isArray(m.message?.content)) {
    for (const c of m.message.content) {
      if (c.type === "tool_result") {
        const text = Array.isArray(c.content) ? c.content.map((x) => x.text ?? "").join(" ") : c.content;
        out.push(`  - ${c.is_error ? "**ERREUR** " : ""}→ ${short(text, 250).replace(/\n/g, " ")}`);
      }
    }
  } else if (m.type === "result") {
    out.unshift(
      `- Résultat : ${m.subtype}, is_error=${m.is_error}`,
      `- Durée : ${(m.duration_ms / 1000).toFixed(0)} s (API ${(m.duration_api_ms / 1000).toFixed(0)} s), tours : ${m.num_turns}, coût : ${m.total_cost_usd?.toFixed(3)} USD`,
      `- Modèle(s) : ${Object.keys(m.modelUsage ?? {}).join(", ")}`,
      `- Appels d'outils : ${step}`,
      "",
    );
    out.push("", "### Message final", "", short(m.result, 4000));
  }
}
console.log(out.join("\n"));
