import type { MemberRole } from "@platform/shared";
import type pg from "pg";
import { type AppRow, studio, UserError } from "./apps.ts";
import { audit } from "./audit.ts";
import type { User } from "./auth.ts";
import { appUrl } from "./config.ts";
import { many, one, transaction } from "./db.ts";
import { sendPlatformMail } from "./mailer.ts";
import { memberMail } from "./member-mail.ts";

export type MemberAppRow = AppRow & { member_role: string };

/** Owner-only actions: managing members, stopping, starting and deleting the app. Admins can do everything. */
export function requireOwner(user: User, app: MemberAppRow, action: string) {
  if (user.role !== "admin" && app.member_role !== "owner") {
    throw new UserError(`only an owner of "${app.slug}" or an admin can ${action}`);
  }
}

export function listMembers(app: AppRow) {
  return many<{ email: string; name: string | null; role: MemberRole }>(
    `select u.email, u.name, m.role from app_members m join users u on u.id = m.user_id
      where m.app_id = $1 order by m.role = 'owner' desc, u.email`,
    [app.id],
  );
}

interface Member {
  id: string;
  email: string;
  active: boolean;
}

async function platformUser(email: string) {
  const user = await one<Member>("select id, email, active from users where email = $1", [
    email.toLowerCase(),
  ]);
  if (!user) throw new UserError(`no platform account for ${email}: an admin must create it first`);
  return user;
}

/**
 * Locks the app's memberships, refuses (with `check`) any change that would leave the app without an owner, and
 * returns the user's current role.
 */
async function guardLastOwner(c: pg.PoolClient, app: AppRow, userId: string, email: string, check = true) {
  const { rows } = await c.query<{ user_id: string; role: string }>(
    "select user_id, role from app_members where app_id = $1 for update",
    [app.id],
  );
  const owners = rows.filter((row) => row.role === "owner");
  if (check && owners.length === 1 && owners[0]!.user_id === userId) {
    throw new UserError(`${email} is the last owner of ${app.slug}: add another owner first, or delete the app`);
  }
  return rows.find((row) => row.user_id === userId)?.role;
}

/**
 * Emails the member about an addition, a role change or a removal (B7), through the platform SMTP. Not sent to a
 * disabled account, to the actor themselves, or without SMTP; a failure is logged and never fails the change.
 */
function notify(actor: User | null, app: AppRow, user: Member, previous?: MemberRole, next?: MemberRole) {
  if (!user.active || actor?.id === user.id) return Promise.resolve(false);
  const by = actor && (actor.name ? `${actor.name} (${actor.email})` : actor.email);
  const mail = memberMail({ name: app.name, url: appUrl(app.slug), studioUrl: studio.deepLink(app.slug) }, by, previous, next);
  return sendPlatformMail({ to: [user.email], ...mail }).catch((error) => {
    console.error(`member email to ${user.email} about ${app.slug} failed`, error);
    return false;
  });
}

/** Adds a member or changes their role; nothing happens (no email, no audit) when they already have that role. */
export async function addMember(actor: User | null, app: AppRow, email: string, role: MemberRole) {
  const user = await platformUser(email);
  const previous = await transaction(async (c) => {
    const current = await guardLastOwner(c, app, user.id, user.email, role !== "owner");
    if (current !== role) {
      await c.query(
        `insert into app_members (app_id, user_id, role) values ($1, $2, $3)
         on conflict (app_id, user_id) do update set role = excluded.role`,
        [app.id, user.id, role],
      );
    }
    return current as MemberRole | undefined;
  });
  if (previous !== role) {
    const sent = await notify(actor, app, user, previous, role);
    await audit(actor?.id ?? null, app.id, "add_member", { email: user.email, role, previous_role: previous ?? null, email_sent: sent });
  }
  return listMembers(app);
}

export async function removeMember(actor: User | null, app: AppRow, email: string) {
  const user = await platformUser(email);
  const removed = await transaction(async (c) => {
    const role = await guardLastOwner(c, app, user.id, user.email);
    if (role) await c.query("delete from app_members where app_id = $1 and user_id = $2", [app.id, user.id]);
    return role;
  });
  if (removed) {
    const sent = await notify(actor, app, user, removed as MemberRole);
    await audit(actor?.id ?? null, app.id, "remove_member", { email: user.email, role: removed, email_sent: sent });
  }
  return { removed: Boolean(removed), members: await listMembers(app) };
}
