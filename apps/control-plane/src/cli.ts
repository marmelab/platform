// Admin CLI, run inside the control-plane container:
//   node src/cli.ts init
//   node src/cli.ts create-user <email> [admin|developer] [token-name]   -> prints a new PAT
//   node src/cli.ts delete-user <email>         (also deletes the user's sessions, tokens and memberships)
//   node src/cli.ts set-password <email>        (password read from stdin: docker exec -i ... < file)
//   node src/cli.ts set-password <email> --generate                     -> prints a generated password
//   node src/cli.ts add-member <slug> <email> [owner|collaborator]
//   node src/cli.ts remove-member <slug> <email>   (idempotent, refuses to remove the last owner)
//   node src/cli.ts stop-app <slug>            (maintenance page, containers stopped)
//   node src/cli.ts start-app <slug>
//   node src/cli.ts delete-app <slug>
import { randomBytes } from "node:crypto";
import { text } from "node:stream/consumers";
import type { MemberRole } from "@platform/shared";
import { type AppRow, deleteApp, startApp, stopApp } from "./apps.ts";
import { createToken, upsertUser } from "./auth.ts";
import { one, platform } from "./db.ts";
import { initCluster } from "./init.ts";
import { addMember, removeMember } from "./members.ts";
import { setPassword } from "./sessions.ts";

const USAGE = "usage: cli.ts init | create-user <email> [admin|developer] [token-name] | delete-user <email> | " +
  "set-password <email> [--generate] | add-member <slug> <email> [owner|collaborator] | remove-member <slug> <email> | stop-app <slug> | start-app <slug> | delete-app <slug>";

const [command, ...args] = process.argv.slice(2);

async function appBySlug(slug: string) {
  const app = await one<AppRow>("select * from apps where slug = $1", [slug]);
  if (!app) throw new Error(`unknown app ${slug}`);
  return app;
}

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
  await addMember(null, await appBySlug(slug), email, role as MemberRole);
  console.log(`${email} is ${role} of ${slug}`);
} else if (command === "remove-member" && args[0] && args[1]) {
  const [slug, email] = args;
  const { removed } = await removeMember(null, await appBySlug(slug), email);
  console.log(removed ? `${email} removed from ${slug}` : `${email} is not a member of ${slug}`);
} else if (command === "stop-app" && args[0]) {
  const { changed } = await stopApp(null, await appBySlug(args[0]));
  console.log(changed ? `app ${args[0]} stopped` : `app ${args[0]} is already stopped`);
} else if (command === "start-app" && args[0]) {
  const { changed } = await startApp(null, await appBySlug(args[0]));
  console.log(changed ? `app ${args[0]} started` : `app ${args[0]} is already running`);
} else if (command === "delete-app" && args[0]) {
  await deleteApp(args[0]);
  console.log(`app ${args[0]} deleted`);
} else {
  console.error(USAGE);
  process.exitCode = 1;
}
await platform.end();
