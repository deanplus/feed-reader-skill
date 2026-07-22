import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { FeedConfig, SourceConfig, WebSelectors } from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function parseSelectors(value: unknown, index: number): WebSelectors | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`sources[${index}].selectors must be an object`);
  }
  const selectors: WebSelectors = {
    item: nonEmptyString(value.item, `sources[${index}].selectors.item`),
    title: nonEmptyString(value.title, `sources[${index}].selectors.title`),
    link: nonEmptyString(value.link, `sources[${index}].selectors.link`),
  };
  for (const name of ["date", "summary"] as const) {
    if (value[name] !== undefined) {
      selectors[name] = nonEmptyString(value[name], `sources[${index}].selectors.${name}`);
    }
  }
  return selectors;
}

function parseSource(value: unknown, index: number): SourceConfig {
  if (!isRecord(value)) {
    throw new Error(`sources[${index}] must be an object`);
  }

  const id = nonEmptyString(value.id, `sources[${index}].id`);
  const url = nonEmptyString(value.url, `sources[${index}].url`);
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error(`sources[${index}].url must use http or https`);
  }

  const type = value.type ?? "auto";
  if (type !== "auto" && type !== "rss" && type !== "atom" && type !== "web") {
    throw new Error(`sources[${index}].type must be auto, rss, atom, or web`);
  }

  const selectors = parseSelectors(value.selectors, index);
  if (type === "web" && selectors === undefined) {
    throw new Error(`sources[${index}].selectors is required for web sources`);
  }

  const categories = value.categories ?? [];
  if (!Array.isArray(categories)) {
    throw new Error(`sources[${index}].categories must be an array`);
  }

  return {
    id,
    url: parsedUrl.toString(),
    type,
    categories: [...new Set(categories.map((category, categoryIndex) =>
      nonEmptyString(category, `sources[${index}].categories[${categoryIndex}]`)))],
    ...(selectors === undefined ? {} : { selectors }),
  };
}

export function parseConfig(value: unknown): FeedConfig {
  if (!isRecord(value)) {
    throw new Error("config must be an object");
  }
  if (!Array.isArray(value.sources)) {
    throw new Error("config.sources must be an array");
  }

  const project = value.project === undefined
    ? undefined
    : nonEmptyString(value.project, "config.project");
  const sources = value.sources.map(parseSource);
  const ids = new Set<string>();
  for (const source of sources) {
    if (ids.has(source.id)) {
      throw new Error(`duplicate source id: ${source.id}`);
    }
    ids.add(source.id);
  }

  return project === undefined ? { sources } : { project, sources };
}

export async function loadConfig(path: string): Promise<FeedConfig> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    const message = (error as Error).message;
    throw new Error(`Cannot read config ${path}: ${message}`);
  }
  return parseConfig(value);
}

export async function saveConfig(path: string, config: FeedConfig): Promise<void> {
  const value = parseConfig(config);
  const temporary = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}
