import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  typedRoutes: true,
  transpilePackages: ['@agentbase/shared'],
};

export default config;
