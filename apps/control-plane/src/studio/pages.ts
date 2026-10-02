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
</style></head><body><main>${body}</main></body></html>`;

export function loginPage({ next, email = "", error }: { next: string; email?: string; error?: string }) {
  return layout(
    "Sign in · Platform Studio",
    `<h1>Sign in to Studio</h1>
${error ? `<p class="error" role="alert">${escape(error)}</p>` : ""}
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
