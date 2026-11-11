// Reading and writing the few settings Portage needs from an app's env files.
//
// Portage reads only the keys it asks for (never whole files into its output), and it never returns values to the
// agent: callers get the values for internal use and, separately, which file each one came from (safe to show).
import fs from "node:fs";
import path from "node:path";

const LINE = /^[ \t]*(?:export[ \t]+)?([A-Za-z0-9_]+)[ \t]*=[ \t]*(.*)$/;

export interface EnvRead<K extends string> {
  values: Partial<Record<K, string>>;
  from: Partial<Record<K, string>>;
}

/** First value wins, in file order, then the process environment. Files may be relative to appDir or absolute. */
export function readEnv<K extends string>(appDir: string, files: string[], keys: readonly K[]): EnvRead<K> {
  const values: Partial<Record<K, string>> = {};
  const from: Partial<Record<K, string>> = {};
  for (const f of files) {
    let text: string;
    try {
      text = fs.readFileSync(path.resolve(appDir, f), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const m = LINE.exec(line);
      if (!m || !(keys as readonly string[]).includes(m[1])) continue;
      const k = m[1] as K;
      const v = m[2].trim().replace(/^(["'])(.*)\1$/, "$2");
      if (v && values[k] === undefined) {
        values[k] = v;
        from[k] = f;
      }
    }
  }
  for (const k of keys) {
    if (values[k] === undefined && process.env[k]) {
      values[k] = process.env[k];
      from[k] = "process environment";
    }
  }
  return { values, from };
}

/**
 * Sets keys in one env file, replacing existing lines in place and appending the rest. Creates the file if needed.
 * Returns which keys were replaced and which were added (never the values).
 */
export function writeEnv(file: string, updates: Record<string, string>): { replaced: string[]; added: string[] } {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    /* new file */
  }
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.length ? text.split(/\r?\n/) : [];
  const replaced: string[] = [];
  const pending = new Map(Object.entries(updates));
  for (let i = 0; i < lines.length; i++) {
    const m = LINE.exec(lines[i]);
    if (m && pending.has(m[1])) {
      lines[i] = `${m[1]}=${pending.get(m[1])}`;
      replaced.push(m[1]);
      pending.delete(m[1]);
    }
  }
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  const added = [...pending.keys()];
  for (const [k, v] of pending) lines.push(`${k}=${v}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join(eol) + eol);
  return { replaced, added };
}
