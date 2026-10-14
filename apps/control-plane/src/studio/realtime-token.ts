import { appForUser, appSecrets, UserError } from "../apps.ts";
import { audit } from "../audit.ts";
import type { User } from "../auth.ts";
import { signJwt } from "../crypto.ts";
import { one } from "../db.ts";

export const REALTIME_TOKEN_SECONDS = 600;

/**
 * A short-lived JWT for Studio's Realtime Inspector (TECH_DEBT, accepted trade-offs): role service_role, so that the
 * inspector sees every broadcast, presence and database change of the app, as its owner role already does in SQL.
 * Only for an active account that is a member of the app (or an admin), on a running app. Audited.
 */
export async function realtimeInspectorToken(email: string, slug: string) {
  const user = await one<User>("select id, email, name, role from users where email = $1 and active", [email]);
  if (!user) throw new UserError("unknown or disabled account");
  const app = await appForUser(user, slug);
  if (app.status !== "running") throw new UserError(`app "${slug}" is ${app.status}`);
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + REALTIME_TOKEN_SECONDS;
  const token = signJwt(
    { iss: "platform-studio", ref: slug, role: "service_role", iat, exp },
    appSecrets(app).jwt_secret,
  );
  await audit(user.id, app.id, "studio_realtime_token", { role: "service_role", expires_at: new Date(exp * 1000) });
  return { token, expires_in: REALTIME_TOKEN_SECONDS };
}
