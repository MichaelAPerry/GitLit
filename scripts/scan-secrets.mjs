#!/usr/bin/env node
/**
 * Look for credentials committed to this repository, in the WHOLE history.
 *
 * Deleting a secret in a later commit does not remove it: the old commit is
 * still there, and on a pushed branch it is on someone else's machine and in
 * GitHub's caches. So this searches every commit, and when it finds something
 * the remedy is to ROTATE the secret, not to rewrite history.
 *
 *   pnpm scan:secrets
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const PATTERNS = [
  { name: "Resend API key", re: /\bre_[A-Za-z0-9]{20,}/g },
  { name: "OpenAI-style key", re: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { name: "Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  { name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "Google OAuth secret", re: /\bGOCSPX-[A-Za-z0-9_-]{20,}/g },
  { name: "Private key block", re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { name: "GitLit credential", re: /\b(glm|gls|glt|glo)_[0-9a-f]{18}_[0-9a-f]{64}\b/g },
  {
    name: "Database URL with a password",
    re: /\bpostgres(?:ql)?:\/\/[^\s"':/]+:[^\s"'@]+@[^\s"'/]+/g,
    // The local development database is published on purpose: it is
    // gitlit/gitlit on localhost or the compose service, and it guards nothing.
    ignore: (hit) => /@(localhost|127\.0\.0\.1|postgres)[:/]/.test(hit),
  },
];

const read = (args) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });

const scan = (text, where) => {
  const found = [];
  for (const { name, re, ignore } of PATTERNS) {
    for (const [hit] of text.matchAll(re)) {
      if (ignore?.(hit)) continue;
      found.push({ name, where, sample: `${hit.slice(0, 12)}…` });
    }
  }
  return found;
};

/**
 * Untracked files are scanned too, and they are the point.
 *
 * `git diff HEAD` shows only files git already knows about, so a brand-new
 * `secrets.txt` sitting in the working tree — the likeliest way a key gets
 * committed — is invisible to it. Found by planting one and watching this
 * script report all clear.
 *
 * `--exclude-standard` keeps .gitignore's rules, so a correctly-ignored `.env`
 * is not reported: that file is SUPPOSED to hold secrets, and flagging it
 * every run would teach you to ignore the output.
 */
const untracked = read(["ls-files", "--others", "--exclude-standard"])
  .split("\n")
  .filter(Boolean);

const findings = [
  ...scan(read(["log", "-p", "--all"]), "git history"),
  ...scan(read(["diff", "HEAD"]), "uncommitted changes"),
  ...scan(read(["diff", "--cached"]), "staged changes"),
];

for (const file of untracked) {
  try {
    findings.push(...scan(readFileSync(file, "utf8"), `untracked file ${file}`));
  } catch {
    // Binary or unreadable: nothing a text pattern would match anyway.
  }
}

if (findings.length === 0) {
  console.log("\n  ok  No credentials found in the working tree or in any commit.\n");
  process.exit(0);
}

const unique = [...new Map(findings.map((f) => [`${f.name}${f.sample}${f.where}`, f])).values()];
console.error(`\nFAIL  ${unique.length} possible credential${unique.length === 1 ? "" : "s"} found:\n`);
for (const f of unique) console.error(`  ${f.name} in ${f.where}  (${f.sample})`);
console.error(`
ROTATE anything found here, do not just delete it. Once a secret has been
pushed, it is on other machines and in the host's caches; removing the commit
does not un-publish it. Issue a new one, set it with \`fly secrets set\`, and
revoke the old one at whichever service issued it.
`);
process.exit(1);
