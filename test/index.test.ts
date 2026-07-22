import assert from "node:assert/strict";
import test from "node:test";
import * as api from "../src/index.ts";

test("the public API exports the core feed reader surface", () => {
  assert.deepEqual(Object.keys(api).sort(), [
    "FeedDatabase",
    "defaultDatabasePath",
    "fetchFeed",
    "loadConfig",
    "parseConfig",
    "parseFeed",
    "syncFeeds",
  ]);
});
