#!/usr/bin/env bash
# Build the web bundle and package it into a signed Tizen .wgt.
#
# Requires the Tizen Studio CLI on PATH and a security profile (author +
# distributor certificate). Locally that profile is "chino"; CI injects its own.
#
#   TIZEN_PROFILE   security-profile name        (default: chino)
#   STAGE_DIR       staging dir for the package  (default: ./.buildResult)
#
# The staging dir = the Vite build (dist/) + config.xml + icon.png, which is
# what `tizen package` expects at the package root.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="${TIZEN_PROFILE:-chino}"
STAGE="${STAGE_DIR:-$ROOT/.buildResult}"

cd "$ROOT"
npm run build

rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -r dist/. "$STAGE"/
cp config.xml icon.png "$STAGE"/

tizen package -t wgt -s "$PROFILE" -- "$STAGE"
echo "→ $STAGE/Chino.wgt"
