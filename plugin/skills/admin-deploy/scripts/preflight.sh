#!/usr/bin/env bash
# Usage: preflight.sh [<owner/repo>]  (run from the root of the app's checkout)
# Refuses a direct admin deployment of anything but a pushed commit of the linked repository:
#   - the working tree must be clean (no modified, staged or untracked files);
#   - HEAD must be contained in a branch of the remote (after git fetch);
#   - with <owner/repo> (get_app's github_repo), a remote must point to that GitHub repository.
# Prints the commit on success; exits 1 with the reason otherwise.
set -euo pipefail
repo="${1:-}"
git rev-parse --is-inside-work-tree > /dev/null 2>&1 || { echo "REFUSED: not a git checkout" >&2; exit 1; }
[ "$(git rev-parse --show-toplevel)" = "$(pwd -P)" ] || { echo "REFUSED: run from the repository root" >&2; exit 1; }
dirty="$(git status --porcelain --untracked-files=normal)"
if [ -n "$dirty" ]; then
  echo "REFUSED: the working tree has uncommitted changes:" >&2
  echo "$dirty" >&2
  exit 1
fi
remotes="$(git remote)"
[ -n "$remotes" ] || { echo "REFUSED: no git remote: the commit must be pushed to the linked repository" >&2; exit 1; }
if [ -n "$repo" ]; then
  match=""
  for r in $remotes; do
    url="$(git remote get-url "$r")"
    # https://host/owner/repo(.git) or git@host:owner/repo(.git)
    if [[ "$url" =~ [/:]${repo}(\.git)?/?$ ]]; then match="$r"; break; fi
  done
  [ -n "$match" ] || { echo "REFUSED: no remote points to the linked repository $repo" >&2; exit 1; }
  remotes="$match"
fi
for r in $remotes; do git fetch --quiet "$r" || { echo "REFUSED: git fetch $r failed" >&2; exit 1; }; done
head="$(git rev-parse HEAD)"
pushed=""
for r in $remotes; do
  if [ -n "$(git branch -r --contains "$head" --list "$r/*")" ]; then pushed="$r"; break; fi
done
[ -n "$pushed" ] || { echo "REFUSED: commit $head is not on the remote ($remotes): push it first" >&2; exit 1; }
echo "$head"
