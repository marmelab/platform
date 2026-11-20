// Never a password nor a token in the welcome email: the admin hands them over. HTML, links shown by their label, with
// a plain-text alternative. One action per step, only the steps of this platform's claude.ai setup.
import { BUTTON_STYLE, escape, htmlMail } from "./mail-html.ts";

export interface WelcomeMail {
  role: "admin" | "developer";
  apiUrl: string;
  studioUrl: string;
  adminUrl: string;
  /** Company SSO is on; `passwordToo`: this account may also sign in with a password. null: password only. */
  sso: { passwordToo: boolean } | null;
  /**
   * Claude Code on the web; null: not set up (admins only: the admin API refuses builders before). `organization`: the
   * claude.ai organization's connector (Team, Enterprise); otherwise each builder adds their own (Pro, Max).
   */
  claude: { organization: boolean; start: string; connectPage: string } | null;
}

type Step = string | { link: string; url: string } | { button: string; url: string } | { text: string; code: string };
type Block = { p: string } | { ol: Step[] } | { ul: Step[] };
interface Section { title?: string; blocks: Block[] }

/** Connecting the claude.ai organization's connector, also on the Connect Claude page (studio/pages.ts). */
export const organizationConnectorSteps = (signIn: string) =>
  ["On claude.ai, open Customize > Connectors.", "Choose Platform.", "Click Connect.", signIn, "Click Allow."];

const LINK_STYLE = "color:#2563eb";
const CODE_STYLE = "display:block;margin:8px 0;padding:8px 12px;background:#f4f4f5;border-radius:6px;" +
  "font-family:Menlo,Consolas,monospace;font-size:13px;word-break:break-all";

function stepHtml(step: Step) {
  if (typeof step === "string") return escape(step);
  if ("link" in step) return `<a href="${escape(step.url)}" style="${LINK_STYLE}">${escape(step.link)}</a>`;
  if ("button" in step) return `<a href="${escape(step.url)}" style="${BUTTON_STYLE}">${escape(step.button)}</a>`;
  return `${escape(step.text)}<code style="${CODE_STYLE}">${escape(step.code)}</code>`;
}

function stepText(step: Step) {
  if (typeof step === "string") return step;
  if ("link" in step) return `${step.link}: ${step.url}`;
  if ("button" in step) return `${step.button}: ${step.url}`;
  return `${step.text}\n\n      ${step.code}\n`;
}

function html(sections: Section[]) {
  const list = (tag: "ol" | "ul", steps: Step[]) =>
    `<${tag} style="margin:8px 0;padding-left:24px">${steps.map((s) => `<li style="margin:8px 0">${stepHtml(s)}</li>`).join("")}</${tag}>`;
  return sections.map(({ title, blocks }) => [
    ...(title ? [`<h2 style="margin:28px 0 8px;font-size:17px">${escape(title)}</h2>`] : []),
    ...blocks.map((b) => ("p" in b ? `<p>${escape(b.p)}</p>` : "ol" in b ? list("ol", b.ol) : list("ul", b.ul))),
  ].join("\n")).join("\n");
}

function text(sections: Section[]) {
  return sections.map(({ title, blocks }) => [
    ...(title ? [title.toUpperCase()] : []),
    ...blocks.map((b) =>
      "p" in b
        ? b.p
        : "ol" in b
        ? b.ol.map((s, i) => `${i + 1}. ${stepText(s)}`).join("\n")
        : b.ul.map((s) => `- ${stepText(s)}`).join("\n")
    ),
  ].join("\n\n")).join("\n\n");
}

export function welcomeMail(m: WelcomeMail) {
  const admin = m.role === "admin";
  const account = m.sso ? "with your company account" : "with your email and password";
  const signIn = `Sign in ${account}.`;
  const sections: Section[] = [
    {
      blocks: [
        { p: "Hello," },
        { p: `Your ${admin ? "admin " : ""}account on the company's app platform is ready.` },
        ...(!m.sso || m.sso.passwordToo ? [{ p: "Your admin sends you your password separately. It is never sent by email." }] : []),
      ],
    },
  ];
  if (m.claude) {
    const start: Step[] = [{ button: "Start building", url: m.claude.start }, "Describe the app you need."];
    sections.push({
      title: "Build your first app",
      blocks: [{
        ol: m.claude.organization
          ? [...organizationConnectorSteps(signIn), ...start]
          : [{ link: "Open the Connect Claude page", url: m.claude.connectPage }, signIn, "Follow the steps on the page.", ...start],
      }],
    });
  }
  sections.push({ title: "See your apps' data", blocks: [{ ol: [{ link: "Open Studio", url: m.studioUrl }, signIn] }] });
  if (admin) sections.push({ title: "Manage the platform", blocks: [{ ul: [{ link: "Open the admin console", url: m.adminUrl }] }] });
  sections.push({
    title: "Advanced: Claude Code on your computer",
    blocks: [
      { p: "For technical users who prefer a terminal." },
      { p: "You need:" },
      { ul: ["Node.js 22.18 or later.", "The GitHub CLI (gh), signed in."] },
      { p: "Then:" },
      {
        ol: [
          { text: "Install the platform plugin:", code: `claude plugin install platform --marketplace ${m.apiUrl}/plugin/marketplace.json` },
          "Start Claude Code.",
          "Type /mcp.",
          "Choose plugin:platform:platform.",
          "Choose Authenticate.",
          `In the browser that opens, sign in ${account}.`,
          "Click Allow.",
        ],
      },
    ],
  });

  const subject = "Your account on the app platform";
  return { subject, text: `${text(sections)}\n`, html: htmlMail(escape(subject), html(sections)) };
}
