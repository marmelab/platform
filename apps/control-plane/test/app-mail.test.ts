// The emails of an app's GoTrue (M6, src/app-mail.ts): subjects and bodies served instead of GoTrue's generic ones.
import assert from "node:assert/strict";
import { test } from "node:test";
import { APP_MAIL_TYPES, appMailSubject, appMailTemplate } from "../src/app-mail.ts";

const app = { name: "Team Tasks", url: "https://team-tasks.apps.example.com" };

test("every email names the app, and its first link is the action link", () => {
  for (const type of APP_MAIL_TYPES) {
    const body = appMailTemplate(type, app);
    assert.match(appMailSubject(type, app.name), /Team Tasks$/, type);
    assert.equal(/href="([^"]+)"/.exec(body)?.[1], "{{ .ConfirmationURL }}", type);
    assert.ok(body.includes("<strong>Team Tasks</strong>"), type);
    assert.ok(body.includes("(https://team-tasks.apps.example.com)"), type);
    assert.match(body, /^<!doctype html>/);
  }
  // the words the e2e tests search Mailpit for
  assert.equal(appMailSubject("invite", app.name), "You're invited to Team Tasks");
  assert.equal(appMailSubject("recovery", app.name), "Reset your password for Team Tasks");
  assert.equal(appMailSubject("confirmation", app.name), "Confirm your email address for Team Tasks");
  assert.match(appMailTemplate("email_change", app), /from \{\{ \.Email \}\} to \{\{ \.NewEmail \}\}/);
});

test("an app name cannot inject HTML, Go template actions or headers", () => {
  const name = `<img src=x>{{ .Token }}\r\nBcc: x@evil.test`;
  const body = appMailTemplate("invite", { ...app, name });
  assert.ok(!body.includes("<img"));
  assert.ok(!body.includes("{{ .Token }}"));
  assert.ok(body.includes("&#60;img src=x&#62;&#123;&#123; .Token &#125;&#125;"));
  // Go renders {{"{"}} as "{": the subject reads "You're invited to ‹img src=x›{{ .Token }} Bcc: x@evil.test"
  assert.equal(appMailSubject("invite", name), `You're invited to ‹img src=x›{{"{"}}{{"{"}} .Token }} Bcc: x@evil.test`);
  // an unclosed tag would make GoTrue's html/template fail every email of the app
  assert.equal(appMailSubject("invite", "Ops <beta"), "You're invited to Ops ‹beta");
});
