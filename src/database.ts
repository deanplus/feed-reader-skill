import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import type { NormalizedItem, SourceConfig, SourceStatus } from "./types.ts";

interface SourceRow {
  source_id: string;
  url: string;
  type: SourceConfig["type"];
  categories: string;
  selectors: string | null;
}

interface SourceStateRow {
  source_id: string;
  url: string;
  status: "ok" | "error";
  last_success_at: string | null;
  last_failure_at: string | null;
  last_error: string | null;
}

interface ItemRow {
  source_id: string;
  title: string;
  url: string;
  published_at: string | null;
  fetched_at: string;
  summary: string | null;
  categories: string;
  method: NormalizedItem["method"];
  dedupe_key: string;
}

export interface ItemFilters {
  sourceId?: string;
  category?: string;
  since?: Date;
}

export function defaultDatabasePath(
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  let base: string;
  if (env.XDG_DATA_HOME !== undefined) {
    base = env.XDG_DATA_HOME;
  } else if (platform === "win32") {
    base = env.APPDATA ?? join(home, "AppData", "Roaming");
  } else if (platform === "darwin") {
    base = join(home, "Library", "Application Support");
  } else {
    base = join(home, ".local", "share");
  }
  return join(base, "feed-reader", "feed-reader.sqlite");
}

