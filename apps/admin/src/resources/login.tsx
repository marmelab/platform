// Sign-in with a platform account (email and password, the same accounts as Studio). Admins only.
import { useState } from "react";
import { Form, required, useLogin, useNotify } from "ra-core";
import { TextInput } from "@/components/admin/text-input";
import { Notification } from "@/components/admin/notification";
import { Button } from "@/components/ui/button";

export const LoginPage = () => {
  const [loading, setLoading] = useState(false);
  const login = useLogin();
  const notify = useNotify();
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <div className="w-full max-w-sm rounded-xl border bg-background p-6 shadow-sm">
        <h1 className="mb-1 text-xl font-semibold">Platform admin</h1>
        <p className="mb-6 text-sm text-muted-foreground">Sign in with your platform admin account.</p>
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
