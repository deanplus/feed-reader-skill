import { createHash } from "node:crypto";
import { load } from "cheerio";
import { XMLParser } from "fast-xml-parser";
import type { DiscoveredFeed, NormalizedItem, SourceConfig } from "./types.ts";

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface FetchOptions {
  fetcher?: Fetcher;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
}

const feedAccept = "application/atom+xml, application/rss+xml, application/xml, text/xml";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseTagValue: false,
  trimValues: true,
});

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

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

async function retry<T>(operation: () => Promise<T>, sleep: (milliseconds: number) => Promise<void>): Promise<T> {
  const delays = [1_000, 2_000, 4_000];
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < delays.length) {
        await sleep(delays[attempt]);
      }
    }
  }
  throw lastError;
}

async function requestText(url: string, accept: string, fetcher: Fetcher, timeoutMs: number): Promise<string> {
  const response = await fetcher(url, {
    headers: {
      accept,
      "user-agent": "feed-reader-skill/0.0.0",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.text();
}

export function discoverFeedsFromHtml(html: string, pageUrl: string): DiscoveredFeed[] {
  const $ = load(html);
  const feeds: DiscoveredFeed[] = [];
  const seen = new Set<string>();
  $("link").each((_index, element) => {
    const link = $(element);
    const rel = (link.attr("rel") ?? "").toLowerCase().split(/\s+/);
    if (!rel.includes("alternate")) {
      return;
    }
    const mediaType = (link.attr("type") ?? "").split(";", 1)[0]?.trim().toLowerCase();
    const type = mediaType === "application/rss+xml"
      ? "rss"
      : mediaType === "application/atom+xml" ? "atom" : undefined;
    const href = link.attr("href");
    if (type === undefined || href === undefined) {
      return;
    }
    let url: string;
    try {
      const parsed = new URL(href, pageUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return;
      }
      url = parsed.toString();
    } catch {
      return;
    }
    if (seen.has(url)) {
      return;
    }
    seen.add(url);
    const title = link.attr("title")?.trim();
    feeds.push(title === undefined || title === "" ? { url, type } : { url, type, title });
  });
  return feeds;
}

export async function discoverFeeds(url: string, options: FetchOptions = {}): Promise<DiscoveredFeed[]> {
  const fetcher = options.fetcher ?? globalThis.fetch;
  const sleep = options.sleep ?? defaultSleep;
  return retry(async () => {
    const html = await requestText(url, "text/html, application/xhtml+xml", fetcher, options.timeoutMs ?? 15_000);
    return discoverFeedsFromHtml(html, url);
  }, sleep);
}

export async function fetchFeed(source: SourceConfig, fetchedAt: Date, options: FetchOptions = {}): Promise<NormalizedItem[]> {
  const fetcher = options.fetcher ?? globalThis.fetch;
  const sleep = options.sleep ?? defaultSleep;
  return retry(async () => {
    const accept = source.type === "auto" ? `text/html, application/xhtml+xml, ${feedAccept}` : feedAccept;
    const content = await requestText(source.url, accept, fetcher, options.timeoutMs ?? 15_000);
    try {
      return parseFeed(content, source, fetchedAt);
    } catch (error) {
      if (source.type !== "auto") {
        throw error;
      }
      const discovered = discoverFeedsFromHtml(content, source.url)[0];
      if (discovered === undefined) {
        throw new Error("No RSS or Atom feed discovered");
      }
      const xml = await requestText(discovered.url, feedAccept, fetcher, options.timeoutMs ?? 15_000);
      return parseFeed(xml, { ...source, url: discovered.url, type: discovered.type }, fetchedAt);
    }
  }, sleep);
}
