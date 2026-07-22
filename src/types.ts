export interface SourceConfig {
  id: string;
  url: string;
  type: "auto" | "rss" | "atom";
  categories: string[];
}

export interface FeedConfig {
  project?: string;
  sources: SourceConfig[];
}

export interface NormalizedItem {
  sourceId: string;
  title: string;
  url: string;
  publishedAt?: string;
  fetchedAt: string;
  summary?: string;
  categories: string[];
  method: "rss";
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
  status: "ok" | "error";
  lastSuccessAt?: string;
  lastFailureAt?: string;
  error?: string;
}
