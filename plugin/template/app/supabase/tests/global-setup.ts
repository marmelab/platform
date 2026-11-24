// Data tests: the URL and keys of the local Supabase, from `supabase status`. Never another instance: the tests
// create users, and delete them at the end so they do not show in the preview.
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import type { TestProject } from "vitest/node";

export const TEST_EMAIL_DOMAIN = "example.test";

type LocalSupabase = { url: string; anonKey: string; serviceRoleKey: string };

declare module "vitest" {
  export interface ProvidedContext {
    supabase: LocalSupabase;
  }
}

function localSupabase(): LocalSupabase {
  let status: string;
  try {
    status = execFileSync("supabase", ["status", "-o", "env"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    // failing, not skipping: a deployment must not pass with its data tests left out
    throw new Error("the local Supabase is not running: run `supabase start`, then the tests again");
  }
  const env = Object.fromEntries([...status.matchAll(/^(\w+)="(.*)"$/gm)].map(([, key, value]) => [key, value]));
  const url = env.API_URL ?? "";
  if (!URL.canParse(url) || !["127.0.0.1", "localhost"].includes(new URL(url).hostname)) {
    throw new Error(`supabase status gave ${url || "no API_URL"}, not a local Supabase`);
  }
  return { url, anonKey: env.ANON_KEY, serviceRoleKey: env.SERVICE_ROLE_KEY };
}

async function deleteTestUsers({ url, serviceRoleKey }: LocalSupabase) {
  const admin = createClient(url, serviceRoleKey, { auth: { persistSession: false } }).auth.admin;
  const { data, error } = await admin.listUsers({ perPage: 10000 });
  if (error) throw error;
  for (const user of data.users.filter((u) => u.email?.endsWith(`@${TEST_EMAIL_DOMAIN}`))) {
    const { error } = await admin.deleteUser(user.id);
    // a foreign key to users without `on delete cascade`: the platform could not delete a real user either
    if (error) throw new Error(`could not delete the test user ${user.email}: ${error.message}`);
  }
}

export default function setup(project: TestProject) {
  const supabase = localSupabase();
  project.provide("supabase", supabase);
  return () => deleteTestUsers(supabase);
}
