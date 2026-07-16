/** @type {import('next').NextConfig} */
const nextConfig = {
  // This example intentionally has its own lockfile inside the jGDINA monorepo.
  turbopack: { root: import.meta.dirname },
  // Keep the Node adapter and its adjacent worker-entry asset intact.
  serverExternalPackages: ["@jgdina/node"],
};

export default nextConfig;