export class FeedDatabase {
  readonly #database: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.#database = new Database(path);
    this.#database.pragma("journal_mode = WAL");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS source_state (
        project TEXT NOT NULL,
        source_id TEXT NOT NULL,
        url TEXT NOT NULL,
        status TEXT NOT NULL,
        last_success_at TEXT,
        last_failure_at TEXT,
        last_error TEXT,
        PRIMARY KEY (project, source_id)
      );
      CREATE TABLE IF NOT EXISTS sources (
        project TEXT NOT NULL,
        source_id TEXT NOT NULL,
        url TEXT NOT NULL,
        type TEXT NOT NULL,
        categories TEXT NOT NULL,
        selectors TEXT,
        PRIMARY KEY (project, source_id),
        UNIQUE (project, url)
      );
      CREATE TABLE IF NOT EXISTS items (
        project TEXT NOT NULL,
        source_id TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        published_at TEXT,
        fetched_at TEXT NOT NULL,
        summary TEXT,
        categories TEXT NOT NULL,
        method TEXT NOT NULL,
        PRIMARY KEY (project, source_id, dedupe_key)
      );
    `);
  }

  close(): void {
    this.#database.close();
  }

  hasSuccessfulSync(project: string, sourceId: string): boolean {
    const row = this.#database.prepare(`
      SELECT last_success_at FROM source_state WHERE project = ? AND source_id = ?
    `).get(project, sourceId) as { last_success_at: string | null } | undefined;
    return row?.last_success_at !== null && row?.last_success_at !== undefined;
  }

  upsertSources(project: string, sources: SourceConfig[]): void {
    const upsert = this.#database.prepare(`
      INSERT INTO sources (project, source_id, url, type, categories, selectors)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(project, source_id) DO UPDATE SET
        url = excluded.url,
        type = excluded.type,
        categories = excluded.categories,
        selectors = excluded.selectors
    `);
    this.#database.transaction((values: SourceConfig[]) => {
      for (const source of values) {
        upsert.run(
          project,
          source.id,
          source.url,
          source.type,
          JSON.stringify(source.categories),
          source.selectors === undefined ? null : JSON.stringify(source.selectors),
        );
      }
    })(sources);
  }

  listSources(project: string): SourceConfig[] {
    const rows = this.#database.prepare(`
      SELECT source_id, url, type, categories, selectors
      FROM sources
      WHERE project = ?
      ORDER BY source_id
    `).all(project) as SourceRow[];
    return rows.map((row) => ({
      id: row.source_id,
      url: row.url,
      type: row.type,
      categories: JSON.parse(row.categories) as string[],
      ...(row.selectors === null ? {} : { selectors: JSON.parse(row.selectors) as SourceConfig["selectors"] }),
    }));
  }

  removeSource(project: string, sourceId: string): boolean {
    return this.#database.prepare(`
      DELETE FROM sources WHERE project = ? AND source_id = ?
    `).run(project, sourceId).changes === 1;
  }

  recordSuccess(project: string, sourceId: string, url: string, at: string): void {
    this.#database.prepare(`
      INSERT INTO source_state (project, source_id, url, status, last_success_at)
      VALUES (?, ?, ?, 'ok', ?)
      ON CONFLICT(project, source_id) DO UPDATE SET
        url = excluded.url,
        status = 'ok',
        last_success_at = excluded.last_success_at,
        last_error = NULL
    `).run(project, sourceId, url, at);
  }

  recordFailure(project: string, sourceId: string, url: string, error: string, at: string): void {
    this.#database.prepare(`
      INSERT INTO source_state (project, source_id, url, status, last_failure_at, last_error)
      VALUES (?, ?, ?, 'error', ?, ?)
      ON CONFLICT(project, source_id) DO UPDATE SET
        url = excluded.url,
        status = 'error',
        last_failure_at = excluded.last_failure_at,
        last_error = excluded.last_error
    `).run(project, sourceId, url, at, error);
  }

  insertItems(project: string, items: NormalizedItem[]): NormalizedItem[] {
    const insert = this.#database.prepare(`
      INSERT OR IGNORE INTO items (
        project, source_id, dedupe_key, title, url, published_at,
        fetched_at, summary, categories, method
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const run = this.#database.transaction((values: NormalizedItem[]) => {
      const inserted: NormalizedItem[] = [];
      for (const item of values) {
        const result = insert.run(
          project,
          item.sourceId,
          item.dedupeKey,
          item.title,
          item.url,
          item.publishedAt ?? null,
          item.fetchedAt,
          item.summary ?? null,
          JSON.stringify(item.categories),
          item.method,
        );
        if (result.changes === 1) {
          inserted.push(item);
        }
      }
      return inserted;
    });
    return run(items);
  }

  listItems(project: string, filters: ItemFilters = {}): NormalizedItem[] {
    const rows = this.#database.prepare(`
      SELECT source_id, title, url, published_at, fetched_at, summary,
             categories, method, dedupe_key
      FROM items
      WHERE project = ?
    `).all(project) as ItemRow[];

    return rows
      .map((row) => ({
        sourceId: row.source_id,
        title: row.title,
        url: row.url,
        ...(row.published_at === null ? {} : { publishedAt: row.published_at }),
        fetchedAt: row.fetched_at,
        ...(row.summary === null ? {} : { summary: row.summary }),
        categories: JSON.parse(row.categories) as string[],
        method: row.method,
        dedupeKey: row.dedupe_key,
      }))
      .filter((item) => filters.sourceId === undefined || item.sourceId === filters.sourceId)
      .filter((item) => filters.category === undefined || item.categories.includes(filters.category))
      .filter((item) => filters.since === undefined || new Date(item.publishedAt ?? item.fetchedAt) >= filters.since)
      .sort((left, right) => (right.publishedAt ?? right.fetchedAt).localeCompare(left.publishedAt ?? left.fetchedAt));
  }

  listStatuses(project: string): SourceStatus[] {
    const rows = this.#database.prepare(`
      SELECT source_id, url, status, last_success_at, last_failure_at, last_error
      FROM source_state
      WHERE project = ?
      ORDER BY source_id
    `).all(project) as SourceStateRow[];
    return rows.map((row) => ({
      sourceId: row.source_id,
      url: row.url,
      status: row.status,
      ...(row.last_success_at === null ? {} : { lastSuccessAt: row.last_success_at }),
      ...(row.last_failure_at === null ? {} : { lastFailureAt: row.last_failure_at }),
      ...(row.last_error === null ? {} : { error: row.last_error }),
    }));
  }

  listSourceStatuses(project: string, sources: SourceConfig[]): SourceStatus[] {
    const states = new Map(this.listStatuses(project).map((status) => [status.sourceId, status]));
    return [...sources]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((source) => {
        const state = states.get(source.id);
        return state === undefined
          ? { sourceId: source.id, url: source.url, status: "pending" }
          : { ...state, url: source.url };
      });
  }
}
