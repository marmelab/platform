import type { MemberRole } from "@platform/shared";
import type pg from "pg";
import { type AppRow, UserError } from "./apps.ts";
import { audit } from "./audit.ts";
import type { User } from "./auth.ts";
import { many, one, transaction } from "./db.ts";

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

async function platformUser(email: string) {
  const user = await one<{ id: string; email: string }>("select id, email from users where email = $1", [
    email.toLowerCase(),
  ]);
  if (!user) throw new UserError(`no platform account for ${email}: an admin must create it first`);
  return user;
}

/** Locks the app's memberships and refuses any change that would leave the app without an owner. */
async function guardLastOwner(c: pg.PoolClient, app: AppRow, userId: string, email: string) {
  const { rows } = await c.query<{ user_id: string; role: string }>(
    "select user_id, role from app_members where app_id = $1 for update",
    [app.id],
  );
  const owners = rows.filter((row) => row.role === "owner");
  if (owners.length === 1 && owners[0]!.user_id === userId) {
    throw new UserError(`${email} is the last owner of ${app.slug}: add another owner first, or delete the app`);
  }
  return rows.find((row) => row.user_id === userId)?.role;
}

export async function addMember(actor: User | null, app: AppRow, email: string, role: MemberRole) {
  const user = await platformUser(email);
  await transaction(async (c) => {
    if (role !== "owner") await guardLastOwner(c, app, user.id, user.email);
    await c.query(
      `insert into app_members (app_id, user_id, role) values ($1, $2, $3)
       on conflict (app_id, user_id) do update set role = excluded.role`,
      [app.id, user.id, role],
    );
  });
  await audit(actor?.id ?? null, app.id, "add_member", { email: user.email, role });
  return listMembers(app);
}

export async function removeMember(actor: User | null, app: AppRow, email: string) {
  const user = await platformUser(email);
  const removed = await transaction(async (c) => {
    const role = await guardLastOwner(c, app, user.id, user.email);
    if (role) await c.query("delete from app_members where app_id = $1 and user_id = $2", [app.id, user.id]);
    return role;
  });
  if (removed) await audit(actor?.id ?? null, app.id, "remove_member", { email: user.email, role: removed });
  return { removed: Boolean(removed), members: await listMembers(app) };
}
