/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // Native server-only deps; keep them external to the bundle.
    serverComponentsExternalPackages: ["sharp", "@resvg/resvg-js"],
    // Ensure bundled fonts (and the mock background) are traced into the
    // serverless functions that read them at runtime.
    outputFileTracingIncludes: {
      "/api/compose": ["./assets/fonts/**/*"],
      "/api/generate": ["./public/mock-bg.jpg"],
    },
  },
};

module.exports = nextConfig;
