// The HTML shared by the platform's own emails (welcome-mail.ts) and its apps' GoTrue emails (app-mail.ts). Pure.

/** HTML-escaped, braces included: GoTrue parses app emails as Go templates. */
export const escape = (value: string) => value.replace(/[&<>"'{}]/g, (c) => `&#${c.charCodeAt(0)};`);

export const BUTTON_STYLE = "display:inline-block;padding:12px 24px;background:#2563eb;color:#ffffff;text-decoration:none;" +
  "border-radius:6px;font-weight:bold";

/** The page of an HTML email. `title` and `body` are HTML. */
export const htmlMail = (title: string, body: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
</head>
<body style="margin:0;padding:24px;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#18181b">
<div style="max-width:560px;margin:0 auto;padding:24px 32px;background:#ffffff;border-radius:8px">
${body}
</div>
</body>
</html>
`;
