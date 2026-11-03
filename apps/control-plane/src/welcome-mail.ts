// The welcome email of an account created in the admin console (M6, sent by admin/api.ts). Never a password nor a
// token: the admin hands them over.

export interface WelcomeMail {
  email: string;
  role: "admin" | "developer";
  apiUrl: string;
  studioUrl: string;
  adminUrl: string;
  /** Company SSO for Studio: its name, and whether the password also works for this account; null: password only. */
  sso: { name: string; passwordToo: boolean } | null;
  /** Claude Code on the web (claude_web_environment, INSTALL.md §7): the link to a first session; null: not set up. */
  webStart: string | null;
  /** The Connect Claude page: the claude.ai connector's setup (Team or Enterprise, or Pro or Max). */
  connectPage: string;
}

export function welcomeMail(m: WelcomeMail) {
  const admin = m.role === "admin";
  const passwordToo = !m.sso || m.sso.passwordToo;
  const password = "with this email and the password your admin gives you";
  const studioLogin = !m.sso
    ? password
    : m.sso.passwordToo
    ? `with ${m.sso.name}, or ${password}`
    : `with ${m.sso.name}`;

  // Each paragraph is a single line of the email: a `\` at the end of a source line continues it.
  const requirements = "Node.js 22.18 or later and the GitHub CLI (gh) logged in";
  const plugin = `Install the platform plugin from a terminal:

    claude plugin install platform --marketplace ${m.apiUrl}/plugin/marketplace.json

  Then start Claude Code, type /mcp, choose plugin:platform:platform, then Authenticate: your browser opens, sign in \
with your platform account and allow the access. You can now ask Claude to deploy your app.`;
  const claude = m.webStart
    ? `- Build and deploy apps from your browser with Claude Code on the web, nothing to install. Once, connect Claude \
to the platform as this page explains (one click on claude.ai Team or Enterprise, three steps on Pro or Max):

    ${m.connectPage}

  Then open this link and describe the app you need:

    ${m.webStart}

- Or with Claude Code on your computer, with ${requirements}. ${plugin}`
    : `- Build and deploy apps with Claude Code. You need ${requirements}. ${plugin}`;

  return {
    subject: "Your account on the app platform",
    text: [
      "Hello,",
      "",
      `An account was created for you (${m.email}) on the company's app platform${admin ? ", as an admin" : ""}.`,
      "",
      claude,
      `- Inspect your apps' data in Studio: ${m.studioUrl} (sign in ${studioLogin}).`,
      ...(admin ? [`- Administration console: ${m.adminUrl}`] : []),
      "",
      ...(passwordToo ? ["Your admin gives you your password over a private channel: it is never sent by email."] : []),
    ].join("\n"),
  };
}
