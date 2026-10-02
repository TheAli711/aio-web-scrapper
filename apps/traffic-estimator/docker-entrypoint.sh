#!/bin/sh
# Runs as root only to make the data directory writable (a Render disk is mounted owned by root;
# a fresh compose volume inherits the image's ownership), then drops to the unprivileged app user.
set -e
if [ "$(id -u)" = "0" ]; then
  dir="${TE_DATA_DIR:-/data/traffic}"
  mkdir -p "$dir"
  chown -R app:app "$dir"
  exec setpriv --reuid=app --regid=app --init-groups -- "$@"
fi
exec "$@"
