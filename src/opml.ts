import { readFile } from "node:fs/promises";
import { XMLParser } from "fast-xml-parser";
import { loadConfig, saveConfig } from "./config.ts";
import type { FeedConfig, SourceConfig } from "./types.ts";

interface ImportOptions {
  project?: string;
  category?: string;
}

export interface ImportResult {
  configPath: string;
  project: string;
  imported: number;
  total: number;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseAttributeValue: false,
  trimValues: true,
});

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function array(value: unknown): unknown[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function attribute(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function slug(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function sourceId(title: string | undefined, url: URL): string {
  return slug(title ?? "") || slug(url.hostname);
}

export function parseOpml(xml: string, extraCategory?: string): SourceConfig[] {
  const document = record(parser.parse(xml));
  const body = record(record(document?.opml)?.body);
  if (body === undefined) {
    throw new Error("Invalid OPML: missing opml/body");
  }

  const sources = new Map<string, SourceConfig>();
  const ids = new Set<string>();
  const visit = (value: unknown, categories: string[]): void => {
    const outline = record(value);
    if (outline === undefined) {
      return;
    }
    const title = attribute(outline["@_text"]) ?? attribute(outline["@_title"]);
    const xmlUrl = attribute(outline["@_xmlUrl"]);
    if (xmlUrl === undefined) {
      const nestedCategories = title === undefined ? categories : [...categories, title];
      for (const child of array(outline.outline)) {
        visit(child, nestedCategories);
      }
      return;
    }

    const url = new URL(xmlUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`Invalid OPML feed URL: ${xmlUrl}`);
    }
    const sourceCategories = [...new Set([...categories, ...(extraCategory === undefined ? [] : [extraCategory])])];
    const existing = sources.get(url.toString());
    if (existing !== undefined) {
      existing.categories = [...new Set([...existing.categories, ...sourceCategories])];
      return;
    }

    const baseId = sourceId(title, url);
    let id = baseId;
    for (let suffix = 2; ids.has(id); suffix += 1) {
      id = `${baseId}-${suffix}`;
    }
    ids.add(id);
    sources.set(url.toString(), {
      id,
      url: url.toString(),
      type: attribute(outline["@_type"])?.toLowerCase() === "atom" ? "atom" : "rss",
      categories: sourceCategories,
    });
  };

  for (const outline of array(body.outline)) {
    visit(outline, []);
  }
  return [...sources.values()];
}

export function mergeFeedConfig(config: FeedConfig, imported: SourceConfig[], project?: string): FeedConfig {
  const sources = config.sources.map((source) => ({ ...source, categories: [...source.categories] }));
  const byUrl = new Map(sources.map((source) => [source.url, source]));
  const ids = new Set(sources.map((source) => source.id));
  for (const source of imported) {
    const existing = byUrl.get(source.url);
    if (existing !== undefined) {
      existing.categories = [...new Set([...existing.categories, ...source.categories])];
      continue;
    }
    const baseId = source.id;
    let id = baseId;
    for (let suffix = 2; ids.has(id); suffix += 1) {
      id = `${baseId}-${suffix}`;
    }
    ids.add(id);
    const added = { ...source, id, categories: [...source.categories] };
    sources.push(added);
    byUrl.set(added.url, added);
  }
  const resolvedProject = project ?? config.project;
  return resolvedProject === undefined ? { sources } : { project: resolvedProject, sources };
}

export async function importOpmlFile(
  opmlPath: string,
  configPath: string,
  options: ImportOptions = {},
): Promise<ImportResult> {
  const imported = parseOpml(await readFile(opmlPath, "utf8"), options.category);
  let config: FeedConfig;
  try {
    config = await loadConfig(configPath);
  } catch (error) {
    if (!(error as Error).message.includes("ENOENT")) {
      throw error;
    }
    config = { sources: [] };
  }
  const merged = mergeFeedConfig(config, imported, options.project);
  await saveConfig(configPath, merged);
  return {
    configPath,
    project: merged.project ?? "default",
    imported: imported.length,
    total: merged.sources.length,
  };
}
