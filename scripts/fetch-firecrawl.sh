#!/usr/bin/env bash
# Fetch the pinned upstream Firecrawl release into ./firecrawl.
# Upstream code is never edited in place; all integration lives in infra/ and apps/.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/firecrawl.lock"
DEST="$ROOT/firecrawl"

if [ -d "$DEST/.git" ]; then
  current="$(git -C "$DEST" rev-parse HEAD)"
  if [ "$current" = "$FIRECRAWL_SHA" ]; then
    echo "firecrawl already at $FIRECRAWL_TAG ($FIRECRAWL_SHA)"
  else
    echo "firecrawl checkout at $current, expected $FIRECRAWL_SHA ($FIRECRAWL_TAG)." >&2
    echo "Remove ./firecrawl and re-run, or update firecrawl.lock." >&2
    exit 1
  fi
else
  git clone --depth 1 --branch "$FIRECRAWL_TAG" "$FIRECRAWL_REPO" "$DEST"
  actual="$(git -C "$DEST" rev-parse HEAD)"
  if [ "$actual" != "$FIRECRAWL_SHA" ]; then
    echo "Tag $FIRECRAWL_TAG resolved to $actual, expected $FIRECRAWL_SHA. Refusing to continue." >&2
    exit 1
  fi
  echo "fetched firecrawl $FIRECRAWL_TAG ($actual)"
fi

# Verify the upstream tree is unmodified.
if [ -n "$(git -C "$DEST" status --porcelain)" ]; then
  echo "WARNING: ./firecrawl has local modifications. Upstream must stay unmodified; see docs/architecture.md." >&2
fi
