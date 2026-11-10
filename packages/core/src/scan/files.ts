// Walking a repository safely: skip dependency and build folders, never follow symlinks out of the repo,
// cap file sizes, and never read real environment files (only example files, and only their key names).
import fs from "node:fs";
import path from "node:path";

const IGNORED_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", ".next", ".nuxt", ".svelte-kit", ".turbo", ".vercel", ".netlify", ".output",
  "dist", "build", "out", "coverage", ".cache", ".parcel-cache", "vendor", "venv", ".venv", "__pycache__",
  ".portage", ".standin", ".idea", ".vscode", "bower_components", "jspm_packages", "storybook-static", "target",
]);

export const MAX_FILE_BYTES = 1_500_000;
export const MAX_FILES = 40_000;

export const toPosix = (p: string) => p.split(path.sep).join("/");

/** Every file under `root`, as POSIX paths relative to it. */
export function walk(root: string): string[] {
  const out: string[] = [];
  const stack = [""];
  while (stack.length && out.length < MAX_FILES) {
    const rel = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue; // never leave the repository through a link
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name)) stack.push(childRel);
      } else if (e.isFile()) {
        out.push(childRel);
        if (out.length >= MAX_FILES) break;
      }
    }
  }
  return out.sort();
}

export function readText(abs: string): string | null {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    return fs.readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

export const CODE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
export const WEB_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|html|htm|ejs|hbs|handlebars|pug|vue|svelte|astro)$/;

export const isCodeFile = (rel: string) => CODE_EXT.test(rel) && !/\.d\.[cm]?ts$/.test(rel) && !/\.min\.js$/.test(rel);

export function isTestPath(rel: string): boolean {
  return (
    /(^|\/)(__tests__|__mocks__|tests?|e2e|cypress|playwright|fixtures?|mocks?|spec)\//i.test(rel) ||
    /\.(test|spec|stories)\.[cm]?[jt]sx?$/i.test(rel)
  );
}

/** Example env files, which document variable names. Real env files (.env, .env.local...) are never read. */
export function isEnvExampleFile(rel: string): boolean {
  const name = rel.split("/").pop()!;
  return /^\.env([.\-_][\w.-]*)?[.\-_](example|sample|template|dist|defaults)$/i.test(name) || /^env\.(example|sample|template)$/i.test(name);
}

/** Variable names declared in an example env file. Values are deliberately dropped. */
export function envKeys(text: string): string[] {
  const keys: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m && !keys.includes(m[1])) keys.push(m[1]);
  }
  return keys;
}

export function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

export function clip(s: string, max = 140): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}
