#!/bin/sh
set -e
npm run build:core
npx esbuild packages/cli/src/index.ts --bundle --platform=node --target=node20 --outfile=dist/openinstinct.js
chmod +x dist/openinstinct.js
echo "built dist/openinstinct.js"