import type { NextConfig } from 'next';

const isGitHubPages = process.env.GITHUB_PAGES === 'true';
const repositoryBasePath = '/Storyborad-script-Organaizer';

const nextConfig: NextConfig = isGitHubPages
  ? {
      output: 'export',
      basePath: repositoryBasePath,
      assetPrefix: repositoryBasePath,
      trailingSlash: true,
      images: { unoptimized: true },
      env: { NEXT_PUBLIC_BASE_PATH: repositoryBasePath },
    }
  : {};

export default nextConfig;
