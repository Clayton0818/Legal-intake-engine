/** @type {import('next').NextConfig} */
const nextConfig = {
  // ADR-0001 §D3: Next.js hosts the admin console and (for now, via an
  // iframe-embedded route) the client-facing chat surface. The chat widget
  // itself becomes a standalone embeddable bundle before any real firm
  // deploys it — see ADR-0001 §D3's caveat — which is a change to make here
  // when c23 gets to that point, not before.
  reactStrictMode: true,
};

export default nextConfig;
