// Usage: node verify.mjs <slug>  — signup, insert, read back, call the summary function
import { createClient } from "@supabase/supabase-js";
const slug = process.argv[2];
const base = `http://${slug}.localhost:8100`;
const html = await (await fetch(base)).text();
console.log("front:", /<title>(.*?)<\/title>/.exec(html)?.[1], "| bundle:", /assets\/(index-[^"]+\.js)/.exec(html)?.[1]);
const anon = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.exec(
  await (await fetch(`${base}/${/(assets\/index-[^"]+\.js)/.exec(html)[1]}`)).text(),
)?.[0];
if (!anon) throw new Error("anon key not found in bundle");
const supabase = createClient(base, anon);
const email = `verify-${Date.now()}@example.com`;
const { error: e1 } = await supabase.auth.signUp({ email, password: "password123" });
if (e1) throw e1;
const { data: inserted, error: e2 } = await supabase.from("todos").insert({ title: "from verify.mjs" }).select().single();
if (e2) throw e2;
console.log("inserted:", inserted);
const { data: rows, error: e3 } = await supabase.from("todos").select("*");
if (e3) throw e3;
console.log("read back:", rows.length, "row(s)");
const { data: summary, error: e4 } = await supabase.functions.invoke("summary");
if (e4) throw e4;
console.log("summary:", summary);
const anonOnly = createClient(base, anon);
const { data: leaked } = await anonOnly.from("todos").select("*");
console.log("anonymous read (RLS):", leaked?.length ?? 0, "row(s)");
if (rows.length !== 1 || summary.total !== 1) throw new Error("unexpected counts");
console.log("OK");
