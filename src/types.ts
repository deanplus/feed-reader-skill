export interface WebSelectors {
  item: string;
  title: string;
  link: string;
  date?: string;
  summary?: string;
}

export interface SourceConfig {
  id: string;
  url: string;
  type: "auto" | "rss" | "atom" | "web";
  categories: string[];
  selectors?: WebSelectors;
}

export interface FeedConfig {
  project?: string;
  sources: SourceConfig[];
}

export interface DiscoveredFeed {
  url: string;
  type: "rss" | "atom";
  title?: string;
}

export interface NormalizedItem {
  sourceId: string;
  title: string;
  url: string;
  publishedAt?: string;
  fetchedAt: string;
  summary?: string;
  categories: string[];
  method: "rss" | "web";
  dedupeKey: string;
}

export interface SourceSyncResult {
  sourceId: string;
  status: "ok" | "error";
  baseline: boolean;
  itemCount: number;
  newItemCount: number;
  error?: string;
}
export interface SyncResult {
  project: string;
  newItems: NormalizedItem[];
  sources: SourceSyncResult[];
}

export interface SourceStatus {
  sourceId: string;
  url: string;
  status: "pending" | "ok" | "error";
  lastSuccessAt?: string;
  lastFailureAt?: string;
  error?: string;
}
