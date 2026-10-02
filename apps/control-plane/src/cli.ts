// Admin CLI, run inside the control-plane container:
//   node src/cli.ts init
//   node src/cli.ts create-user <email> [admin|developer] [token-name]   -> prints a new PAT
//   node src/cli.ts delete-user <email>         (also deletes the user's sessions, tokens and memberships)
//   node src/cli.ts set-password <email>        (password read from stdin: docker exec -i ... < file)
//   node src/cli.ts set-password <email> --generate                     -> prints a generated password
//   node src/cli.ts add-member <slug> <email> [owner|collaborator]
//   node src/cli.ts remove-member <slug> <email>   (idempotent, refuses to remove the last owner)
//   node src/cli.ts delete-app <slug>
import { randomBytes } from "node:crypto";
import { text } from "node:stream/consumers";
import { deleteApp } from "./apps.ts";
import { audit } from "./audit.ts";
import { createToken, upsertUser } from "./auth.ts";
import { one, platform } from "./db.ts";
import { initCluster } from "./init.ts";
import { setPassword } from "./sessions.ts";

const USAGE = "usage: cli.ts init | create-user <email> [admin|developer] [token-name] | delete-user <email> | " +
  "set-password <email> [--generate] | add-member <slug> <email> [owner|collaborator] | remove-member <slug> <email> | delete-app <slug>";

const [command, ...args] = process.argv.slice(2);

if (command === "init") {
  await initCluster();
  console.log("cluster initialised");
} else if (command === "create-user") {
  const [email, role = "developer", tokenName = "default"] = args;
  if (!email || !["admin", "developer"].includes(role)) throw new Error("usage: create-user <email> [admin|developer]");
  const user = await upsertUser(email, role as "admin" | "developer");
  console.log(await createToken(user.id, tokenName));
} else if (command === "delete-user" && args[0]) {
  const deleted = await one<{ id: string }>("delete from users where email = $1 returning id", [args[0].toLowerCase()]);
  if (!deleted) throw new Error(`unknown user ${args[0]}`);
  console.log(`user ${args[0]} deleted`);
} else if (command === "set-password" && args[0]) {
  const generate = args[1] === "--generate";
  const password = generate ? randomBytes(18).toString("base64url") : (await text(process.stdin)).trim();
  await setPassword(args[0], password);
  console.log(generate ? password : `password set for ${args[0]}`);
} else if (command === "add-member" && args[0] && args[1]) {
  const [slug, email, role = "collaborator"] = args;
  if (!["owner", "collaborator"].includes(role)) throw new Error("role must be owner or collaborator");
  const row = await one<{ slug: string }>(
    `insert into app_members (app_id, user_id, role)
     select a.id, u.id, $3 from apps a, users u where a.slug = $1 and u.email = $2
     on conflict (app_id, user_id) do update set role = excluded.role
     returning (select slug from apps where slug = $1) as slug`,
    [slug, email.toLowerCase(), role],
  );
  if (!row) throw new Error(`unknown app ${slug} or user ${email}`);
  console.log(`${email} is ${role} of ${slug}`);
} else if (command === "remove-member" && args[0] && args[1]) {
  const [slug, email] = args;
  const app = await one<{ id: string }>("select id from apps where slug = $1", [slug]);
  if (!app) throw new Error(`unknown app ${slug}`);
  const user = await one<{ id: string }>("select id from users where email = $1", [email.toLowerCase()]);
  if (!user) throw new Error(`unknown user ${email}`);
  const client = await platform.connect();
  let removed: string | undefined;
  try {
    await client.query("begin");
    const { rows } = await client.query<{ user_id: string; role: string }>(
      "select user_id, role from app_members where app_id = $1 for update",
      [app.id],
    );
    const member = rows.find((row) => row.user_id === user.id);
    if (member?.role === "owner" && rows.filter((row) => row.role === "owner").length === 1) {
      throw new Error(`${email} is the last owner of ${slug}: add another owner first, or delete the app`);
    }
    if (member) await client.query("delete from app_members where app_id = $1 and user_id = $2", [app.id, user.id]);
    await client.query("commit");
    removed = member?.role;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
  if (removed) await audit(null, app.id, "remove_member", { email: email.toLowerCase(), role: removed });
  console.log(removed ? `${email} removed from ${slug}` : `${email} is not a member of ${slug}`);
} else if (command === "delete-app" && args[0]) {
  await deleteApp(args[0]);
  console.log(`app ${args[0]} deleted`);
} else {
  console.error(USAGE);
  process.exitCode = 1;
}
await platform.end();
