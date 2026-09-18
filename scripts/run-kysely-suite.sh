#!/usr/bin/env bash
#
# Runs Kysely's own dialect test suite against this dialect.
#
# Kysely's suite has a postgres variant that normally runs on its built-in
# `pg` dialect. This checks out Kysely at a known version, points that
# variant at kysely-postgrejs instead (scripts/kysely-suite.patch), and
# runs the whole thing - every test Kysely holds its own dialect to.
#
# Everything lands in $WORK_DIR; nothing outside this repository is
# modified. The database is Kysely's own docker-compose service, on port
# 5434, so a local PostgreSQL is left alone. It is left running at the
# end - stop it with:
#
#   docker compose -f "$WORK_DIR/kysely/docker-compose.yml" down
#
# Usage: scripts/run-kysely-suite.sh
#   KYSELY_VERSION  git tag to test against  (default: v0.29.6)
#   WORK_DIR        where the checkout lives (default: $TMPDIR/kysely-postgrejs-suite)
set -euo pipefail

KYSELY_VERSION="${KYSELY_VERSION:-v0.29.6}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="${WORK_DIR:-${TMPDIR:-/tmp}/kysely-postgrejs-suite}"
KYSELY_DIR="$WORK_DIR/kysely"
# Kysely pins its own pnpm in `packageManager`; this one steps aside for it.
PNPM=(npx --yes pnpm@10.18.3)

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

say "Kysely $KYSELY_VERSION in $KYSELY_DIR"
mkdir -p "$WORK_DIR"
if [ ! -d "$KYSELY_DIR/.git" ]; then
  git clone --filter=blob:none https://github.com/kysely-org/kysely.git "$KYSELY_DIR"
fi
git -C "$KYSELY_DIR" fetch --tags --quiet
# Drop a patch left by an earlier run before moving the checkout.
git -C "$KYSELY_DIR" checkout --quiet -- test/node/src/test-setup.ts
git -C "$KYSELY_DIR" checkout --quiet "$KYSELY_VERSION"

say "Starting Kysely's own PostgreSQL (port 5434)"
COMPOSE=(docker compose -f "$KYSELY_DIR/docker-compose.yml")
"${COMPOSE[@]}" up -d postgres
# A container left over from a run that could not bind the port keeps
# running with no published port at all, and then nothing on the host can
# reach it - recreate it rather than let the suite wait five minutes.
if ! "${COMPOSE[@]}" port postgres 5432 >/dev/null 2>&1; then
  "${COMPOSE[@]}" up -d --force-recreate postgres
fi
PG_HOST_PORT="$("${COMPOSE[@]}" port postgres 5432 | sed 's/.*://')"
: "${PG_HOST_PORT:?the postgres container published no host port}"
ready=
for _ in $(seq 1 60); do
  if nc -z 127.0.0.1 "$PG_HOST_PORT" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
: "${ready:?postgres did not start listening on 127.0.0.1:$PG_HOST_PORT}"

say "Building Kysely"
(cd "$KYSELY_DIR" && "${PNPM[@]}" install --ignore-scripts && "${PNPM[@]}" build)

say "Pointing the postgres variant at this dialect"
git -C "$KYSELY_DIR" apply "$REPO_DIR/scripts/kysely-suite.patch"

say "Building this dialect"
(cd "$REPO_DIR" && npm run build)

# The dialect is installed as a real directory rather than a link: Node
# resolves a linked package's own imports from the link's target, and
# `kysely` has to come out as the build the suite itself runs on - two
# copies of it would mean the suite testing one and the dialect using
# another.
DEST="$KYSELY_DIR/node_modules/kysely-postgrejs"
rm -rf "$DEST"
mkdir -p "$DEST/node_modules"
cp -R "$REPO_DIR/build/." "$DEST/"
ln -sfn "$KYSELY_DIR" "$DEST/node_modules/kysely"
ln -sfn "$REPO_DIR/node_modules/postgrejs" "$DEST/node_modules/postgrejs"
ln -sfn "$REPO_DIR/node_modules/postgrejs" "$KYSELY_DIR/node_modules/postgrejs"

say "Running the suite"
cd "$KYSELY_DIR"
DIALECTS=postgres "${PNPM[@]}" test:node:build
DIALECTS=postgres "${PNPM[@]}" test:node:run
