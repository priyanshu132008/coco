#!/bin/sh
set -e
npm run build:core
npx esbuild packages/cli/src/index.ts --bundle --platform=node --target=node20 --outfile=dist/coco.js \
  --external:onnxruntime-node --external:playwright --external:playwright-extra --external:ws
chmod +x dist/coco.js
mkdir -p packages/cli/dist && cp dist/coco.js packages/cli/dist/coco.js
echo "built dist/coco.js (→ packages/cli/dist for `npm i -g ./packages/cli`)"