import type { NextConfig } from "next";

const isGitHubPages = process.env.GITHUB_PAGES === "true";
const githubPagesBasePath = "/arch-s-tool";

const nextConfig: NextConfig = isGitHubPages
  ? {
      output: "export",
      basePath: githubPagesBasePath,
      assetPrefix: githubPagesBasePath,
      trailingSlash: true,
      images: { unoptimized: true },
      turbopack: { root: process.cwd() },
      // The Pages build does not include the Cloudflare-only database runtime.
      // The normal vinext build still performs the project type check.
      typescript: { ignoreBuildErrors: true },
    }
  : {};

export default nextConfig;
