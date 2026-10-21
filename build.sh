#!/bin/sh
set -e
npm run build:core
npx esbuild packages/cli/src/index.ts --bundle --platform=node --target=node20 --outfile=dist/openinstinct.js \
  --external:onnxruntime-node --external:playwright --external:playwright-extra --external:ws
chmod +x dist/openinstinct.js
mkdir -p packages/cli/dist && cp dist/openinstinct.js packages/cli/dist/openinstinct.js
echo "built dist/openinstinct.js (→ packages/cli/dist for `npm i -g ./packages/cli`)"