#!/usr/bin/env bash
# Package, sign and install Plex HDR on a Samsung TV in developer mode.
# Needs Tizen Studio CLI (tizen, sdb) on PATH and a Samsung certificate profile (see README).
#   ./scripts/build.sh                      -> builds PlexHDR.wgt
#   ./scripts/build.sh 192.168.1.50         -> builds, connects to the TV and installs
set -euo pipefail
cd "$(dirname "$0")/.."
PROFILE="${TIZEN_PROFILE:-PlexHDR}"
TV_IP="${1:-}"

rm -rf build && mkdir -p build
cp -r app/. build/
tizen package -t wgt -s "$PROFILE" -- build
WGT=$(ls build/*.wgt | head -1)
cp "$WGT" PlexHDR.wgt
echo "Built PlexHDR.wgt"

if [ -n "$TV_IP" ]; then
  sdb connect "$TV_IP"
  TARGET=$(sdb devices | awk -v ip="$TV_IP" '$1 ~ ip {print $3}')
  tizen install -n PlexHDR.wgt -t "$TARGET"
  echo "Installed. Open it from Apps on the TV (it shows as 'Plex HDR')."
fi
