import { writeFileSync } from "node:fs";
import { runPreflight } from "./runner.js";
import { renderHtml, renderText } from "./render.js";
import { tally } from "./types.js";

const USAGE = `
gitlit-preflight — check a running GitLit deployment for the failures that look like success

  gitlit-preflight <api-url> [options]

  --web <url>      your website's address, e.g. https://gitlit.app
  --gitd <url>     gitd's address, if you can reach it (usually only from inside)
  --token <t>      operator token, to include settings, keys and backup checks
  --email <addr>   an address YOU own; one sign-in link is sent to it
  --html <file>    also write a readable report to this file
  --json           print raw JSON instead of text

Nothing here changes anything, except sending one sign-in email when --email is given.
`;

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
  process.stdout.write(USAGE);
  process.exit(args.length === 0 ? 1 : 0);
}

const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const strip = (u: string | undefined) => u?.replace(/\/+$/, "");
const apiUrl = strip(args[0])!;

const report = await runPreflight({
  apiUrl,
  webUrl: strip(flag("web")),
  gitdUrl: strip(flag("gitd")),
  operatorToken: flag("token") ?? process.env.OPERATOR_TOKEN,
  email: flag("email"),
  fetch: globalThis.fetch,
});

if (args.includes("--json")) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(renderText(report));
}

const htmlPath = flag("html");
if (htmlPath) {
  writeFileSync(htmlPath, renderHtml(report));
  process.stdout.write(`Report written to ${htmlPath}\n\n`);
}

// Non-zero when something FAILED, so this can gate a deploy script. Warnings
// do not fail the run: they are the items only a human can settle.
process.exit(tally(report.results).fail > 0 ? 1 : 0);
