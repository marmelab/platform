// Admin CLI, run inside the control-plane container:
//   node src/cli.ts init
//   node src/cli.ts create-user <email> [admin|developer] [token-name]   -> prints a new PAT
import { createToken, upsertUser } from "./auth.ts";
import { platform } from "./db.ts";
import { initCluster } from "./init.ts";

const [command, ...args] = process.argv.slice(2);

if (command === "init") {
  await initCluster();
  console.log("cluster initialised");
} else if (command === "create-user") {
  const [email, role = "developer", tokenName = "default"] = args;
  if (!email || !["admin", "developer"].includes(role)) throw new Error("usage: create-user <email> [admin|developer]");
  const user = await upsertUser(email, role as "admin" | "developer");
  console.log(await createToken(user.id, tokenName));
} else {
  console.error("usage: cli.ts init | create-user <email> [admin|developer] [token-name]");
  process.exitCode = 1;
}
await platform.end();
