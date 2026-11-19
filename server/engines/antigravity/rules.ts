/**
 * Pencocok untuk subset sintaks rule izin Claude Code yang dipakai `server/roles.ts`, supaya mesin
 * Antigravity membaca aturan role yang sama — bukan salinannya.
 *
 *   Read, Glob, TodoWrite            nama tool saja
 *   mcp__team__*                     nama tool dengan `*` di akhir
 *   Bash(npm test:*)                 perintah yang diawali `npm test`
 *   Bash(git status)                 perintah persis
 *   Edit(//abs/path/**)              path absolut, glob `*` dan `**`
 */

export type ParsedRule = { tool: string; spec?: string };

export function parseRule(rule: string): ParsedRule {
  const open = rule.indexOf("(");
  if (open < 0 || !rule.endsWith(")")) return { tool: rule };
  return { tool: rule.slice(0, open), spec: rule.slice(open + 1, -1) };
}

/** `mcp__team__*` cocok dengan `mcp__team__remember`; tanpa `*` harus persis. */
export function toolMatches(pattern: string, tool: string): boolean {
  if (pattern.endsWith("*")) return tool.startsWith(pattern.slice(0, -1));
  return pattern === tool;
}

/** Glob path rule: `**` melintasi folder, `*` satu segmen. `//abs` = path absolut `/abs`. */
export function globToRegExp(spec: string): RegExp {
  const pattern = spec.startsWith("//") ? spec.slice(1) : spec;
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? "";
    if (char === "*" && pattern[index + 1] === "*") {
      // `/**/` boleh kosong: `/a/**/notes.md` cocok dengan `/a/notes.md`.
      if (pattern[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

export function pathMatches(spec: string, path: string): boolean {
  return globToRegExp(spec).test(path);
}

/** `npm test:*` cocok dengan `npm test` dan `npm test -- --watch`, tidak dengan `npm tester`. */
export function commandMatches(spec: string, command: string): boolean {
  const text = command.trim();
  if (spec.endsWith(":*")) {
    const prefix = spec.slice(0, -2);
    return text === prefix || (text.startsWith(prefix) && /\s/.test(text[prefix.length] ?? ""));
  }
  return text === spec;
}

/**
 * Pecah perintah majemuk di `&&`, `||`, `;`, `|`, dan baris baru — di luar kutipan. Rule allow
 * harus cocok dengan SETIAP bagian; rule deny cukup satu bagian.
 */
export function splitCommand(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (quote) {
      current += char;
      if (char === "\\" && quote === '"') {
        current += command[index + 1] ?? "";
        index += 1;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    const two = command.slice(index, index + 2);
    if (two === "&&" || two === "||") {
      parts.push(current);
      current = "";
      index += 1;
      continue;
    }
    if (char === ";" || char === "|" || char === "\n") {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** Substitusi perintah dan redirect tidak bisa dinilai dari awal string: tidak pernah lolos allow-list. */
export function hasHiddenEffects(command: string): boolean {
  return /\$\(|`|(^|[^<>&\d])>{1,2}(?!&)|<\(/.test(command);
}

/** Rule `Bash(...)` di daftar ini yang cocok dengan perintah. */
export function matchBashRules(
  rules: string[],
  command: string,
  mode: "every" | "some",
): boolean {
  const specs = rules
    .map(parseRule)
    .filter((rule) => rule.tool === "Bash" && rule.spec !== undefined)
    .map((rule) => rule.spec as string);
  if (specs.length === 0) return false;
  const parts = splitCommand(command);
  if (parts.length === 0) return false;
  const matched = (part: string) => specs.some((spec) => commandMatches(spec, part));
  return mode === "every" ? parts.every(matched) : parts.some(matched);
}

/** Rule path (`Read(…)`, `Edit(…)`, `Write(…)`) untuk salah satu tool ini yang cocok dengan path. */
export function matchPathRules(rules: string[], tools: string[], path: string): string | undefined {
  for (const rule of rules) {
    const parsed = parseRule(rule);
    if (!tools.includes(parsed.tool) || parsed.spec === undefined) continue;
    if (pathMatches(parsed.spec, path)) return rule;
  }
  return undefined;
}

/** Rule nama tool saja (`Read`, `mcp__team__*`) yang cocok. */
export function matchToolRules(rules: string[], tool: string): boolean {
  return rules.map(parseRule).some((rule) => rule.spec === undefined && toolMatches(rule.tool, tool));
}
