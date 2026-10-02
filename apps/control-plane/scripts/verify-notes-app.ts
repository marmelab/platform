// Checks the access rules of the seeded notes-app through its public APIs (REST, Edge Functions), as its app users.
// Run after `deploy/install.sh --seed`: node apps/control-plane/scripts/verify-notes-app.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createClient, FunctionsHttpError, type SupabaseClient } from "@supabase/supabase-js";

const env = new Map(
  readFileSync(new URL("../../../deploy/.env.local", import.meta.url), "utf8").split("\n").filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)] as const),
);

const mcp = new Client({ name: "verify-notes-app", version: "0.0.0" });
await mcp.connect(new StreamableHTTPClientTransport(new URL(env.get("PLATFORM_URL")!), {
  requestInit: { headers: { Authorization: `Bearer ${env.get("SEED_BOB_TOKEN")}` } },
}));
const result = (await mcp.callTool({ name: "get_app", arguments: { app: "notes-app" } })) as { content: { text: string }[] };
const app = JSON.parse(result.content[0]!.text) as { supabase_url: string; anon_key: string };
await mcp.close();

async function signIn(email: string, password = "demo-password") {
  const client = createClient(app.supabase_url, app.anon_key, { auth: { persistSession: false } });
  let { error } = await client.auth.signInWithPassword({ email, password });
  if (error) ({ error } = await client.auth.signUp({ email, password }));
  if (error) throw new Error(`${email}: ${error.message}`);
  return client;
}

async function share(client: SupabaseClient, note_id: string, email: string, permission = "read") {
  const { error } = await client.functions.invoke("share-note", { body: { note_id, email, permission } });
  if (!error) return { status: 200, message: "" };
  const response = (error as FunctionsHttpError).context as Response;
  return { status: response.status, message: ((await response.json()) as { error: string }).error };
}

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`ok    ${name}`);
  } catch (error) {
    failures++;
    console.log(`FAIL  ${name}\n      ${error instanceof Error ? error.message : error}`);
  }
}

const owner = await signIn("demo-user@example.com");
const guest = await signIn("demo-user-2@example.com");
const outsider = await signIn("verify-outsider@example.com", "verify-password");

const titles = async (client: SupabaseClient) =>
  ((await client.from("notes").select("title").order("title")).data ?? []).map((n) => n.title);
const noteId = async (title: string) =>
  (await owner.from("notes").select("id, content").eq("title", title).single()).data!;
const readOnly = await noteId("Team offsite ideas");
const editable = await noteId("Release checklist");
const personal = await noteId("Personal reminders");

await check("demo-user sees their 3 notes", async () => {
  assert.deepEqual(await titles(owner), ["Personal reminders", "Release checklist", "Team offsite ideas"]);
});

await check("demo-user-2 only sees the 2 notes shared with them", async () => {
  assert.deepEqual(await titles(guest), ["Release checklist", "Team offsite ideas"]);
  const { data } = await guest.from("note_shares").select("permission, notes(title)").order("permission");
  assert.deepEqual(data, [
    { permission: "edit", notes: { title: "Release checklist" } },
    { permission: "read", notes: { title: "Team offsite ideas" } },
  ]);
});

await check("demo-user-2 can edit the note shared for editing", async () => {
  const { data, error } = await guest.from("notes").update({ content: "edited by demo-user-2" }).eq("id", editable.id)
    .select("content, updated_by");
  assert.ifError(error);
  assert.equal(data?.length, 1);
  const { data: me } = await guest.auth.getUser();
  assert.equal(data[0]!.updated_by, me.user!.id);
  await owner.from("notes").update({ content: editable.content }).eq("id", editable.id);
});

await check("demo-user-2 cannot edit the note shared read-only", async () => {
  const { data } = await guest.from("notes").update({ content: "hijacked" }).eq("id", readOnly.id).select();
  assert.deepEqual(data, []);
  assert.equal((await noteId("Team offsite ideas")).content, readOnly.content);
});

await check("demo-user-2 cannot delete a shared note, even with edit permission", async () => {
  const { data } = await guest.from("notes").delete().eq("id", editable.id).select();
  assert.deepEqual(data, []);
  assert.deepEqual(await titles(owner), ["Personal reminders", "Release checklist", "Team offsite ideas"]);
});

await check("demo-user-2 cannot reshare a note, directly or through share-note", async () => {
  const { data: target } = await outsider.from("profiles").select("id").single();
  const { error } = await guest.from("note_shares").insert({ note_id: editable.id, user_id: target!.id, permission: "edit" });
  assert.ok(error, "direct insert into note_shares should be rejected");
  const { data } = await guest.from("note_shares").update({ permission: "edit" }).eq("note_id", readOnly.id).select();
  assert.deepEqual(data, []);
  const { data: removed } = await guest.from("note_shares").delete().eq("note_id", readOnly.id).select();
  assert.deepEqual(removed, []);
  const res = await share(guest, editable.id, "verify-outsider@example.com", "edit");
  assert.equal(res.status, 403, res.message);
});

await check("a new user sees no notes, no shares and no other profiles", async () => {
  assert.deepEqual(await titles(outsider), []);
  assert.deepEqual((await outsider.from("note_shares").select()).data, []);
  assert.deepEqual((await outsider.from("profiles").select("email")).data, [{ email: "verify-outsider@example.com" }]);
  assert.equal((await outsider.from("notes").select().eq("id", personal.id)).data?.length, 0);
});

await check("share-note rejects an email that has no account in the app", async () => {
  const res = await share(owner, personal.id, "nobody@example.com");
  assert.equal(res.status, 404);
  assert.match(res.message, /no account/);
});

await check("share-note rejects a caller who is not the author", async () => {
  const res = await share(outsider, readOnly.id, "verify-outsider@example.com");
  assert.equal(res.status, 403, res.message);
});

await check("share-note rejects an anonymous call", async () => {
  const res = await fetch(`${app.supabase_url}/functions/v1/share-note`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ note_id: personal.id, email: "demo-user-2@example.com", permission: "read" }),
  });
  assert.equal(res.status, 401);
});

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exitCode = failures ? 1 : 0;
