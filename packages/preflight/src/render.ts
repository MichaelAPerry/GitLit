import { tally, type CheckResult, type Report } from "./types.js";

const MARK: Record<CheckResult["status"], string> = {
  pass: "  ok  ", fail: " FAIL ", warn: " look ", skip: " --   ",
};

/** Terminal output, ordered worst first so the important line is not scrolled past. */
export function renderText(report: Report): string {
  const order = { fail: 0, warn: 1, skip: 2, pass: 3 } as const;
  const sorted = [...report.results].sort((a, b) => order[a.status] - order[b.status]);
  const t = tally(report.results);

  const lines = [
    "",
    `GitLit preflight — ${report.target}`,
    "─".repeat(64),
    "",
  ];

  for (const r of sorted) {
    lines.push(`[${MARK[r.status]}] ${r.title}`);
    lines.push(`         ${r.detail}`);
    if (r.status !== "pass") {
      lines.push(`         why: ${r.why}`);
      if (r.remedy) lines.push(`         do:  ${r.remedy}`);
    }
    lines.push("");
  }

  lines.push("─".repeat(64));
  lines.push(`${t.pass} ok · ${t.fail} failed · ${t.warn} to look at · ${t.skip} skipped`);
  if (t.fail > 0) lines.push("\nDo not open this to anyone else until the failures are fixed.");
  else if (t.warn > 0) lines.push("\nNothing is broken. The items above need you to go and look.");
  else lines.push("\nAll clear.");
  lines.push("");
  return lines.join("\n");
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A page to read, and to send to someone else. Self-contained, no network. */
export function renderHtml(report: Report): string {
  const t = tally(report.results);
  const order = { fail: 0, warn: 1, skip: 2, pass: 3 } as const;
  const sorted = [...report.results].sort((a, b) => order[a.status] - order[b.status]);

  const headline = t.fail > 0
    ? { text: `${t.fail} ${t.fail === 1 ? "failure" : "failures"} — do not open this to anyone else yet`, tone: "fail" }
    : t.warn > 0
      ? { text: "Nothing is broken — some things need you to go and look", tone: "warn" }
      : { text: "All clear", tone: "pass" };

  const card = (r: CheckResult) => `
      <article class="card ${r.status}">
        <div class="status">${r.status === "pass" ? "OK" : r.status === "fail" ? "FAILED" : r.status === "warn" ? "LOOK" : "SKIPPED"}</div>
        <div class="body">
          <h3>${esc(r.title)}${r.needsHuman ? ' <span class="human">needs you</span>' : ""}</h3>
          <p class="detail">${esc(r.detail)}</p>
          ${r.status === "pass" ? "" : `<p class="why"><b>Why this matters.</b> ${esc(r.why)}</p>`}
          ${r.remedy ? `<p class="remedy"><b>What to do.</b> ${esc(r.remedy)}</p>` : ""}
        </div>
      </article>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GitLit preflight</title>
<style>
  :root {
    --ink: #1c1a17; --muted: #6b645c; --paper: #faf8f4; --card: #ffffff;
    --rule: #e3ddd3; --pass: #2f5d50; --fail: #b4462f; --warn: #9a6b1f; --skip: #8d867c;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --ink: #ece7df; --muted: #9a938a; --paper: #16150f; --card: #201e18;
      --rule: #34302a; --pass: #7fb8a5; --fail: #e08b74; --warn: #d8ac63; --skip: #7d766d;
    }
  }
  :root[data-theme="dark"] {
    --ink: #ece7df; --muted: #9a938a; --paper: #16150f; --card: #201e18;
    --rule: #34302a; --pass: #7fb8a5; --fail: #e08b74; --warn: #d8ac63; --skip: #7d766d;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--paper); color: var(--ink);
    font: 400 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    padding: 40px 16px 64px;
  }
  main { max-width: 760px; margin: 0 auto; }
  h1 { font: 600 26px/1.2 Georgia, "Times New Roman", serif; margin: 0 0 6px; }
  .target { color: var(--muted); font-size: 14px; margin: 0 0 28px; word-break: break-all; }
  .headline {
    border-radius: 8px; padding: 16px 18px; margin: 0 0 8px; font-weight: 600;
    border: 1px solid var(--rule); background: var(--card);
  }
  .headline.fail { border-left: 5px solid var(--fail); color: var(--fail); }
  .headline.warn { border-left: 5px solid var(--warn); color: var(--warn); }
  .headline.pass { border-left: 5px solid var(--pass); color: var(--pass); }
  .tally { color: var(--muted); font-size: 14px; margin: 0 0 28px; }
  .card {
    display: flex; gap: 14px; align-items: flex-start;
    background: var(--card); border: 1px solid var(--rule); border-radius: 8px;
    padding: 16px 18px; margin-bottom: 12px;
  }
  .card.fail { border-left: 5px solid var(--fail); }
  .card.warn { border-left: 5px solid var(--warn); }
  .card.pass { border-left: 5px solid var(--pass); }
  .card.skip { border-left: 5px solid var(--skip); opacity: 0.75; }
  .status {
    flex: 0 0 74px; font-size: 11px; font-weight: 700; letter-spacing: 0.08em;
    padding-top: 3px; text-transform: uppercase;
  }
  .card.fail .status { color: var(--fail); }
  .card.warn .status { color: var(--warn); }
  .card.pass .status { color: var(--pass); }
  .card.skip .status { color: var(--skip); }
  .body { flex: 1 1 auto; min-width: 0; }
  h3 { font: 600 16px/1.35 inherit; margin: 0 0 4px; }
  .human {
    font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
    color: var(--warn); border: 1px solid var(--warn); border-radius: 4px; padding: 1px 5px;
    vertical-align: 2px; margin-left: 4px;
  }
  p { margin: 0 0 6px; }
  .detail { font-size: 15px; }
  .why, .remedy { font-size: 14px; color: var(--muted); }
  .remedy { color: var(--ink); }
  footer { color: var(--muted); font-size: 13px; margin-top: 32px; }
  @media (max-width: 520px) {
    .card { flex-direction: column; gap: 6px; }
    .status { flex: none; padding-top: 0; }
  }
</style>
</head>
<body>
<main>
  <h1>GitLit preflight</h1>
  <p class="target">${esc(report.target)} · ${esc(report.startedAt)}</p>

  <p class="headline ${headline.tone}">${esc(headline.text)}</p>
  <p class="tally">${t.pass} ok · ${t.fail} failed · ${t.warn} to look at · ${t.skip} skipped</p>

  ${sorted.map(card).join("\n")}

  <footer>
    These checks answer questions the code cannot: whether one machine is running, whether an
    email arrived, whether a backup restores. A green run here is not a promise that nothing is
    wrong — it means none of the known silent failures is happening right now.
  </footer>
</main>
</body>
</html>`;
}
