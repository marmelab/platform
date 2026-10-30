import { isLoopbackRedirect } from "../oauth-policy.ts";
import { CONNECTOR_PATH, CONSENT_PATH as OAUTH_CONSENT_PATH } from "../platform-auth.ts";

const escape = (value: string) =>
  value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

const layout = (title: string, body: string, wide = false) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; font: 15px/1.5 system-ui, sans-serif; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; }
  main { width: min(22rem, 100% - 2rem); }
  main.wide { width: min(40rem, 100% - 2rem); padding: 2rem 0; }
  h1 { font-size: 1.25rem; margin: 0 0 1rem; }
  h2 { font-size: 1rem; margin: 1.5rem 0 .5rem; }
  code { overflow-wrap: anywhere; }
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
</style></head><body><main${wide ? ' class="wide"' : ""}>${body}</main></body></html>`;

export interface SsoOption {
  /** Shown as "Sign in with <name>". */
  name: string;
  /** "admins": the password form is the admins' break-glass access. */
  passwordLogin: "everyone" | "admins";
}

/** Where the login leads: Studio, or the consent page of a Claude sign-in (oauth.ts), or the Connect Claude page. */
const loginHeading = (next: string) =>
  next.startsWith(OAUTH_CONSENT_PATH) || next.startsWith(CONNECTOR_PATH) ? "Sign in to connect Claude" : "Sign in to Studio";

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
 * Consent of a Claude sign-in (oauth.ts), in plain words: who asks, for which account. The client name is the one the
 * application registered itself with: the page says where it runs, from the redirect URI (this computer, or
 * claude.ai), rather than vouching for it.
 */
export function consentPage(
  { authorizationId, clientName, redirectUri, email }: {
    authorizationId: string;
    clientName: string;
    redirectUri: string;
    email: string;
  },
) {
  const where = isLoopbackRedirect(redirectUri) ? "running on this computer" : `on ${URL.parse(redirectUri)?.host ?? "an unknown host"}`;
  return layout(
    "Connect Claude · Platform",
    `<h1>Allow access to your apps?</h1>
<p><strong>${escape(clientName)}</strong>, ${escape(where)}, asks to access your apps on the platform: deploy
them, read their logs and data, and manage their users, as you would.</p>
<p class="muted">Signed in as <strong>${escape(email)}</strong>.</p>
<form method="post" action="${OAUTH_CONSENT_PATH}">
  <input type="hidden" name="authorization_id" value="${escape(authorizationId)}">
  <button type="submit" name="decision" value="approve">Allow</button>
  <button type="submit" name="decision" value="deny" class="secondary">Deny</button>
</form>
<p class="muted">If you did not start this from Claude, deny. Your admin can revoke this access at any time.</p>
<form method="post" action="/_platform/logout"><button type="submit" class="link">Not you? Sign out</button></form>`,
  );
}

export interface ConnectorSetup {
  email: string;
  /** The builder's own connector client, if any. */
  clientId: string | null;
  /** Shown once, right after it was created or replaced. */
  secret?: string;
  mcpUrl: string;
  /** What the environment's network access must add to the default list. */
  hosts: string[];
  setupScript: string;
  environment: string;
}

/**
 * The Connect Claude page (CONNECTOR_PATH, INSTALL.md §7): on claude.ai Team or Enterprise, the organization's
 * connector is one click away; on Pro or Max, the builder adds it with a client of their own (its secret shown once)
 * and creates the Claude Code environment.
 */
export function connectorPage(s: ConnectorSetup) {
  const code = (value: string) => `<code>${escape(value)}</code>`;
  const client = s.secret
    ? `<p>Client ID: ${code(s.clientId!)}<br>Client secret: ${code(s.secret)}</p>
<p class="error" role="alert">Copy the secret now: it is not shown again.</p>`
    : s.clientId
    ? `<p>Client ID: ${code(s.clientId)}. Its secret was shown when it was created.</p>
<form method="post" action="${CONNECTOR_PATH}"><button type="submit" class="secondary">Replace the secret</button></form>
<p class="muted">The former secret stops working: remove the connector from claude.ai, add it again with the new
secret, and connect again.</p>`
    : `<form method="post" action="${CONNECTOR_PATH}"><button type="submit">Create my client</button></form>`;
  return layout(
    "Connect Claude · Platform",
    `<h1>Connect Claude to the platform</h1>
<p>Claude Code on the web reaches the platform through a claude.ai connector, set up once.</p>
<h2>On claude.ai Team or Enterprise</h2>
<p>Your organization's <strong>Platform</strong> connector is ready: on claude.ai, open Customize, then Connectors,
choose Platform, then Connect, and sign in with your platform account.</p>
<h2>On claude.ai Pro or Max</h2>
<ol>
<li><p>Your connector's client, which signs in ${escape(s.email)} only:</p>${client}</li>
<li><p>On claude.ai, open Customize, then Connectors, then Add custom connector: name ${code("Platform")}, URL
${code(s.mcpUrl)}, and under Advanced settings (or OAuth client: Use your own OAuth client) the client ID and secret
above. Then Connect, and sign in with your platform account.</p></li>
<li><p>On claude.ai/code, create an environment named ${code(s.environment)}: network access Custom, keeping the
default list, plus ${s.hosts.map(code).join(" and ")}; setup script ${code(s.setupScript)}.</p></li>
</ol>
<form method="post" action="/_platform/logout"><button type="submit" class="link">Not ${escape(s.email)}? Sign out</button></form>`,
    true,
  );
}

export function oauthMessagePage(title: string, message: string) {
  return layout(`${title} · Platform`, `<h1>${escape(title)}</h1><p>${escape(message)}</p>`);
}
