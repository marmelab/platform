import { type AppRow, requireWritable, UserError, writeEdgeConfig } from "./apps.ts";
import { audit } from "./audit.ts";
import type { User } from "./auth.ts";
import { encrypt } from "./crypto.ts";
import { many, platform } from "./db.ts";

const RESERVED = /^(SUPABASE_|SB_|PLATFORM_|DENO_)/;

export async function setSecrets(user: User, app: AppRow, secrets: Record<string, string | null>) {
  requireWritable(app, "set_secrets");
  const reserved = Object.keys(secrets).filter((name) => RESERVED.test(name));
  if (reserved.length) throw new UserError(`reserved secret names: ${reserved.join(", ")}`);
  for (const [name, value] of Object.entries(secrets)) {
    if (value === null) {
      await platform.query("delete from app_secrets where app_id = $1 and name = $2", [app.id, name]);
    } else {
      await platform.query(
        `insert into app_secrets (app_id, name, value_enc) values ($1, $2, $3)
         on conflict (app_id, name) do update set value_enc = excluded.value_enc, updated_at = now()`,
        [app.id, name, encrypt(value)],
      );
    }
  }
  await writeEdgeConfig(app);
  await audit(user.id, app.id, "set_secrets", { names: Object.keys(secrets) });
  return listSecrets(app);
}

export function listSecrets(app: AppRow) {
  return many<{ name: string; updated_at: Date }>(
    "select name, updated_at from app_secrets where app_id = $1 order by name",
    [app.id],
  );
}
