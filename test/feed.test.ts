import assert from "node:assert/strict";
import test from "node:test";
import { fetchFeed, parseFeed } from "../src/feed.ts";
import type { SourceConfig } from "../src/types.ts";

const source: SourceConfig = {
  id: "source",
  url: "https://example.com/feed.xml",
  type: "rss",
  categories: ["AI"],
};
const fetchedAt = new Date("2026-07-22T01:00:00.000Z");

test("parseFeed normalizes RSS entries and ignores unusable items", () => {
  const items = parseFeed(`
    <rss><channel>
      <item>
        <title type="text">First</title>
        <link>/first</link>
        <guid>guid-1</guid>
        <pubDate>Wed, 22 Jul 2026 00:00:00 GMT</pubDate>
        <content:encoded>Full summary</content:encoded>
      </item>
      <item>
        <title>Second</title>
        <link>https://example.com/second</link>
        <dc:date>not-a-date</dc:date>
        <description>Description</description>
      </item>
      <item><title>Third</title><link>https://example.com/third</link><date>2026-07-20</date></item>
      <item><title>Missing link</title></item>
      <item><link>https://example.com/missing-title</link></item>
      <item><title>Bad link</title><link>http://[bad</link></item>
      <item><title> </title><link>https://example.com/blank-title</link></item>
      <item>text only</item>
    </channel></rss>
  `, source, fetchedAt);

  assert.equal(items.length, 3);
  assert.deepEqual(items[0], {
    sourceId: "source",
    title: "First",
    url: "https://example.com/first",
    publishedAt: "2026-07-22T00:00:00.000Z",
    fetchedAt: fetchedAt.toISOString(),
    summary: "Full summary",
    categories: ["AI"],
    method: "rss",
    dedupeKey: "c1ce8282f097d63fd8eb33f7daba41a79061644926d27c8f6b636fecbc527a70",
  });
  assert.equal(items[1]?.publishedAt, undefined);
  assert.equal(items[1]?.summary, "Description");
  assert.equal(items[2]?.publishedAt, "2026-07-20T00:00:00.000Z");
  assert.equal(items[2]?.summary, undefined);
});

test("parseFeed normalizes Atom link variants and content fallbacks", () => {
  const items = parseFeed(`
    <feed>
      <entry>
        <title>First Atom</title>
        <link rel="self" href="/self"/>
        <link rel="alternate" href="/atom-first"/>
        <id>atom-1</id>
        <published>2026-07-22T00:00:00Z</published>
        <summary>Summary</summary>
      </entry>
      <entry>
        <title>Second Atom</title>
        <link>https://example.com/atom-second</link>
        <updated>2026-07-21T00:00:00Z</updated>
        <content>Content</content>
      </entry>
      <entry><title>Ignored</title><link rel="self" href="/only-self"/></entry>
    </feed>
  `, { ...source, type: "atom" }, fetchedAt);

  assert.equal(items.length, 2);
  assert.equal(items[0]?.url, "https://example.com/atom-first");
  assert.equal(items[0]?.summary, "Summary");
  assert.equal(items[1]?.url, "https://example.com/atom-second");
  assert.equal(items[1]?.summary, "Content");
  assert.notEqual(items[0]?.dedupeKey, items[1]?.dedupeKey);
});

test("parseFeed rejects unsupported documents and supports its default timestamp", () => {
  assert.throws(() => parseFeed("<html/>", source, fetchedAt), /Unsupported feed format/);
  assert.deepEqual(parseFeed("<rss><channel><title>Empty</title></channel></rss>", source, fetchedAt), []);
  const [item] = parseFeed("<rss><channel><item><title>A</title><link>https://example.com/a</link></item></channel></rss>", source);
  assert.match(item?.fetchedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
});

test("fetchFeed retries with 1/2/4 second backoff and succeeds", async () => {
  const delays: number[] = [];
  let calls = 0;
  const result = await fetchFeed(source, fetchedAt, {
    timeoutMs: 123,
    sleep: async (delay) => { delays.push(delay); },
    fetcher: async (_input, init) => {
      calls += 1;
      assert.ok(init?.signal instanceof AbortSignal);
      if (calls === 1) {
        return new Response("error", { status: 503 });
      }
      if (calls < 4) {
        throw new Error("temporary");
      }
      return new Response("<rss><channel><item><title>A</title><link>https://example.com/a</link></item></channel></rss>");
    },
  });
  assert.equal(result.length, 1);
  assert.equal(calls, 4);
  assert.deepEqual(delays, [1_000, 2_000, 4_000]);
});

test("fetchFeed throws the final failure", async () => {
  let calls = 0;
  await assert.rejects(fetchFeed(source, fetchedAt, {
    sleep: async () => {},
    fetcher: async () => {
      calls += 1;
      throw new Error("offline");
    },
  }), /offline/);
  assert.equal(calls, 4);
});

test("fetchFeed uses its default delay function", async () => {
  let calls = 0;
  const items = await fetchFeed(source, fetchedAt, {
    fetcher: async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("retry once");
      }
      return new Response("<rss><channel><item><title>A</title><link>https://example.com/a</link></item></channel></rss>");
    },
  });
  assert.equal(calls, 2);
  assert.equal(items.length, 1);
});

test("fetchFeed uses the built-in fetch defaults", async () => {
  const xml = "<rss><channel><item><title>Local</title><link>https://example.com/article</link></item></channel></rss>";
  const items = await fetchFeed({ ...source, url: `data:application/xml,${encodeURIComponent(xml)}` }, fetchedAt);
  assert.equal(items[0]?.url, "https://example.com/article");
});
