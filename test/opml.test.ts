import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { importOpmlFile, mergeFeedConfig, parseOpml } from "../src/opml.ts";
import type { FeedConfig, SourceConfig } from "../src/types.ts";

const opml = `
  <opml version="2.0"><body>
    <outline text="Tech">
      <outline text="AI">
        <outline text="Example" type="rss" xmlUrl="https://example.com/feed"/>
        <outline title="Atom" type="atom" xmlUrl="https://example.com/atom"/>
      </outline>
      <outline text="Duplicate" xmlUrl="https://example.com/feed"/>
    </outline>
    <outline text="Same ID" xmlUrl="https://same.example/feed"/>
    <outline title="Same ID" xmlUrl="https://second.example/feed"/>
    <outline text="中文" xmlUrl="https://chinese.example/feed"/>
    <outline><outline xmlUrl="https://untitled.example/feed"/></outline>
    <outline>ignored text</outline>
  </body></opml>
`;

test("parseOpml preserves nested categories, merges URLs, and creates stable IDs", () => {
  assert.deepEqual(parseOpml(opml, "Imported"), [{
    id: "example",
    url: "https://example.com/feed",
    type: "rss",
    categories: ["Tech", "AI", "Imported"],
  }, {
    id: "atom",
    url: "https://example.com/atom",
    type: "atom",
    categories: ["Tech", "AI", "Imported"],
  }, {
    id: "same-id",
    url: "https://same.example/feed",
    type: "rss",
    categories: ["Imported"],
  }, {
    id: "same-id-2",
    url: "https://second.example/feed",
    type: "rss",
    categories: ["Imported"],
  }, {
    id: "chinese-example",
    url: "https://chinese.example/feed",
    type: "rss",
    categories: ["Imported"],
  }, {
    id: "untitled-example",
    url: "https://untitled.example/feed",
    type: "rss",
    categories: ["Imported"],
  }]);
  assert.deepEqual(parseOpml("<opml><body><title>Empty</title></body></opml>"), []);
});

test("parseOpml rejects malformed documents and unsafe URLs", () => {
  assert.throws(() => parseOpml("<html/>"), /missing opml\/body/);
  assert.throws(
    () => parseOpml('<opml><body><outline xmlUrl="mailto:test@example.com"/></body></opml>'),
    /Invalid OPML feed URL/,
  );
  assert.throws(
    () => parseOpml('<opml><body><outline xmlUrl="://"/></body></opml>'),
    /Invalid URL/,
  );
});

test("mergeFeedConfig merges URLs, resolves ID collisions, and preserves inputs", () => {
  const config: FeedConfig = {
    project: "existing",
    sources: [{
      id: "example",
      url: "https://example.com/feed",
      type: "rss",
      categories: ["Existing"],
    }],
  };
  const imported: SourceConfig[] = [{
    id: "example",
    url: "https://example.com/feed",
    type: "rss",
    categories: ["Imported"],
  }, {
    id: "example",
    url: "https://other.example/feed",
    type: "rss",
    categories: [],
  }];

  assert.deepEqual(mergeFeedConfig(config, imported), {
    project: "existing",
    sources: [{
      id: "example",
      url: "https://example.com/feed",
      type: "rss",
      categories: ["Existing", "Imported"],
    }, {
      id: "example-2",
      url: "https://other.example/feed",
      type: "rss",
      categories: [],
    }],
  });
  assert.deepEqual(config.sources[0]?.categories, ["Existing"]);
  assert.equal(mergeFeedConfig(config, [], "override").project, "override");
  assert.deepEqual(mergeFeedConfig({ sources: [] }, []), { sources: [] });
});

test("importOpmlFile creates and merges reviewable JSON config", async () => {
  const directory = await mkdtemp(join(tmpdir(), "feed-reader-opml-"));
  const opmlPath = join(directory, "feeds.opml");
  const configPath = join(directory, "nested", "feed-reader.json");
  await writeFile(opmlPath, opml);

  const created = await importOpmlFile(opmlPath, configPath, { project: "demo", category: "Extra" });
  assert.deepEqual(created, { configPath, project: "demo", imported: 6, total: 6 });
  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(saved.project, "demo");
  assert.equal(saved.sources[0].categories.includes("Extra"), true);

  const merged = await importOpmlFile(opmlPath, configPath);
  assert.deepEqual(merged, { configPath, project: "demo", imported: 6, total: 6 });

  await writeFile(configPath, "{");
  await assert.rejects(importOpmlFile(opmlPath, configPath), /Cannot read config/);

  const defaultConfigPath = join(directory, "default.json");
  assert.deepEqual(
    await importOpmlFile(opmlPath, defaultConfigPath),
    { configPath: defaultConfigPath, project: "default", imported: 6, total: 6 },
  );
});
