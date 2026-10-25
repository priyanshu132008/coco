/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // the engine hosts native/heavy deps (core's stealth chain can't be statically analyzed) — keep them out of the bundle
    serverComponentsExternalPackages: ['@coco/core', 'onnxruntime-node', 'playwright', 'playwright-extra', 'playwright-core', 'puppeteer-extra-plugin-stealth', 'ws'],
  },
}

module.exports = nextConfig