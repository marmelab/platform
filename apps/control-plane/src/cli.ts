// Admin CLI, run inside the control-plane container:
//   node src/cli.ts init
//   node src/cli.ts create-user <email> [admin|developer] [token-name]   -> prints a new PAT
//   node src/cli.ts set-password <email>        (password read from stdin: docker exec -i ... < file)
//   node src/cli.ts set-password <email> --generate                     -> prints a generated password
//   node src/cli.ts add-member <slug> <email> [owner|developer]
//   node src/cli.ts delete-app <slug>
import { randomBytes } from "node:crypto";
import { text } from "node:stream/consumers";
import { deleteApp } from "./apps.ts";
import { createToken, upsertUser } from "./auth.ts";
import { one, platform } from "./db.ts";
import { initCluster } from "./init.ts";
import { setPassword } from "./sessions.ts";

const USAGE = "usage: cli.ts init | create-user <email> [admin|developer] [token-name] | " +
  "set-password <email> [--generate] | add-member <slug> <email> [owner|developer] | delete-app <slug>";

const [command, ...args] = process.argv.slice(2);

if (command === "init") {
  await initCluster();
  console.log("cluster initialised");
} else if (command === "create-user") {
  const [email, role = "developer", tokenName = "default"] = args;
  if (!email || !["admin", "developer"].includes(role)) throw new Error("usage: create-user <email> [admin|developer]");
  const user = await upsertUser(email, role as "admin" | "developer");
  console.log(await createToken(user.id, tokenName));
} else if (command === "set-password" && args[0]) {
  const generate = args[1] === "--generate";
  const password = generate ? randomBytes(18).toString("base64url") : (await text(process.stdin)).trim();
  await setPassword(args[0], password);
  console.log(generate ? password : `password set for ${args[0]}`);
} else if (command === "add-member" && args[0] && args[1]) {
  const [slug, email, role = "developer"] = args;
  if (!["owner", "developer"].includes(role)) throw new Error("role must be owner or developer");
  const row = await one<{ slug: string }>(
    `insert into app_members (app_id, user_id, role)
     select a.id, u.id, $3 from apps a, users u where a.slug = $1 and u.email = $2
     on conflict (app_id, user_id) do update set role = excluded.role
     returning (select slug from apps where slug = $1) as slug`,
    [slug, email.toLowerCase(), role],
  );
  if (!row) throw new Error(`unknown app ${slug} or user ${email}`);
  console.log(`${email} is ${role} of ${slug}`);
} else if (command === "delete-app" && args[0]) {
  await deleteApp(args[0]);
  console.log(`app ${args[0]} deleted`);
} else {
  console.error(USAGE);
  process.exitCode = 1;
}
await platform.end();
