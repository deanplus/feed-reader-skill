import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import type { NormalizedItem, SourceConfig } from "./types.ts";

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface FetchOptions {
  fetcher?: Fetcher;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseTagValue: false,
  trimValues: true,
});

function array(value: unknown): unknown[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  }
  const object = record(value);
  return object === undefined ? undefined : text(object["#text"]);
}

function absoluteUrl(value: unknown, base: string): string | undefined {
  const raw = text(value);
  if (raw === undefined) {
    return undefined;
  }
  try {
    return new URL(raw, base).toString();
  } catch {
    return undefined;
  }
}

function isoDate(value: unknown): string | undefined {
  const raw = text(value);
  if (raw === undefined) {
    return undefined;
  }
  const date = new Date(raw);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

function dedupeKey(identity: string): string {
  return createHash("sha256").update(identity).digest("hex");
}

function atomLink(value: unknown, base: string): string | undefined {
  for (const candidate of array(value)) {
    if (typeof candidate === "string") {
      return absoluteUrl(candidate, base);
    }
    const object = record(candidate);
    if (object?.["@_href"] !== undefined && (object["@_rel"] === undefined || object["@_rel"] === "alternate")) {
      return absoluteUrl(object["@_href"], base);
    }
  }
  return undefined;
}

function normalize(
  source: SourceConfig,
  fetchedAt: string,
  raw: Record<string, unknown>,
  atom: boolean,
): NormalizedItem | undefined {
  const title = text(raw.title);
  const url = atom
    ? atomLink(raw.link, source.url)
    : absoluteUrl(raw.link, source.url);
  if (title === undefined || url === undefined) {
    return undefined;
  }

  const publishedAt = isoDate(atom
    ? raw.published ?? raw.updated
    : raw.pubDate ?? raw["dc:date"] ?? raw.date);
  const summary = text(atom
    ? raw.summary ?? raw.content
    : raw["content:encoded"] ?? raw.description);
  const identity = text(atom ? raw.id : raw.guid) ?? url;

  return {
    sourceId: source.id,
    title,
    url,
    ...(publishedAt === undefined ? {} : { publishedAt }),
    fetchedAt,
    ...(summary === undefined ? {} : { summary }),
    categories: source.categories,
    method: "rss",
    dedupeKey: dedupeKey(identity),
  };
}

export function parseFeed(xml: string, source: SourceConfig, fetchedAt = new Date()): NormalizedItem[] {
  const document = record(parser.parse(xml));
  const channel = record(record(document?.rss)?.channel);
  if (channel !== undefined) {
    return array(channel.item)
      .map(record)
      .filter((item): item is Record<string, unknown> => item !== undefined)
      .map((item) => normalize(source, fetchedAt.toISOString(), item, false))
      .filter((item): item is NormalizedItem => item !== undefined);
  }

  const feed = record(document?.feed);
  if (feed !== undefined) {
    return array(feed.entry)
      .map(record)
      .filter((item): item is Record<string, unknown> => item !== undefined)
      .map((item) => normalize(source, fetchedAt.toISOString(), item, true))
      .filter((item): item is NormalizedItem => item !== undefined);
  }

  throw new Error("Unsupported feed format");
}

export async function fetchFeed(source: SourceConfig, fetchedAt: Date, options: FetchOptions = {}): Promise<NormalizedItem[]> {
  const fetcher = options.fetcher ?? globalThis.fetch;
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const delays = [1_000, 2_000, 4_000];

  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetcher(source.url, {
        headers: {
          accept: "application/atom+xml, application/rss+xml, application/xml, text/xml",
          "user-agent": "feed-reader-skill/0.0.0",
        },
        signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return parseFeed(await response.text(), source, fetchedAt);
    } catch (error) {
      lastError = error;
      if (attempt < delays.length) {
        await sleep(delays[attempt]);
      }
    }
  }
  throw lastError;
}
