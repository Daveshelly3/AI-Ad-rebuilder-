/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // sharp is a server-only native dep; keep it external to the bundle.
    serverComponentsExternalPackages: ["sharp"],
  },
};

module.exports = nextConfig;
