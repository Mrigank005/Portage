import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // The app lives inside the Portage monorepo, so tell Next where the workspace root is.
  turbopack: { root: path.join(here, "../..") },
};

export default nextConfig;
