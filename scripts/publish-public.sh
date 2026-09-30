#!/usr/bin/env bash
# Publishes a sanitised mirror of this repo to the public GitHub remote.
#
# The working repo carries real personal data: db/seed.sql holds a name,
# an address and a whole CV, and the mockup and a stylesheet comment
# carry the name too. All of it is also in the history, so a public repo
# would expose it however the current files look.
#
# So the public repo is a MIRROR, not this repo: a throwaway clone whose
# history is rewritten with the personal data replaced, a placeholder
# seed committed in its place, and the result force-pushed. Commit
# messages survive — they carry the measurements, which is most of what
# another reader comes for.
#
# The local repo is never touched. Run it again whenever you want the
# public copy updated; every run rewrites from scratch, so the remote
# gets new commit ids each time. That is the trade for keeping the
# history readable without keeping the data in it.
#
# WHAT to replace lives in scripts/publish-redactions.txt, which is NOT
# committed — an earlier version of this script listed the names inline
# and then failed its own check, because the script itself had become a
# file containing them.
#
#   scripts/publish-public.sh [remote-url]
#
# Requires: python -m git_filter_repo (pip install git-filter-repo)
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE="${1:-https://github.com/1sa1asdev/JOBBFLo.git}"
LISTA="$REPO/scripts/publish-redactions.txt"
ARBETE="$(mktemp -d)/jobbflo-public"

if [ ! -f "$LISTA" ]; then
  echo "saknar $LISTA" >&2
  echo "En rad per ersättning, i formen:  verkligt värde==>platshållare" >&2
  exit 1
fi

echo "== klonar till $ARBETE"
git clone --quiet --no-local "$REPO" "$ARBETE"
cd "$ARBETE"
git checkout -q "$(git -C "$REPO" branch --show-current)"
cp "$LISTA" ersatt.txt

echo "== skriver om historiken"
# The seed and the local machine config are dropped entirely rather than
# edited: one is a CV, the other is paths and permissions from this
# machine. A placeholder seed is committed back below.
python -m git_filter_repo --force \
  --invert-paths --path db/seed.sql --path .claude/settings.local.json \
  --replace-text ersatt.txt >/dev/null
rm ersatt.txt

echo "== lägger tillbaka en seed med platshållare"
mkdir -p db
cp "$REPO/scripts/seed.public.sql" db/seed.sql
printf '\n# Local machine config: paths and per-project permissions.\n.claude/settings.local.json\n' >> .gitignore
git add db/seed.sql .gitignore
git -c user.name="$(git log -1 --format=%an)" -c user.email="$(git log -1 --format=%ae)" \
  commit -q -m "Seed with a placeholder CV, and keep local config out

The seed carries a real name, a real address and a real CV, and this
repo is public. The grading reads that text and quotes it back, so the
file has to exist — it just must not be anyone's."

# The check is the point of the script: every left-hand side of the
# redaction list, looked for in every commit. If anything survived the
# rewrite, nothing is pushed.
echo "== kontroll: inga personuppgifter kvar"
MÖNSTER="$(cut -d'=' -f1 "$LISTA" | grep -v '^$' | paste -sd'|' -)"
TRÄFFAR="$(git grep -I -l -iE "$MÖNSTER" $(git rev-list --all) 2>/dev/null | head -5 || true)"
if [ -n "$TRÄFFAR" ]; then
  echo "AVBRYTER: personuppgifter finns kvar i historiken:" >&2
  echo "$TRÄFFAR" >&2
  exit 1
fi
echo "   rent i alla $(git rev-list --all | wc -l) commits"

echo "== pushar till $REMOTE"
git branch -M main
git remote add origin "$REMOTE"
git push --force --quiet -u origin main
echo "klart — $REMOTE"
