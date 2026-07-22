import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultDatabasePath, FeedDatabase } from "../src/database.ts";
import { syncFeeds } from "../src/sync.ts";
import type { FeedConfig, NormalizedItem } from "../src/types.ts";

const first: NormalizedItem = {
  sourceId: "source",
  title: "First",
  url: "https://example.com/first",
  publishedAt: "2026-07-21T00:00:00.000Z",
  fetchedAt: "2026-07-22T00:00:00.000Z",
  summary: "Summary",
  categories: ["AI"],
  method: "rss",
  dedupeKey: "first",
};
const second: NormalizedItem = {
  sourceId: "other",
  title: "Second",
  url: "https://example.com/second",
  fetchedAt: "2026-07-23T00:00:00.000Z",
  categories: [],
  method: "rss",
  dedupeKey: "second",
};

test("defaultDatabasePath follows each platform convention", () => {
  assert.equal(defaultDatabasePath("darwin", {}, "/home/u"), "/home/u/Library/Application Support/feed-reader/feed-reader.sqlite");
  assert.equal(defaultDatabasePath("darwin", { XDG_DATA_HOME: "/data" }, "/home/u"), "/data/feed-reader/feed-reader.sqlite");
  assert.equal(defaultDatabasePath("win32", { APPDATA: "C:/Data" }, "C:/Users/u"), "C:/Data/feed-reader/feed-reader.sqlite");
  assert.equal(defaultDatabasePath("win32", {}, "C:/Users/u"), "C:/Users/u/AppData/Roaming/feed-reader/feed-reader.sqlite");
  assert.equal(defaultDatabasePath("linux", {}, "/home/u"), "/home/u/.local/share/feed-reader/feed-reader.sqlite");
});

test("FeedDatabase persists state, deduplicates, filters, and sorts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "feed-reader-db-"));
  const database = new FeedDatabase(join(directory, "nested", "state.sqlite"));
  assert.equal(database.hasSuccessfulSync("project", "source"), false);

  database.recordFailure("project", "source", "https://example.com/feed", "offline", "2026-07-20T00:00:00.000Z");
  assert.equal(database.hasSuccessfulSync("project", "source"), false);
  assert.deepEqual(database.listStatuses("project"), [{
    sourceId: "source",
    url: "https://example.com/feed",
    status: "error",
    lastFailureAt: "2026-07-20T00:00:00.000Z",
    error: "offline",
  }]);

  database.recordSuccess("project", "source", "https://example.com/new-feed", "2026-07-22T00:00:00.000Z");
  assert.equal(database.hasSuccessfulSync("project", "source"), true);
  assert.deepEqual(database.insertItems("project", [first, second]), [first, second]);
  assert.deepEqual(database.insertItems("project", [first]), []);
  assert.deepEqual(database.insertItems("reverse", [second, first]), [second, first]);
  const publishedFirst = { ...first, sourceId: "a", dedupeKey: "published-first" };
  const undatedLast = { ...second, sourceId: "z", dedupeKey: "undated-last" };
  assert.deepEqual(database.insertItems("left-fallback", [publishedFirst, undatedLast]), [publishedFirst, undatedLast]);

  assert.deepEqual(database.listItems("project"), [second, first]);
  assert.deepEqual(database.listItems("project", { sourceId: "source" }), [first]);
  assert.deepEqual(database.listItems("project", { category: "AI" }), [first]);
  assert.deepEqual(database.listItems("project", { since: new Date("2026-07-22T12:00:00.000Z") }), [second]);
  assert.deepEqual(database.listItems("other"), []);
  assert.deepEqual(database.listItems("reverse"), [second, first]);
  assert.deepEqual(database.listItems("left-fallback"), [undatedLast, publishedFirst]);
  database.recordSuccess("project", "clean", "https://example.com/clean", "2026-07-23T00:00:00.000Z");
  assert.deepEqual(database.listStatuses("project"), [{
    sourceId: "clean",
    url: "https://example.com/clean",
    status: "ok",
    lastSuccessAt: "2026-07-23T00:00:00.000Z",
  }, {
    sourceId: "source",
    url: "https://example.com/new-feed",
    status: "ok",
    lastSuccessAt: "2026-07-22T00:00:00.000Z",
    lastFailureAt: "2026-07-20T00:00:00.000Z",
  }]);
  database.close();
});

test("syncFeeds establishes a baseline, returns later items, and isolates failures", async () => {
  const database = new FeedDatabase(":memory:");
  const config: FeedConfig = {
    project: "config-project",
    sources: [
      { id: "good", url: "https://example.com/feed", type: "rss", categories: ["AI"] },
      { id: "bad", url: "https://example.com/bad", type: "rss", categories: [] },
    ],
  };
  let run = 0;
  const fetcher = async (input: string | URL | Request) => {
    if (String(input).endsWith("/bad")) {
      throw run === 0 ? "unavailable" : new Error("still unavailable");
    }
    const extra = run === 0 ? "" : "<item><title>New</title><link>https://example.com/new</link></item>";
    return new Response(`<rss><channel><item><title>Old</title><link>https://example.com/old</link></item>${extra}</channel></rss>`);
  };
  const times = [
    new Date("2026-07-22T00:00:00.000Z"),
    new Date("2026-07-22T00:00:01.000Z"),
    new Date("2026-07-23T00:00:00.000Z"),
    new Date("2026-07-23T00:00:01.000Z"),
  ];
  const now = () => times.shift() as Date;

  const baseline = await syncFeeds(config, database, {
    project: "override",
    fetcher,
    sleep: async () => {},
    now,
  });
  assert.equal(baseline.project, "override");
  assert.equal(baseline.newItems.length, 0);
  assert.deepEqual(baseline.sources.map(({ status, baseline }) => ({ status, baseline })), [
    { status: "ok", baseline: true },
    { status: "error", baseline: true },
  ]);
  assert.equal(baseline.sources[1]?.error, "unavailable");

  run = 1;
  const incremental = await syncFeeds(config, database, { project: "override", fetcher, sleep: async () => {}, now });
  assert.equal(incremental.project, "override");
  assert.deepEqual(incremental.newItems.map((item) => item.title), ["New"]);
  assert.equal(incremental.sources[0]?.newItemCount, 1);
  assert.equal(incremental.sources[1]?.error, "still unavailable");

  const configProject = await syncFeeds({ project: "config-project", sources: [] }, database);
  assert.equal(configProject.project, "config-project");
  const defaultProject = await syncFeeds({ sources: [] }, database);
  assert.equal(defaultProject.project, "default");

  const liveTime = new Date();
  const live = await syncFeeds({ sources: [config.sources[0] as NonNullable<typeof config.sources[0]>] }, database, {
    fetcher: async () => new Response("<rss><channel><title>Empty</title></channel></rss>"),
  });
  assert.equal(live.sources[0]?.status, "ok");
  assert.ok(new Date(database.listStatuses("default")[0]?.lastSuccessAt ?? 0) >= liveTime);
  database.close();
});
