// Works out which web framework an app uses, from its package.json and its file layout.
import fs from "node:fs";
import path from "node:path";
import type { Framework } from "../types.ts";

export interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: unknown;
}

export function readPackageJson(dir: string): PackageJson | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as PackageJson;
  } catch {
    return null;
  }
}

export const allDeps = (pkg: PackageJson | null): Record<string, string> => ({ ...(pkg?.devDependencies ?? {}), ...(pkg?.dependencies ?? {}) });

/** Installed version if node_modules has it, otherwise the version range from package.json without its operator. */
export function depVersion(appDir: string, repoDir: string, name: string, deps: Record<string, string>): string | undefined {
  for (const dir of [appDir, repoDir]) {
    try {
      const v = JSON.parse(fs.readFileSync(path.join(dir, "node_modules", name, "package.json"), "utf8")).version;
      if (typeof v === "string") return v;
    } catch {
      /* not installed here */
    }
  }
  const range = deps[name];
  if (!range) return undefined;
  const m = /(\d+(?:\.\d+){0,2})/.exec(range);
  return m ? m[1] : range;
}

const OTHER_FRAMEWORKS: [string, string][] = [
  ["@nestjs/core", "NestJS"],
  ["fastify", "Fastify"],
  ["koa", "Koa"],
  ["hono", "Hono"],
  ["@hapi/hapi", "hapi"],
  ["@remix-run/node", "Remix"],
  ["@remix-run/react", "Remix"],
  ["@react-router/node", "React Router (framework mode)"],
  ["@sveltejs/kit", "SvelteKit"],
  ["nuxt", "Nuxt"],
  ["astro", "Astro"],
  ["@redwoodjs/api", "RedwoodJS"],
  ["@adonisjs/core", "AdonisJS"],
  ["@solidjs/start", "SolidStart"],
  ["@tanstack/react-start", "TanStack Start"],
];

/**
 * @param files files in the app, relative to the app root (POSIX)
 */
export function detectFramework(appDir: string, repoDir: string, pkg: PackageJson | null, rootPkg: PackageJson | null, files: string[]): Framework {
  const deps = { ...allDeps(rootPkg), ...allDeps(pkg) };
  if (deps.next) {
    const hasApp = files.some((f) => /^(src\/)?app\/(.+\/)?(route|page|layout)\.[cm]?[jt]sx?$/.test(f));
    const hasPages = files.some((f) => /^(src\/)?pages\/.+\.[cm]?[jt]sx?$/.test(f));
    const router = hasApp && hasPages ? "both" : hasPages ? "pages" : "app";
    const version = depVersion(appDir, repoDir, "next", deps);
    const label = `Next.js${version ? ` ${version}` : ""} (${router === "both" ? "App Router and Pages Router" : router === "app" ? "App Router" : "Pages Router"})`;
    return { id: "next", label, version, router, supported: true };
  }
  if (deps.express) {
    const version = depVersion(appDir, repoDir, "express", deps);
    return { id: "express", label: `Express${version ? ` ${version}` : ""}`, version, supported: true };
  }
  const other = OTHER_FRAMEWORKS.find(([dep]) => deps[dep]);
  if (other) {
    const version = depVersion(appDir, repoDir, other[0], deps);
    return { id: "unsupported", label: `${other[1]}${version ? ` ${version}` : ""}`, version, supported: false };
  }
  return { id: "none", label: "Node.js with no recognised web framework", supported: false };
}
