// The email to a platform account added to an app, whose role changed, or removed from it (B7, sent by members.ts).
import type { MemberRole } from "@platform/shared";

export interface MemberMailApp {
  name: string;
  url: string;
  studioUrl: string;
}

const ROLES: Record<MemberRole, string> = {
  collaborator: "As a collaborator, you can work on the app and publish new versions of it, see its activity and " +
    "its data, and manage the people who sign in to it.",
  owner: "As an owner, you can do everything a collaborator does (work on the app and publish new versions of it, " +
    "see its activity and its data, manage the people who sign in to it), and also choose who works on it, decide " +
    "how people sign in to it, and stop or delete it.",
};

const article = (role: MemberRole) => (role === "owner" ? "an owner" : "a collaborator");

/** `actor`: who made the change (name and email), null for a platform admin on the command line. */
export function memberMail(app: MemberMailApp, actor: string | null, previous?: MemberRole, next?: MemberRole) {
  const who = actor ?? "A platform admin";
  const contact = `If you did not expect this, contact ${actor ?? "your platform administrator"}.`;
  if (!next) {
    return {
      subject: `You no longer have access to the app "${app.name}"`,
      text: [
        "Hello,",
        "",
        `${who} removed you from the app "${app.name}" (${app.url}) on the company's app platform. ` +
        "You can no longer work on it or see its data.",
        "",
        `You receive this email because you were ${article(previous ?? "collaborator")} of this app. ${contact}`,
      ].join("\n"),
    };
  }
  const intro = previous
    ? `${who} changed your role on the app "${app.name}" on the company's app platform: you are now ${article(next)}.`
    : `${who} added you to the app "${app.name}" on the company's app platform, as ${article(next)}.`;
  return {
    subject: previous ? `You are now ${article(next)} of the app "${app.name}"` : `You were added to the app "${app.name}"`,
    text: [
      "Hello,",
      "",
      intro,
      "",
      `The app: ${app.url}`,
      "",
      ROLES[next],
      "",
      ...(previous ? [] : [
        "To get started:",
        `- See and edit the app's data in Studio: ${app.studioUrl} (sign in with your platform account).`,
        "- If you use Claude Code with the platform plugin, Claude now sees this app too: just ask it about " +
        `"${app.name}".`,
        "",
      ]),
      `You receive this email because you are now ${article(next)} of this app. ${contact}`,
    ].join("\n"),
  };
}
