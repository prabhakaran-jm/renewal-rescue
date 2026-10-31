import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  // Avoid picking a parent lockfile as workspace root on this machine.
  outputFileTracingRoot: root,
};

export default nextConfig;
