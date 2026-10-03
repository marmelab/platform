// Sign-in with a platform account (email and password, the same accounts as Studio), or with the company SSO when an
// admin enabled it (M6 part 2): a link to /api/auth/sso/start, which comes back here with ?sso_error=... on a refusal.
// Admins only.
import { useEffect, useState } from "react";
import { Form, required, useLogin, useNotify } from "ra-core";
import { TextInput } from "@/components/admin/text-input";
import { Notification } from "@/components/admin/notification";
import { Button, buttonVariants } from "@/components/ui/button";

interface SsoOptions {
  enabled: boolean;
  name: string;
}

export const LoginPage = () => {
  const [loading, setLoading] = useState(false);
  const [sso, setSso] = useState<SsoOptions | null>(null);
  const [ssoError] = useState(() => new URLSearchParams(window.location.search).get("sso_error"));
  const login = useLogin();
  const notify = useNotify();
  useEffect(() => {
    fetch("/api/auth/sso", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then(setSso, () => setSso(null));
    // the error stays on screen, not in the address bar
    if (window.location.search) window.history.replaceState(null, "", `/${window.location.hash}`);
  }, []);
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <div className="w-full max-w-sm rounded-xl border bg-background p-6 shadow-sm">
        <h1 className="mb-1 text-xl font-semibold">Platform admin</h1>
        <p className="mb-6 text-sm text-muted-foreground">Sign in with your platform admin account.</p>
        {ssoError && (
          <p role="alert" className="mb-4 text-sm text-destructive">
            {ssoError}
          </p>
        )}
        {sso?.enabled && (
          <>
            <a className={buttonVariants({ className: "w-full" })} href="/api/auth/sso/start">
              Sign in with {sso.name}
            </a>
            <p className="my-4 text-center text-xs text-muted-foreground">or with your password</p>
          </>
        )}
        <Form
          className="flex flex-col gap-4"
          onSubmit={(values: Record<string, unknown>) => {
            setLoading(true);
            login(values)
              .catch((error: Error) => notify(error.message || "Sign in failed", { type: "error" }))
              .finally(() => setLoading(false));
          }}
        >
          <TextInput source="email" label="Email" type="email" autoComplete="username" validate={required()} />
          <TextInput source="password" label="Password" type="password" autoComplete="current-password" validate={required()} />
          <Button type="submit" disabled={loading}>
            Sign in
          </Button>
        </Form>
      </div>
      <Notification />
    </div>
  );
};
