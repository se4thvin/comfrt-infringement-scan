/** @type {import('next').NextConfig} */
const nextConfig = {
  // sharp is a native module; keep it external to the server bundle
  experimental: { serverComponentsExternalPackages: ['sharp'] },
};
export default nextConfig;
