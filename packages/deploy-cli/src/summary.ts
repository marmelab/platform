// Markdown report of a run, for $GITHUB_STEP_SUMMARY (and the terminal).
import type { Lint } from "./platform.ts";
import type { Report } from "./run.ts";

const icon = { ok: "✅", skipped: "⏭️", failed: "❌" } as const;
const cell = (text: string) => text.replaceAll("|", "\\|").replaceAll("\n", " ");

function lintTable(lints: Lint[]) {
  return [
    "| Lint | Level | Object | Detail |",
    "|---|---|---|---|",
    ...lints.map((l) => `| \`${cell(l.name)}\` | ${l.level} | \`${cell(l.object)}\` | ${cell(l.detail ?? "")} |`),
  ].join("\n");
}

export function markdown(report: Report): string {
  const { app, mode } = report;
  const verb = mode === "check" ? "Check" : "Deployment";
  const title = `${report.ok ? "✅" : "❌"} Platform ${verb.toLowerCase()} of \`${app?.slug ?? report.config.app}\`: ` +
    (report.ok ? (mode === "check" ? "passed" : "deployed") : "failed");
  const lines = [`## ${title}`, ""];
  if (app) {
    lines.push(`- App: ${app.url}`);
    if (app.studio_url) lines.push(`- Studio: ${app.studio_url}`);
  }
  lines.push(`- Authentication: ${report.auth === "oidc" ? "GitHub OIDC (CI)" : "personal access token (direct)"}`);
  if (report.commit) lines.push(`- Commit: \`${report.commit.sha}\`${report.commit.dirty ? " (uncommitted changes)" : ""}`);
  if (report.release) {
    lines.push(`- Release: \`${report.release.id}\`${report.release.admin_exception ? " (admin exception)" : ""}`);
  }
  lines.push("", "| Step | Result |", "|---|---|");
  for (const step of report.steps) lines.push(`| ${step.name} | ${icon[step.status]} ${cell(step.detail)} |`);

  if (report.blockingLints.length) {
    lines.push(
      "",
      "### Blocking lints",
      "",
      "New `ERROR` lints that are not in `.platform.json` `acceptedLints`. Fix the migrations; to keep one on " +
        "purpose, add `{ \"name\", \"object\" }` to `acceptedLints` (reviewed with the change, audited on the platform).",
      "",
      lintTable(report.blockingLints),
    );
  }
  if (report.acceptedLints.length) lines.push("", "### Accepted lints (`acceptedLints`)", "", lintTable(report.acceptedLints));
  if (report.otherLints.length) lines.push("", "### Other lints", "", lintTable(report.otherLints));
  if (report.error && !report.steps.some((s) => s.status === "failed" && s.detail === report.error)) {
    lines.push("", `**Error:** ${report.error}`);
  }
  return lines.join("\n") + "\n";
}
