import { createHash } from "node:crypto";
import { load } from "cheerio";
import { XMLParser } from "fast-xml-parser";
import type { DiscoveredFeed, NormalizedItem, SourceConfig } from "./types.ts";
import { fetchWafProtectedText, normalizeWafUrl } from "./waf.ts";

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type ChallengeFetcher = (url: string, accept: string, timeoutMs: number) => Promise<string>;

export interface FetchOptions {
  challengeFetcher?: ChallengeFetcher;
  fetcher?: Fetcher;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
}

const feedAccept = "application/atom+xml, application/rss+xml, application/xml, text/xml";

class WafChallengeError extends Error {}
class FatalFetchError extends Error {}
const defaultChallengeFetcher: ChallengeFetcher = (url, accept, timeoutMs) =>
  fetchWafProtectedText(url, accept, timeoutMs, {});

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
    const url = new URL(raw, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function content(value: string): string | undefined {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized === "" ? undefined : normalized;
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

export function parseWebPage(html: string, source: SourceConfig, fetchedAt = new Date()): NormalizedItem[] {
  const selectors = source.selectors;
  if (selectors === undefined) {
    throw new Error(`Web selectors are required for source ${source.id}`);
  }
  const $ = load(html);
  const elements = $(selectors.item);
  if (elements.length === 0) {
    throw new Error(`No items matched selector: ${selectors.item}`);
  }
  const items: NormalizedItem[] = [];
  elements.each((_index, element) => {
    const item = $(element);
    const title = content(item.find(selectors.title).first().text());
    const link = absoluteUrl(item.find(selectors.link).first().attr("href"), source.url);
    if (title === undefined || link === undefined) {
      return;
    }
    const dateElement = selectors.date === undefined ? undefined : item.find(selectors.date).first();
    const publishedAt = dateElement === undefined
      ? undefined
      : isoDate(dateElement.attr("datetime") ?? dateElement.text());
    const summary = selectors.summary === undefined
      ? undefined
      : content(item.find(selectors.summary).first().text());
    items.push({
      sourceId: source.id,
      title,
      url: link,
      ...(publishedAt === undefined ? {} : { publishedAt }),
      fetchedAt: fetchedAt.toISOString(),
      ...(summary === undefined ? {} : { summary }),
      categories: source.categories,
      method: "web",
      dedupeKey: dedupeKey(link),
    });
  });
  if (items.length === 0) {
    throw new Error("No valid items found on listing page");
  }
  return items;
}

async function retry<T>(operation: () => Promise<T>, sleep: (milliseconds: number) => Promise<void>): Promise<T> {
  const delays = [1_000, 2_000, 4_000];
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (error instanceof FatalFetchError) {
        throw error;
      }
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
  const wafAction = response.headers.get("x-waf-action");
  if (wafAction === "block" || wafAction === "challenge") {
    throw new WafChallengeError(wafAction);
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.text();
}

async function requestTextWithWaf(
  url: string,
  accept: string,
  options: FetchOptions,
): Promise<string> {
  const target = normalizeWafUrl(url);
  const timeoutMs = options.timeoutMs ?? 15_000;
  try {
    return await requestText(target, accept, options.fetcher ?? globalThis.fetch, timeoutMs);
  } catch (error) {
    if (!(error instanceof WafChallengeError)) {
      throw error;
    }
    try {
      return await (options.challengeFetcher ?? defaultChallengeFetcher)(target, accept, timeoutMs);
    } catch (cause) {
      throw new FatalFetchError(`Cannot complete browser challenge for ${target}: ${(cause as Error).message}`, {
        cause,
      });
    }
  }
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
  const sleep = options.sleep ?? defaultSleep;
  return retry(async () => {
    const html = await requestTextWithWaf(url, "text/html, application/xhtml+xml", options);
    return discoverFeedsFromHtml(html, url);
  }, sleep);
}

export async function fetchFeed(source: SourceConfig, fetchedAt: Date, options: FetchOptions = {}): Promise<NormalizedItem[]> {
  const sleep = options.sleep ?? defaultSleep;
  return retry(async () => {
    const accept = source.type === "auto" || source.type === "web"
      ? `text/html, application/xhtml+xml, ${feedAccept}`
      : feedAccept;
    const content = await requestTextWithWaf(source.url, accept, options);
    if (source.type === "web") {
      return parseWebPage(content, source, fetchedAt);
    }
    try {
      return parseFeed(content, source, fetchedAt);
    } catch (error) {
      if (source.type !== "auto") {
        throw error;
      }
      const discovered = discoverFeedsFromHtml(content, source.url)[0];
      if (discovered === undefined) {
        if (source.selectors !== undefined) {
          return parseWebPage(content, source, fetchedAt);
        }
        throw new Error("No RSS or Atom feed discovered");
      }
      const xml = await requestTextWithWaf(discovered.url, feedAccept, options);
      return parseFeed(xml, { ...source, url: discovered.url, type: discovered.type }, fetchedAt);
    }
  }, sleep);
}
