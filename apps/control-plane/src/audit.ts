import { platform } from "./db.ts";

export async function audit(userId: string | null, appId: string | null, action: string, details: unknown = null) {
  await platform.query("insert into audit_log (user_id, app_id, action, details) values ($1, $2, $3, $4)", [
    userId,
    appId,
    action,
    details === null ? null : JSON.stringify(details),
  ]);
}
