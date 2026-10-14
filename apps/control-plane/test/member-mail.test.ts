// The email to a member added to an app, whose role changed, or removed (B7, src/member-mail.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { memberMail } from "../src/member-mail.ts";

const app = { name: "Todo", url: "https://todo.example.com", studioUrl: "https://studio.example.com/project/todo" };

test("added: who, the app, the role, how to start, why", () => {
  const mail = memberMail(app, "Carol (carol@example.com)", undefined, "collaborator");
  assert.equal(mail.subject, `You were added to the app "Todo"`);
  assert.match(mail.text, /^Carol \(carol@example\.com\) added you to the app "Todo" .*, as a collaborator\.$/m);
  assert.match(mail.text, /The app: https:\/\/todo\.example\.com$/m);
  assert.match(mail.text, /As a collaborator, you can work on the app/);
  assert.ok(mail.text.includes("Studio: https://studio.example.com/project/todo"));
  assert.match(mail.text, /Claude Code with the platform plugin/);
  assert.match(mail.text, /because you are now a collaborator of this app\. If you did not expect this, contact Carol/);
});

test("added by the CLI: a platform admin", () => {
  const mail = memberMail(app, null, undefined, "owner");
  assert.match(mail.text, /^A platform admin added you to the app "Todo" .*, as an owner\.$/m);
  assert.match(mail.text, /also choose who works on it, decide how people sign in to it, and stop or delete it/);
  assert.match(mail.text, /contact your platform administrator/);
});

test("role change: short notice, without the getting started part", () => {
  const promoted = memberMail(app, "carol@example.com", "collaborator", "owner");
  assert.equal(promoted.subject, `You are now an owner of the app "Todo"`);
  assert.match(promoted.text, /carol@example\.com changed your role on the app "Todo" .*: you are now an owner\./);
  assert.ok(!promoted.text.includes("Studio"));
  assert.equal(memberMail(app, null, "owner", "collaborator").subject, `You are now a collaborator of the app "Todo"`);
});

test("removed", () => {
  const mail = memberMail(app, "carol@example.com", "collaborator");
  assert.equal(mail.subject, `You no longer have access to the app "Todo"`);
  assert.match(mail.text, /carol@example\.com removed you from the app "Todo" \(https:\/\/todo\.example\.com\)/);
  assert.match(mail.text, /because you were a collaborator of this app/);
});
