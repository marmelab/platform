// Mailpit (the local mail catcher of deploy/docker-compose.yml, M6): the e2e suites read the emails sent by the apps'
// GoTrue and by the platform through its HTTP API. Requires a local install (SMTP_HOST=mailpit, written by install.sh).
import assert from "node:assert/strict";

export const MAILPIT_URL = process.env.MAILPIT_URL ?? "http://localhost:8025";

export interface Mail {
  ID: string;
  Subject: string;
  From: { Name: string; Address: string };
  To: { Name: string; Address: string }[];
  Text: string;
  HTML: string;
}

async function mailpit(path: string, init?: RequestInit) {
  const response = await fetch(`${MAILPIT_URL}/api/v1${path}`, init);
  assert.ok(response.ok, `mailpit ${path}: ${response.status}`);
  return response.headers.get("content-type")?.includes("json") ? response.json() : response.text();
}

/** Summaries of the messages matching a Mailpit search (e.g. `to:"a@b.c" subject:"Reset"`), newest first. */
export async function searchMails(query: string): Promise<{ ID: string; Subject: string }[]> {
  const result = await mailpit(`/search?limit=50&query=${encodeURIComponent(query)}`) as { messages: { ID: string; Subject: string }[] };
  return result.messages;
}

/** Waits until at least `count` messages match, and returns them in full, newest first. */
export async function waitForMails(query: string, count = 1, timeoutMs = 15_000): Promise<Mail[]> {
  const deadline = Date.now() + timeoutMs;
  let found: { ID: string }[] = [];
  while (Date.now() < deadline) {
    found = await searchMails(query);
    if (found.length >= count) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(found.length >= count, `expected ${count} email(s) matching ${query}, found ${found.length}`);
  return Promise.all(found.map((m) => mailpit(`/message/${m.ID}`) as Promise<Mail>));
}

export const waitForMail = async (query: string) => (await waitForMails(query))[0]!;

/** No message matches, after waiting a little (emails are sent asynchronously by some senders). */
export async function assertNoMail(query: string, waitMs = 1500) {
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  assert.deepEqual((await searchMails(query)).map((m) => m.Subject), [], `no email expected for ${query}`);
}

export async function deleteMails(query: string) {
  await mailpit(`/search?query=${encodeURIComponent(query)}`, { method: "DELETE" });
}

/** The first link of the HTML body (GoTrue's default templates have one action link). */
export function mailLink(mail: Mail): string {
  const href = /href="([^"]+)"/.exec(mail.HTML)?.[1];
  assert.ok(href, `no link in "${mail.Subject}"`);
  return href.replaceAll("&amp;", "&");
}

/** Follows a GoTrue verify link: returns the redirect target (with the session in its fragment on success). */
export async function followLink(link: string): Promise<string> {
  const response = await fetch(link, { redirect: "manual" });
  await response.body?.cancel();
  assert.equal(response.status, 303, `${link}: ${response.status}`);
  return response.headers.get("location") ?? "";
}

/** The session parameters of a redirect target's fragment (#access_token=...&refresh_token=...&type=...). */
export function fragmentParams(location: string) {
  return new URLSearchParams(new URL(location).hash.slice(1));
}

/** Confirms a sign-up from its confirmation email (U1). */
export async function confirmSignup(email: string, appUrl: string) {
  const mail = await waitForMail(`to:"${email}" subject:"Confirm"`);
  const link = mailLink(mail);
  assert.ok(link.startsWith(`${appUrl}/auth/v1/verify?`), `confirmation link on the app host: ${link}`);
  assert.match(link, /type=signup/);
  const location = await followLink(link);
  assert.ok(location.startsWith(appUrl) && fragmentParams(location).get("access_token"), `signed in on the app: ${location}`);
  return mail;
}
