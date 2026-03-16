import type { FrontMatterCache } from "obsidian";
import { prepareSimpleSearch } from "obsidian";
import type { TaskItem } from "../models/types";
import type { OutlineFilterToken } from "../models/view-types";

export function filterTasksByQuery(tasks: TaskItem[], query: string): TaskItem[] {
  const tokens = parseFilterTokens(query);
  if (tokens.length === 0) return tasks;
  return tasks.filter((task) => taskMatchesFilter(task, tokens));
}

export function parseFilterTokens(query: string): OutlineFilterToken[] {
  const out: OutlineFilterToken[] = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(query)) !== null) {
    const raw = (match[1] ?? match[2] ?? "").trim();
    if (!raw) continue;

    let token = raw;
    let negated = false;
    if (token.startsWith("-") && token.length > 1) {
      negated = true;
      token = token.slice(1);
    }

    const propertyQualifier = /^(?:prop|fm):([^=:\s]+)(?:=(.+))?$/i.exec(token);
    if (propertyQualifier) {
      const prop = propertyQualifier[1]?.trim();
      const rawValue = propertyQualifier[2]?.trim();
      if (!prop) continue;

      out.push({
        key: "prop",
        prop,
        value: rawValue ? rawValue.replace(/^['"]|['"]$/g, "") : null,
        negated
      });
      continue;
    }

    const qualifier = /^(path|file):(.*)$/i.exec(token);
    const key = (qualifier?.[1]?.toLowerCase() as "path" | "file" | undefined) ?? "any";
    const value = (qualifier ? qualifier[2] : token).trim();
    if (!value) continue;

    out.push({ key, value, negated });
  }

  return out;
}

function taskMatchesFilter(task: TaskItem, tokens: OutlineFilterToken[]): boolean {
  const pathText = task.path.toLowerCase();
  const basename = task.basename;
  const fileText = task.kind === "file"
    ? `${task.file.basename} ${task.file.name}`.toLowerCase()
    : basename.toLowerCase();
  const anyText = task.kind === "file"
    ? `${task.file.basename} ${task.file.path}`.toLowerCase()
    : `${basename} ${task.path}`.toLowerCase();

  for (const token of tokens) {
    if (token.key === "prop") {
      const fm = task.kind === "file" ? task.frontmatter : undefined;
      const matches = matchesFrontmatterFilter(fm, token.prop, token.value);
      if (token.negated ? matches : !matches) {
        return false;
      }
      continue;
    }

    const matcher = prepareSimpleSearch(token.value.toLowerCase());
    const target = token.key === "path" ? pathText : token.key === "file" ? fileText : anyText;
    const matches = matcher(target) !== null;
    if (token.negated ? matches : !matches) {
      return false;
    }
  }

  return true;
}

export function matchesFrontmatterFilter(
  frontmatter: FrontMatterCache | undefined,
  key: string,
  expectedValue: string | null
): boolean {
  if (!frontmatter || !(key in frontmatter)) {
    return false;
  }

  if (expectedValue == null) {
    return true;
  }

  const expected = expectedValue.toLowerCase();
  const values = flattenFrontmatterValues(frontmatter[key]);
  return values.some((value) => value.toLowerCase() === expected);
}

export function flattenFrontmatterValues(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => flattenFrontmatterValues(entry));
  }

  if (value == null) {
    return [""];
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return [String(value).trim()];
  }

  try {
    return [JSON.stringify(value)];
  } catch {
    return [String(value)];
  }
}
