// The emails of an app's GoTrue (M6): invitation, sign-up confirmation, password reset, sign-in link, email change.
// GoTrue's built-in ones are two generic lines that name no app, which spam filters flag; these are served to it by
// the internal listener (app-auth.ts, GOTRUE_MAILER_TEMPLATES_* in auth-policy.ts). GoTrue renders them as Go templates
// ({{ .ConfirmationURL }}, {{ .Email }}, {{ .NewEmail }}) and sends HTML only (no text part). Pure: unit tested.

export const APP_MAIL_TYPES = ["invite", "confirmation", "recovery", "magic_link", "email_change"] as const;
export type AppMailType = (typeof APP_MAIL_TYPES)[number];

export interface AppMailApp {
  name: string;
  url: string;
}

const MAILS: Record<AppMailType, { subject: string; intro: (app: string) => string; action: string; ignore: string }> = {
  invite: {
    subject: "You're invited to",
    intro: (app) => `You have been invited to join ${app}, an app of your company's app platform. ` +
      "Accept the invitation to create your account.",
    action: "Accept the invitation",
    ignore: "If you did not expect this invitation, you can ignore this email.",
  },
  confirmation: {
    subject: "Confirm your email address for",
    intro: (app) => `Thanks for signing up to ${app}. Confirm your email address to finish creating your account.`,
    action: "Confirm my email address",
    ignore: "If you did not sign up, you can ignore this email.",
  },
  recovery: {
    subject: "Reset your password for",
    intro: (app) => `We received a request to reset the password of your ${app} account ({{ .Email }}).`,
    action: "Choose a new password",
    ignore: "If you did not ask for it, you can ignore this email: your password stays the same.",
  },
  magic_link: {
    subject: "Your sign-in link for",
    intro: (app) => `Use the button below to sign in to ${app} as {{ .Email }}.`,
    action: "Sign in",
    ignore: "If you did not try to sign in, you can ignore this email.",
  },
  email_change: {
    subject: "Confirm your new email address for",
    intro: (app) => `Confirm the change of your ${app} account's email address from {{ .Email }} to {{ .NewEmail }}.`,
    action: "Confirm the change",
    ignore: "If you did not ask for this change, ignore this email and tell the app's team.",
  },
};

/** HTML-escaped, braces included: GoTrue parses the result as a Go template. */
const escape = (value: string) => value.replace(/[&<>"'{}]/g, (c) => `&#${c.charCodeAt(0)};`);

/** GOTRUE_MAILER_SUBJECTS_*: one line (a header), no braces (a Go template too). */
export const appMailSubject = (type: AppMailType, appName: string) =>
  `${MAILS[type].subject} ${appName.replace(/[\s{}]+/g, " ").trim()}`;

/** The body GoTrue fetches. The action link is the first link (test/mailpit.ts mailLink relies on it). */
export function appMailTemplate(type: AppMailType, app: AppMailApp) {
  const mail = MAILS[type];
  const name = escape(app.name);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(appMailSubject(type, app.name))}</title>
</head>
<body style="margin:0;padding:24px;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#18181b">
<div style="max-width:560px;margin:0 auto;padding:24px 32px;background:#ffffff;border-radius:8px">
<p>Hello,</p>
<p>${mail.intro(`<strong>${name}</strong>`)}</p>
<p style="margin:28px 0"><a href="{{ .ConfirmationURL }}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:bold">${mail.action}</a></p>
<p style="font-size:13px;color:#52525b">If the button does not work, copy this link into your browser:<br><span style="word-break:break-all">{{ .ConfirmationURL }}</span></p>
<p>${mail.ignore}</p>
<p style="margin-top:32px;font-size:12px;color:#71717a">This email was sent by ${name} (${escape(app.url)}), an app of your company's app platform.</p>
</div>
</body>
</html>
`;
}
