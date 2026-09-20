import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Server-side push policy (§12.7).
 *
 * A commit trailer is an assertion about who wrote the text. GitLit issues
 * those trailers itself, from the commit path, where spans were actually
 * computed (§7.3). A commit arriving over the wire carries no such evidence —
 * so a pushed commit that claims `GitLit-Provenance: human` is asserting
 * something the server has no way to check.
 *
 * The rule: reject the assertion rather than absorb it. Pushed commits must
 * carry no GitLit trailers, and their content is indexed as `unknown` origin —
 * an honest state (§6.4), not a flattering one. An author pushing from their
 * own editor is doing something legitimate and the record says exactly what is
 * known about it: that text arrived, and nothing about how it was written.
 *
 * Installed as a real pre-receive hook so rejection happens inside
 * receive-pack, before any ref moves.
 */
const PRE_RECEIVE = `#!/bin/sh
# Installed by GitLit. See system_architecture.md §12.7.
set -e
zero=0000000000000000000000000000000000000000

while read -r old new ref; do
  [ "$new" = "$zero" ] && continue

  if [ "$old" = "$zero" ]; then
    commits=$(git rev-list "$new" --not --all)
  else
    commits=$(git rev-list "$old..$new")
  fi

  for commit in $commits; do
    if git log -1 --format=%B "$commit" | grep -q '^GitLit-[A-Za-z-]*:'; then
      echo "" >&2
      echo "GitLit refused this push." >&2
      echo "" >&2
      echo "  Commit \${commit%\${commit#???????}} carries GitLit- provenance trailers." >&2
      echo "" >&2
      echo "  Those trailers are issued by GitLit itself, from the commit path where" >&2
      echo "  spans are actually computed. A pushed commit cannot carry evidence for" >&2
      echo "  them, so accepting one would let a client assert its own provenance." >&2
      echo "" >&2
      echo "  Remove the GitLit- trailers and push again. Your prose is recorded" >&2
      echo "  either way; text arriving by push is marked 'unknown' origin, which" >&2
      echo "  means only that GitLit did not observe how it was written." >&2
      echo "" >&2
      exit 1
    fi
  done
done
`;

export function installHooks(gitdir: string): void {
  const hooks = path.join(gitdir, "hooks");
  fs.mkdirSync(hooks, { recursive: true });
  const target = path.join(hooks, "pre-receive");
  fs.writeFileSync(target, PRE_RECEIVE, { mode: 0o755 });
}

/**
 * Set a repository config value.
 *
 * Uses `git config` rather than appending text: a hand-appended line lands in
 * whatever section happens to be last, and a dotted key inside `[core]` is a
 * parse error that takes the whole repository offline.
 *
 * (`receive.denyCurrentBranch` is deliberately NOT set here — it governs
 * pushes to a checked-out branch, and GitLit repositories are bare.)
 */
export function setConfig(gitdir: string, key: string, value: string): void {
  execFileSync("git", ["--git-dir", gitdir, "config", key, value]);
}
