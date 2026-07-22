import type { FetchOptions } from "./feed.ts";
import { fetchFeed } from "./feed.ts";
import type { FeedDatabase } from "./database.ts";
import type { FeedConfig, SyncResult } from "./types.ts";

export interface SyncOptions extends FetchOptions {
  project?: string;
  now?: () => Date;
}

export async function syncFeeds(config: FeedConfig, database: FeedDatabase, options: SyncOptions = {}): Promise<SyncResult> {
  const project = options.project ?? config.project ?? "default";
  const now = options.now ?? (() => new Date());
  const result: SyncResult = { project, newItems: [], sources: [] };

  for (const source of config.sources) {
    const fetchedAt = now();
    const baseline = !database.hasSuccessfulSync(project, source.id);
    try {
      const items = await fetchFeed(source, fetchedAt, options);
      const inserted = database.insertItems(project, items);
      database.recordSuccess(project, source.id, source.url, fetchedAt.toISOString());
      const newItems = baseline ? [] : inserted;
      result.newItems.push(...newItems);
      result.sources.push({
        sourceId: source.id,
        status: "ok",
        baseline,
        itemCount: items.length,
        newItemCount: newItems.length,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      database.recordFailure(project, source.id, source.url, message, fetchedAt.toISOString());
      result.sources.push({
        sourceId: source.id,
        status: "error",
        baseline,
        itemCount: 0,
        newItemCount: 0,
        error: message,
      });
    }
  }

  return result;
}
