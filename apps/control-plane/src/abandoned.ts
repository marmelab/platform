// Abandoned apps (A6): an app whose last activity (last request, last release, creation, or the first metrics sample,
// whichever is latest) is older than the `abandoned_after_days` setting. The admin console shows the flag
// (admin/api.ts); the owners are emailed once per transition (M6), checked after every metrics sample (metrics.ts).
import { appUrl } from "./config.ts";
import { audit } from "./audit.ts";
import { many, one, platform } from "./db.ts";
import { sendPlatformMail } from "./mailer.ts";
import { getSettings } from "./settings.ts";

export const DAY_MS = 86_400_000;

export const isAbandoned = (lastActivity: Date, abandonedAfterDays: number, now = Date.now()) =>
  now - lastActivity.getTime() > abandonedAfterDays * DAY_MS;

interface AppActivity {
  id: string;
  slug: string;
  name: string;
  status: string;
  abandoned_notified_at: Date | null;
  last_activity_at: Date;
}

export function abandonedMail(app: { slug: string; name: string }, lastActivity: Date, days: number) {
  const date = lastActivity.toISOString().slice(0, 10);
  return {
    subject: `Your app "${app.name}" (${app.slug}) looks abandoned`,
    text: [
      "Hello,",
      "",
      `The app "${app.name}" (${appUrl(app.slug)}) has received no request and no deployment since ${date} ` +
      `(more than ${days} days). It is now flagged as abandoned in the platform's admin console: an admin may put it ` +
      "to sleep (stop it) or delete it after a final backup.",
      "",
      "If the app is still needed, use it or deploy it again: the flag goes away with the next request or release. " +
      "Otherwise, you can stop or delete it yourself (ask Claude: stop_app, delete_app), or tell your platform admin.",
      "",
      "You receive this email because you are an owner of the app.",
    ].join("\n"),
  };
}

/**
 * Emails the owners of every app that became abandoned since the last check, once: `apps.abandoned_notified_at`
 * records it, and is cleared when the app is active again (its next abandonment is notified again). Stopped apps are
 * not notified (someone already acted). Without SMTP nothing is sent nor recorded: the owners are notified once an
 * admin configures it. Returns the notified slugs.
 */
export async function notifyAbandonedApps(): Promise<{ notified: string[]; failed: string[]; smtp: boolean }> {
  const settings = await getSettings();
  const state = await one<{ started_at: Date }>("select started_at from metrics_state where id = 1");
  const apps = await many<AppActivity>(
    `select a.id, a.slug, a.name, a.status, a.abandoned_notified_at,
        greatest(a.last_request_at, (select max(r.started_at) from releases r where r.app_id = a.id), a.created_at,
          $1::timestamptz) as last_activity_at
       from apps a where a.status <> 'deleted'`,
    [state?.started_at ?? new Date()],
  );
  const days = settings.abandonedAfterDays;
  const active = apps.filter((a) => a.abandoned_notified_at && !isAbandoned(a.last_activity_at, days));
  if (active.length) {
    await platform.query("update apps set abandoned_notified_at = null where id = any($1)", [active.map((a) => a.id)]);
  }
  const notified: string[] = [];
  const failed: string[] = [];
  if (!settings.smtp) return { notified, failed, smtp: false };
  for (const app of apps) {
    if (app.status === "stopped" || app.abandoned_notified_at || !isAbandoned(app.last_activity_at, days)) continue;
    // claimed first: two samplers (the timer and the CLI) never both send
    const claimed = await one("update apps set abandoned_notified_at = now() where id = $1 and abandoned_notified_at is null returning id", [app.id]);
    if (!claimed) continue;
    const owners = (await many<{ email: string }>(
      `select u.email from app_members m join users u on u.id = m.user_id
        where m.app_id = $1 and m.role = 'owner' and u.active order by u.email`,
      [app.id],
    )).map((o) => o.email);
    try {
      const mail = abandonedMail(app, app.last_activity_at, days);
      await sendPlatformMail({ to: owners, ...mail }, settings.smtp);
      await audit(null, app.id, "notify_abandoned", {
        slug: app.slug,
        recipients: owners,
        last_activity_at: app.last_activity_at,
        abandoned_after_days: days,
      });
      notified.push(app.slug);
    } catch (error) {
      console.error(`abandoned notice of ${app.slug} failed`, error);
      await platform.query("update apps set abandoned_notified_at = null where id = $1", [app.id]);
      failed.push(app.slug);
    }
  }
  return { notified, failed, smtp: true };
}
