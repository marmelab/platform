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
}

export function welcomeMail(m: WelcomeMail) {
  const terminal = [
    "Install the platform plugin from a terminal:",
    "",
    `    claude plugin install platform --marketplace ${m.apiUrl}/plugin/marketplace.json`,
    "",
    "  Then start Claude Code, type /mcp, choose plugin:platform:platform, then Authenticate: your browser opens, " +
    "sign in with your platform account and allow the access. You can now ask Claude to deploy your app.",
  ];
  const claude = m.webStart
    ? [
      "- Build and deploy apps from your browser with Claude Code on the web, nothing to install. Once, connect " +
      "Claude to the platform: on claude.ai, open Settings, then Connectors, choose Platform, then Connect, and sign " +
      "in with your platform account. Then open this link and describe the app you need:",
      "",
      `    ${m.webStart}`,
      "",
      "- Or with Claude Code on your computer, with Node.js 22.18 or later and the GitHub CLI (gh) logged in. " +
      terminal[0],
      ...terminal.slice(1),
    ]
    : [
      "- Build and deploy apps with Claude Code. You need Node.js 22.18 or later and the GitHub CLI (gh) logged in. " +
      terminal[0],
      ...terminal.slice(1),
    ];
  const studioLogin = m.sso
    ? `with ${m.sso.name}${m.sso.passwordToo ? ", or with this email and the password your admin gives you" : ""}`
    : "with this email and the password your admin gives you";
  return {
    subject: "Your account on the app platform",
    text: [
      "Hello,",
      "",
      `An account was created for you (${m.email}) on the company's app platform${m.role === "admin" ? ", as an admin" : ""}.`,
      "",
      ...claude,
      `- Inspect your apps' data in Studio: ${m.studioUrl} (sign in ${studioLogin}).`,
      ...(m.role === "admin" ? [`- Administration console: ${m.adminUrl}`] : []),
      "",
      ...(!m.sso || m.sso.passwordToo ? ["Your admin gives you your password over a private channel: it is never sent by email."] : []),
    ].join("\n"),
  };
}
