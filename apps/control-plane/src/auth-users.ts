import { type AppRow, appSecrets, containerName, requireWritable, UserError } from "./apps.ts";
import { audit } from "./audit.ts";
import { appUrl } from "./config.ts";
import type { User } from "./auth.ts";
import { signJwt } from "./crypto.ts";
import { getSettings } from "./settings.ts";
import { withOwner } from "./sql.ts";

/**
 * B5: the app's own users (its GoTrue), managed by any member of the app or an admin (rights checked by the caller
 * through appForUser). Reads go to `auth.users` as the owner role (as Studio's Auth > Users), so they also work on a
 * stopped app; writes go through GoTrue's admin API and are refused on a stopped app (its GoTrue is stopped too).
 */

export interface AuthUser {
  id: string;
  email: string | null;
  created_at: Date;
  last_sign_in_at: Date | null;
  invited_at: Date | null;
  confirmed: boolean;
  banned: boolean;
  banned_until: Date | null;
}

const USER_COLUMNS = `id, email, created_at, last_sign_in_at, invited_at, email_confirmed_at is not null as confirmed,
  coalesce(banned_until > now(), false) as banned, banned_until`;

/** Validity of GoTrue's invite links: GOTRUE_MAILER_OTP_EXP, left at its default (24 h). */
const INVITE_VALIDITY = "24 hours, single use";
/** ban_user without a duration: GoTrue takes a Go duration, 100 years means indefinitely. */
export const BAN_FOREVER_HOURS = 876_000;

const likePattern = (value: string) => `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export async function listAuthUsers(
  app: AppRow,
  { page, perPage, filter }: { page: number; perPage: number; filter?: string },
) {
  return withOwner(app, async (c) => {
    const where = filter ? "where email ilike $1" : "";
    const params = filter ? [likePattern(filter)] : [];
    const total = (await c.query<{ n: number }>(`select count(*)::int as n from auth.users ${where}`, params)).rows[0]!.n;
    const { rows } = await c.query<AuthUser>(
      `select ${USER_COLUMNS} from auth.users ${where}
        order by created_at desc, id limit ${perPage} offset ${(page - 1) * perPage}`,
      params,
    );
    return { users: rows, page, per_page: perPage, total };
  });
}

/** One user of the app, by id or email (exactly one of them). */
async function findAuthUser(app: AppRow, ref: { user_id?: string; email?: string }) {
  if (Boolean(ref.user_id) === Boolean(ref.email)) throw new UserError("pass either user_id or email");
  const rows = await withOwner(app, async (c) =>
    (await c.query<AuthUser>(
      `select ${USER_COLUMNS} from auth.users where ${ref.user_id ? "id = $1" : "lower(email) = lower($1)"}`,
      [ref.user_id ?? ref.email],
    )).rows);
  if (rows.length === 0) throw new UserError(`no user ${ref.user_id ?? ref.email} in the app "${app.slug}"`);
  if (rows.length > 1) throw new UserError(`several users have the email ${ref.email}: pass user_id`);
  return rows[0]!;
}

/** GoTrue's admin API, reached directly on the app network with a service_role JWT valid one minute. */
async function gotrueAdmin(app: AppRow, method: string, path: string, body?: unknown) {
  const iat = Math.floor(Date.now() / 1000);
  const claims = { iss: "supabase", ref: app.slug, role: "service_role", iat, exp: iat + 60 };
  const token = signJwt(claims, appSecrets(app).jwt_secret);
  let response: Response;
  try {
    response = await fetch(`http://${containerName(app.slug, "auth")}:9999${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new UserError(`the Auth service (GoTrue) of "${app.slug}" is unreachable (app status: ${app.status}): ${error}`);
  }
  const text = await response.text();
  const json = (() => {
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  })();
  if (!response.ok) {
    const message = json?.msg ?? json?.message ?? json?.error_description ?? text.slice(0, 500);
    const error = `GoTrue ${method} ${path.split("?")[0]}: ${response.status} ${message}`;
    // 4xx: the request (existing email, invalid address...); 5xx: GoTrue itself
    throw response.status < 500 ? new UserError(error) : new Error(error);
  }
  return json;
}

