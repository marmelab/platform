import { appRoles, studioClusterSql, studioDatabaseSql } from "@platform/sql";
import { type AppRow, appSecrets, dbId } from "../apps.ts";
import { appUrl, config, internalAppUrl, studioUrl } from "../config.ts";
import { many, runAll, withAdmin } from "../db.ts";
import type { Router } from "../router.ts";

/** Project record served to Studio: the fork's StoredProject (external mode) plus internal_url. */
export interface StudioProject {
  id: number;
  ref: string;
  name: string;
  organization_id: number;
  organization_slug: string;
  cloud_provider: string;
  status: string;
  region: string;
  inserted_at: string;
  public_url: string;
  internal_url: string;
  db_host: string;
  db_port: number;
  db_user: string;
  db_name: string;
  db_password: string;
  anon_key: string;
  service_key: string;
  jwt_secret: string;
}

export interface StudioRegistry {
  /** Makes an app browsable in Studio (database grants for the owner role). Idempotent. */
  register(app: AppRow): Promise<void>;
  unregister(slug: string): Promise<void>;
  /** Startup: Caddy route and registration of every existing app (backfill). */
  syncAll(apps: AppRow[]): Promise<void>;
  deepLink(slug: string): string;
  projects(): Promise<StudioProject[]>;
}

const STATUS: Record<string, string> = {
  running: "ACTIVE_HEALTHY",
  provisioning: "COMING_UP",
  error: "INACTIVE",
  stopped: "INACTIVE",
};

/**
 * Multi-head Studio (apps/studio): one Studio for every app, ref = slug. Studio pulls project configs from
 * GET /internal/studio/projects, so registering an app only prepares its owner role.
 */
export class MultiHeadStudio implements StudioRegistry {
  private readonly router: Router;

  constructor(router: Router) {
    this.router = router;
  }

  async register(app: AppRow) {
    const id = dbId(app.slug);
    await withAdmin("postgres", (c) => runAll(c, studioClusterSql(id)));
    await withAdmin(appRoles(id).database, (c) => runAll(c, studioDatabaseSql(id)));
  }

  async unregister(_slug: string) {
    // Nothing is stored on Studio's side: the app disappears from the next project fetch.
  }

  async syncAll(apps: AppRow[]) {
    await this.router.upsertStudio({
      host: config.studio.host,
      upstream: config.studio.upstream,
      forwardAuth: config.studio.forwardAuth,
      controlPlane: `control-plane:${config.port}`,
    });
    for (const app of apps) {
      await this.register(app).catch((error) => console.error(`studio register ${app.slug} failed`, error));
    }
  }

  deepLink(slug: string) {
    return studioUrl(`/project/${slug}`);
  }

  async projects(): Promise<StudioProject[]> {
    const apps = await many<AppRow & { studio_id: number }>(
      "select * from apps where status in ('running', 'provisioning', 'error', 'stopped') order by slug",
    );
    return apps.map((app) => {
      const secrets = appSecrets(app);
      const roles = appRoles(dbId(app.slug));
      return {
        id: app.studio_id,
        ref: app.slug,
        name: app.name,
        organization_id: 1,
        organization_slug: "default-org-slug",
        cloud_provider: "platform",
        status: STATUS[app.status] ?? "INACTIVE",
        region: "local",
        inserted_at: app.created_at.toISOString(),
        public_url: appUrl(app.slug),
        internal_url: internalAppUrl(app.slug),
        db_host: config.pg.host,
        db_port: config.pg.port,
        db_user: roles.owner,
        db_name: roles.database,
        db_password: secrets.passwords.owner,
        anon_key: secrets.anon_key,
        service_key: secrets.service_role_key,
        jwt_secret: "",
      };
    });
  }
}
