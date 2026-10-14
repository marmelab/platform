// Company SSO settings (M6 part 2, journey A7): the OpenID Connect provider of the platform's logins (Studio and this
// console) and of the apps that enable company SSO (configure_auth). GET/PUT /api/sso; the client secret is write-only.
import { useCallback, useEffect, useState } from "react";
import { Form, required, useNotify } from "ra-core";
import { BooleanInput } from "@/components/admin/boolean-input";
import { SelectInput } from "@/components/admin/select-input";
import { TextInput } from "@/components/admin/text-input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "../providers";

interface SsoRecord {
  enabled: boolean;
  configured: boolean;
  active: boolean;
  name: string;
  issuer: string | null;
  discovery_url: string | null;
  client_id: string | null;
  client_secret_set: boolean;
  allowed_domains: string[];
  require_verified_email: boolean;
  auto_create: "off" | "developer";
  password_login: "everyone" | "admins";
  redirect_uris: { studio: string; admin: string; apps: string };
  apps_using_sso: number;
  apps_sync?: { apps: number; failed: { app: string; error: string }[] } | null;
}

const AUTO_CREATE = [
  { id: "off", name: "Existing accounts only (an admin creates them)" },
  { id: "developer", name: "Create unknown users as developers" },
];
const PASSWORD_LOGIN = [
  { id: "everyone", name: "Everyone may also use a password" },
  { id: "admins", name: "Admins only (break-glass): builders use SSO" },
];

const defaultDiscoveryUrl = (issuer: string | null) =>
  issuer ? `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration` : null;

export const SsoSettings = () => {
  const [record, setRecord] = useState<SsoRecord | null>(null);
  const [saving, setSaving] = useState(false);
  const notify = useNotify();
  const load = useCallback(() => {
    api<SsoRecord>("/sso").then(setRecord, (error: Error) => notify(error.message, { type: "error" }));
  }, [notify]);
  useEffect(load, [load]);
  if (!record) return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;

  const save = async (values: Record<string, unknown>) => {
    setSaving(true);
    try {
      const saved = await api<SsoRecord>("/sso", {
        method: "PUT",
        body: {
          enabled: values.enabled,
          name: values.name,
          issuer: values.issuer ?? "",
          discovery_url: values.discovery_url || null,
          client_id: values.client_id ?? "",
          client_secret: values.client_secret || undefined,
          allowed_domains: String(values.allowed_domains ?? "").split(",").map((d) => d.trim()).filter(Boolean),
          require_verified_email: values.require_verified_email,
          auto_create: values.auto_create,
          password_login: values.password_login,
        },
      });
      setRecord(saved);
      const failed = saved.apps_sync?.failed ?? [];
      notify(
        failed.length
          ? `Saved, but the company SSO of ${failed.map((f) => f.app).join(", ")} could not be updated`
          : "SSO settings saved",
        { type: failed.length ? "warning" : "success" },
      );
    } catch (error) {
      notify((error as Error).message || "Save failed", { type: "error" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <h1 className="text-2xl font-semibold">Company SSO</h1>
        <p className="text-sm text-muted-foreground">
          OpenID Connect provider for signing in to Studio and to this console, and for the apps whose builders enable
          company SSO. Status: <strong data-testid="sso-status">{record.active ? "active" : record.enabled ? "enabled, incomplete" : "off"}</strong>
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Provider</CardTitle>
        </CardHeader>
        <CardContent>
          <Form
            record={{
              ...record,
              issuer: record.issuer ?? "",
              // the issuer's default is left empty: it follows the issuer instead of becoming an override
              discovery_url: record.discovery_url === defaultDiscoveryUrl(record.issuer) ? "" : record.discovery_url ?? "",
              client_id: record.client_id ?? "",
              client_secret: "",
              allowed_domains: record.allowed_domains.join(", "),
            }}
            onSubmit={save}
            className="flex max-w-2xl flex-col gap-4"
          >
            <BooleanInput source="enabled" label="Enabled" helperText="Checked against the issuer's discovery document when saved" />
            <TextInput source="name" label="Button label" helperText='Shown as "Sign in with …"' validate={required()} />
            <TextInput source="issuer" label="Issuer" helperText="e.g. https://login.microsoftonline.com/<tenant>/v2.0" />
            <TextInput
              source="discovery_url"
              label="Discovery URL (optional)"
              helperText="Defaults to <issuer>/.well-known/openid-configuration; only used by the platform's own logins"
            />
            <TextInput source="client_id" label="Client ID" />
            <TextInput
              source="client_secret"
              label="Client secret"
              type="password"
              autoComplete="new-password"
              helperText={record.client_secret_set ? "Set. Leave empty to keep it" : "Not set"}
            />
            <TextInput
              source="allowed_domains"
              label="Allowed email domains"
              helperText="Comma-separated; empty: any address the identity provider vouches for"
            />
            <BooleanInput
              source="require_verified_email"
              label="Require email_verified"
              helperText="Turn off only for providers that never send it (Entra ID)"
            />
            <SelectInput source="auto_create" label="Unknown users" choices={AUTO_CREATE} validate={required()} />
            <SelectInput source="password_login" label="Password sign-in" choices={PASSWORD_LOGIN} validate={required()} />
            <div>
              <Button type="submit" disabled={saving}>Save</Button>
            </div>
          </Form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Redirect URIs to register at the identity provider</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1 text-sm">
          <code>{record.redirect_uris.studio}</code>
          <code>{record.redirect_uris.admin}</code>
          <code>{record.redirect_uris.apps}</code>
          <p className="mt-2 text-muted-foreground">
            The last one for each app that enables company SSO ({record.apps_using_sso} today), as its builder sees it in
            get_app. Logins via SSO are in the audit log (login_sso, login_sso_refused).
          </p>
        </CardContent>
      </Card>
    </div>
  );
};