/**
 * With the platform SMTP (M6), GoTrue's `/invite` creates the user (unconfirmed, `invited_at` set) and emails the
 * invitation itself: the link is never returned. Without SMTP, `/admin/generate_link` with type `invite` creates the
 * user the same way and returns the link instead of mailing it; the caller hands it to the person. Either way, opening
 * the link confirms the address, signs the person in and redirects to the app (GOTRUE_SITE_URL) with the session in
 * the URL fragment. The link is never audited.
 */
export async function inviteUser(actor: User, app: AppRow, email: string) {
  requireWritable(app, "invite_user");
  const { smtp } = await getSettings();
  if (smtp) {
    const invited = await gotrueAdmin(app, "POST", "/invite", { email });
    if (!invited?.id) throw new Error(`GoTrue invite: unexpected response for ${email}`);
    const user = await findAuthUser(app, { user_id: invited.id });
    await audit(actor.id, app.id, "invite_user", { email: user.email, user_id: user.id, email_sent: true });
    return {
      user,
      email_sent: true,
      note: `An invitation email was sent to ${user.email}. Its link is valid ${INVITE_VALIDITY}; opening it confirms ` +
        "the address, signs the person in and redirects to the app, which must then let them set a password " +
        "(supabase.auth.updateUser) unless it signs users in with magic links. Inviting again sends a new email.",
    };
  }
  const result = await gotrueAdmin(app, "POST", "/admin/generate_link", { type: "invite", email });
  const properties = result?.properties ?? result;
  const id: string | undefined = result?.user?.id ?? result?.id;
  if (!properties?.hashed_token || !id) throw new Error(`GoTrue generate_link: unexpected response for ${email}`);
  // built on the app's public /auth/v1 (as the emailed links: GOTRUE_MAILER_URLPATHS_*, app-auth.ts)
  const link = new URL(`${appUrl(app.slug)}/auth/v1/verify`);
  link.searchParams.set("token", properties.hashed_token);
  link.searchParams.set("type", "invite");
  link.searchParams.set("redirect_to", properties.redirect_to || appUrl(app.slug));
  const user = await findAuthUser(app, { user_id: id });
  await audit(actor.id, app.id, "invite_user", { email: user.email, user_id: user.id, email_sent: false });
  return {
    user,
    invite_link: link.toString(),
    email_sent: false,
    note: "No email is sent (the platform has no SMTP configured): give this link to the person yourself, " +
      `over a private channel. Valid ${INVITE_VALIDITY}. Opening it confirms the address, signs the person in and ` +
      "redirects to the app; the app must then let them set a password (supabase.auth.updateUser) unless it signs " +
      "users in with magic links.",
  };
}

export async function deleteUser(actor: User, app: AppRow, ref: { user_id?: string; email?: string }) {
  requireWritable(app, "delete_user");
  const user = await findAuthUser(app, ref);
  await gotrueAdmin(app, "DELETE", `/admin/users/${user.id}`, { should_soft_delete: false });
  await audit(actor.id, app.id, "delete_user", { email: user.email, user_id: user.id });
  return { deleted: true, id: user.id, email: user.email };
}

/** GoTrue `ban_duration`: a banned user cannot sign in nor refresh a session until it expires. */
export async function setBan(actor: User, app: AppRow, ref: { user_id?: string; email?: string }, hours: number | null) {
  const action = hours === null ? "unban_user" : "ban_user";
  requireWritable(app, action);
  const user = await findAuthUser(app, ref);
  await gotrueAdmin(app, "PUT", `/admin/users/${user.id}`, { ban_duration: hours === null ? "none" : `${hours}h` });
  await audit(actor.id, app.id, action, { email: user.email, user_id: user.id, ...(hours === null ? {} : { hours }) });
  return findAuthUser(app, { user_id: user.id });
}
