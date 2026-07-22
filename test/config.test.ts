import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import test from "node:test";
import { loadConfig, parseConfig } from "../src/config.ts";

test("parseConfig normalizes valid sources and optional project", () => {
  assert.deepEqual(parseConfig({
    project: " news ",
    sources: [{
      id: " source ",
      url: "https://example.com/feed",
      categories: ["AI", "AI"],
    }, {
      id: "atom",
      url: "http://example.com/atom.xml",
      type: "atom",
    }],
  }), {
    project: "news",
    sources: [{
      id: "source",
      url: "https://example.com/feed",
      type: "auto",
      categories: ["AI"],
    }, {
      id: "atom",
      url: "http://example.com/atom.xml",
      type: "atom",
      categories: [],
    }],
  });
  assert.deepEqual(parseConfig({ sources: [] }), { sources: [] });
});

test("parseConfig rejects invalid input", () => {
  const invalid: Array<[unknown, RegExp]> = [
    [[], /config must be an object/],
    [{}, /config.sources must be an array/],
    [{ project: "", sources: [] }, /config.project/],
    [{ sources: ["bad"] }, /sources\[0\] must be an object/],
    [{ sources: [{ id: "", url: "https://example.com" }] }, /sources\[0\]\.id/],
    [{ sources: [{ id: "x", url: "" }] }, /sources\[0\]\.url/],
    [{ sources: [{ id: "x", url: "mailto:test@example.com" }] }, /must use http or https/],
    [{ sources: [{ id: "x", url: "https://example.com", type: "web" }] }, /type must be/],
    [{ sources: [{ id: "x", url: "https://example.com", categories: "AI" }] }, /categories must be an array/],
    [{ sources: [{ id: "x", url: "https://example.com", categories: [""] }] }, /categories\[0\]/],
    [{ sources: [
      { id: "x", url: "https://example.com/a" },
      { id: "x", url: "https://example.com/b" },
    ] }, /duplicate source id: x/],
  ];
  for (const [value, pattern] of invalid) {
    assert.throws(() => parseConfig(value), pattern);
  }
  assert.throws(
    () => parseConfig({ sources: [{ id: "x", url: "://" }] }),
    /Invalid URL/,
  );
});

test("loadConfig reads valid JSON and contextualizes file errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "feed-reader-config-"));
  const valid = join(directory, "valid.json");
  const invalid = join(directory, "invalid.json");
  await writeFile(valid, JSON.stringify({ sources: [] }));
  await writeFile(invalid, "{");

  assert.deepEqual(await loadConfig(valid), { sources: [] });
  await assert.rejects(loadConfig(invalid), /Cannot read config.*JSON/);
  await assert.rejects(loadConfig(join(directory, "missing.json")), /Cannot read config.*ENOENT/);
});
