import { CONSENT_PATH as OAUTH_CONSENT_PATH } from "../platform-auth.ts";

const escape = (value: string) =>
  value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

const layout = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; font: 15px/1.5 system-ui, sans-serif; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; }
  main { width: min(22rem, 100% - 2rem); }
  h1 { font-size: 1.25rem; margin: 0 0 1rem; }
  label { display: block; margin: .75rem 0 .25rem; font-size: .875rem; }
  input, button { box-sizing: border-box; width: 100%; padding: .55rem .7rem; font: inherit; border-radius: 6px; }
  input { border: 1px solid #8886; background: Field; color: FieldText; }
  button { margin-top: 1.25rem; border: 0; background: #3ecf8e; color: #111; font-weight: 600; cursor: pointer; }
  .error { color: #e5484d; }
  a.button { display: block; box-sizing: border-box; width: 100%; padding: .55rem .7rem; border-radius: 6px; text-align: center;
    text-decoration: none; background: #3ecf8e; color: #111; font-weight: 600; }
  .muted { margin: 1.25rem 0 0; font-size: .875rem; opacity: .75; }
  button.secondary { margin-top: .5rem; background: transparent; color: inherit; border: 1px solid #8886; }
  button.link { margin-top: .5rem; background: none; color: inherit; text-decoration: underline; font-weight: 400; padding: 0; }
</style></head><body><main>${body}</main></body></html>`;

export interface SsoOption {
  /** Shown as "Sign in with <name>". */
  name: string;
  /** "admins": the password form is the admins' break-glass access. */
  passwordLogin: "everyone" | "admins";
}

/** Where the login leads: Studio, or the consent page of a Claude Code sign-in (oauth.ts). */
const loginHeading = (next: string) =>
  next.startsWith(OAUTH_CONSENT_PATH) ? "Sign in to connect Claude Code" : "Sign in to Studio";

export function loginPage(
  { next, email = "", error, sso }: { next: string; email?: string; error?: string; sso?: SsoOption | null },
) {
  const ssoButton = sso
    ? `<a class="button" href="/_platform/sso/start?next=${encodeURIComponent(next)}">Sign in with ${escape(sso.name)}</a>
<p class="muted">${sso.passwordLogin === "admins" ? "Password sign-in is reserved to platform admins." : "Or with your platform password:"}</p>`
    : "";
  return layout(
    "Sign in · Platform Studio",
    `<h1>${loginHeading(next)}</h1>
${error ? `<p class="error" role="alert">${escape(error)}</p>` : ""}
${ssoButton}
<form method="post" action="/_platform/login">
  <input type="hidden" name="next" value="${escape(next)}">
  <label for="email">Email</label>
  <input id="email" name="email" type="email" autocomplete="username" required value="${escape(email)}" autofocus>
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required>
  <button type="submit">Sign in</button>
</form>`,
  );
}

export function refusedPage(reason: string) {
  return layout(
    "Access denied · Platform Studio",
    `<h1>Access denied</h1><p>${escape(reason)}.</p><p><a href="/projects">Back to your projects</a></p>
<form method="post" action="/_platform/logout"><button type="submit">Sign out</button></form>`,
  );
}

/**
 * Consent of a Claude Code sign-in (oauth.ts), in plain words: who asks, for which account. The client name is the one
 * the application registered itself with: the page says where it runs (this computer) rather than vouching for it.
 */
export function consentPage(
  { authorizationId, clientName, email }: { authorizationId: string; clientName: string; email: string },
) {
  return layout(
    "Connect Claude Code · Platform",
    `<h1>Allow access to your apps?</h1>
<p><strong>${escape(clientName)}</strong>, running on this computer, asks to access your apps on the platform: deploy
them, read their logs and data, and manage their users, as you would.</p>
<p class="muted">Signed in as <strong>${escape(email)}</strong>.</p>
<form method="post" action="${OAUTH_CONSENT_PATH}">
  <input type="hidden" name="authorization_id" value="${escape(authorizationId)}">
  <button type="submit" name="decision" value="approve">Allow</button>
  <button type="submit" name="decision" value="deny" class="secondary">Deny</button>
</form>
<p class="muted">If you did not start this from Claude Code, deny. Your admin can revoke this access at any time.</p>
<form method="post" action="/_platform/logout"><button type="submit" class="link">Not you? Sign out</button></form>`,
  );
}

export function oauthMessagePage(title: string, message: string) {
  return layout(`${title} · Platform`, `<h1>${escape(title)}</h1><p>${escape(message)}</p>`);
}
