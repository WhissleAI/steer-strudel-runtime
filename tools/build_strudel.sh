#!/bin/bash
# Builds Compose's Strudel runtime (docs/MUSIC_COMPOSE.md) into Resources/strudel/strudel.js: the pinned @strudel/*
# packages and superdough (AGPL-3.0-or-later; the 2026-11-16 licence decision) plus our bridge (tools/strudel/
# steer_host.mjs) and the visuals' pattern views (viz.mjs, @strudel/draw), as one classic script the Music tab's
# WKWebView loads; and Resources/strudel/scene.js: the Scene layer (scene3d.mjs on Three.js, MIT), loaded by the page
# only when a scene is shown (docs/MUSIC_VIZ.md). Network only here (npm ci); the app never fetches anything.
# Versions: tools/strudel/package.json + package-lock.json.
set -euo pipefail
cd "$(dirname "$0")/strudel"
npm ci --no-audit --no-fund >/dev/null
OUT=../../Resources/strudel
mkdir -p "$OUT"
npx esbuild steer_host.mjs --bundle --format=iife --platform=browser --target=safari16 --minify \
  --legal-comments=none --log-level=error --outfile="$OUT/strudel.js"
npx esbuild scene3d.mjs --bundle --format=iife --platform=browser --target=safari16 --minify \
  --legal-comments=none --log-level=error --outfile="$OUT/scene.js"
{
  echo "Strudel runtime for Steer Compose, built by macos/tools/build_strudel.sh"
  echo "Licence: AGPL-3.0-or-later (Strudel contributors, https://codeberg.org/uzu/strudel)"
  echo "scene.js (the Scene layer): three.js $(node -p 'require("./node_modules/three/package.json").version') MIT (https://github.com/mrdoob/three.js); the scenes themselves are Steer's own (tools/strudel/scene3d.mjs)"
  echo "Packages:"
  node -e 'const l=require("./package-lock.json").packages;for(const [k,v] of Object.entries(l)){if(k.startsWith("node_modules/")&&!v.dev)console.log("  "+k.slice(13)+" "+v.version+" "+(v.license||""))}' | sort
  echo
  echo "three.js licence (scene.js):"
  cat node_modules/three/LICENSE
} > "$OUT/NOTICE.txt"
ls -l "$OUT/strudel.js" "$OUT/scene.js" | awk '{print $9 ": " $5 " bytes"}'
