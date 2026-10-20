#!/usr/bin/env bash
# Vercel's "Ignored Build Step": exit 0 skips the build, 1 builds.
#
# Only the two deploy branches build. They are moved by
# .github/workflows/deploy.yml, and only AFTER the database they talk to
# has been migrated — so code never runs against a schema that is older
# than it. A pull request's preview would run unmigrated code against
# the staging database, so pull requests do not get one.
case "$VERCEL_GIT_COMMIT_REF" in
  staging|production) echo "bygger $VERCEL_GIT_COMMIT_REF"; exit 1 ;;
  *) echo "hoppar över $VERCEL_GIT_COMMIT_REF — bara staging och production byggs"; exit 0 ;;
esac
