import { createClient } from "@supabase/supabase-js";
import { inject } from "vitest";
import { TEST_EMAIL_DOMAIN } from "./global-setup";

const { url, anonKey, serviceRoleKey } = inject("supabase");
const options = { auth: { persistSession: false, autoRefreshToken: false } };

/** A signed-out visitor. */
export const anonClient = () => createClient(url, anonKey, options);

/** Bypasses row level security: only to arrange data no user could create. */
export const adminClient = () => createClient(url, serviceRoleKey, options);

/** A new user, signed in on their own client. Deleted after the run. */
export async function newUser() {
  const email = `${crypto.randomUUID()}@${TEST_EMAIL_DOMAIN}`;
  const password = crypto.randomUUID();
  const { data, error } = await adminClient().auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  const client = anonClient();
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;
  return { id: data.user.id, email, client };
}
