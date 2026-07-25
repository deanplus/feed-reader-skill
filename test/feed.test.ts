import assert from "node:assert/strict";
import test from "node:test";
import { discoverFeeds, discoverFeedsFromHtml, fetchFeed, parseFeed, parseWebPage } from "../src/feed.ts";
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
      <item><title>Unsafe link</title><link>javascript:alert(1)</link></item>
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

test("fetchFeed completes recognized WAF challenges without retrying browser failures", async () => {
  const wafSource = {
    ...source,
    url: "https://example.com/forum.php?mod=rss&fid=81&auth=0",
  };
  const requested: string[] = [];
  const result = await fetchFeed(wafSource, fetchedAt, {
    fetcher: async (input) => {
      requested.push(String(input));
      return new Response("challenge", { headers: { "x-waf-action": "challenge" } });
    },
    challengeFetcher: async (url, accept, timeoutMs) => {
      assert.equal(url, "https://example.com/forum.php?mod=rss&fid=81");
      assert.match(accept, /application\/rss\+xml/);
      assert.equal(timeoutMs, 321);
      return "<rss><channel><item><title>Protected</title><link>https://example.com/protected</link></item></channel></rss>";
    },
    timeoutMs: 321,
  });
  assert.deepEqual(requested, ["https://example.com/forum.php?mod=rss&fid=81"]);
  assert.equal(result[0]?.title, "Protected");

  let challengeCalls = 0;
  await assert.rejects(fetchFeed(wafSource, fetchedAt, {
    fetcher: async () => new Response("blocked", { status: 403, headers: { "x-waf-action": "block" } }),
    challengeFetcher: async () => {
      challengeCalls += 1;
      throw new Error("Chrome unavailable");
    },
    sleep: async () => assert.fail("fatal browser failures must not retry"),
  }), /Cannot complete browser challenge.*Chrome unavailable/);
  assert.equal(challengeCalls, 1);
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

test("discoverFeedsFromHtml finds, resolves, and deduplicates RSS and Atom links", () => {
  assert.deepEqual(discoverFeedsFromHtml(`
    <html><head>
      <link rel="stylesheet" href="/style.css">
      <link type="application/rss+xml" href="/missing-rel">
      <link rel="alternate" href="/missing-type">
      <link rel="alternate stylesheet" type="application/rss+xml" href="/rss.xml" title=" News ">
      <link rel="ALTERNATE" type="application/atom+xml; charset=utf-8" href="atom.xml">
      <link rel="alternate" type="application/rss+xml" href="/rss.xml">
      <link rel="alternate" type="text/html" href="/not-feed">
      <link rel="alternate" type="application/rss+xml">
      <link rel="alternate" type="application/rss+xml" href="http://[bad">
      <link rel="alternate" type="application/rss+xml" href="javascript:alert(1)">
      <link rel="alternate" type="application/atom+xml" href="/untitled" title=" ">
    </head></html>
  `, "https://example.com/blog/"), [{
    url: "https://example.com/rss.xml",
    type: "rss",
    title: "News",
  }, {
    url: "https://example.com/blog/atom.xml",
    type: "atom",
  }, {
    url: "https://example.com/untitled",
    type: "atom",
  }]);
  assert.deepEqual(discoverFeedsFromHtml("<html/>", "https://example.com"), []);
});

test("discoverFeeds retries HTTP failures and supports the built-in fetch", async () => {
  const delays: number[] = [];
  let calls = 0;
  const discovered = await discoverFeeds("https://example.com/blog", {
    timeoutMs: 25,
    sleep: async (delay) => { delays.push(delay); },
    fetcher: async () => {
      calls += 1;
      return calls === 1
        ? new Response("offline", { status: 503 })
        : new Response('<link rel="alternate" type="application/rss+xml" href="/feed">');
    },
  });
  assert.equal(discovered[0]?.url, "https://example.com/feed");
  assert.deepEqual(delays, [1_000]);

  const html = '<link rel="alternate" type="application/atom+xml" href="https://example.com/atom">';
  assert.equal((await discoverFeeds(`data:text/html,${encodeURIComponent(html)}`))[0]?.type, "atom");
});

test("fetchFeed auto mode accepts direct feeds and follows discovered feeds", async () => {
  const direct = await fetchFeed({ ...source, type: "auto" }, fetchedAt, {
    fetcher: async () => new Response("<rss><channel><item><title>Direct</title><link>https://example.com/direct</link></item></channel></rss>"),
  });
  assert.equal(direct[0]?.title, "Direct");

  const requested: string[] = [];
  const discovered = await fetchFeed({ ...source, url: "https://example.com/blog", type: "auto" }, fetchedAt, {
    fetcher: async (input) => {
      requested.push(String(input));
      return String(input).endsWith("/blog")
        ? new Response('<link rel="alternate" type="application/atom+xml" href="/atom.xml">')
        : new Response('<feed><entry><title>Found</title><link href="/found"/></entry></feed>');
    },
  });
  assert.deepEqual(requested, ["https://example.com/blog", "https://example.com/atom.xml"]);
  assert.equal(discovered[0]?.title, "Found");
  assert.equal(discovered[0]?.url, "https://example.com/found");
});

test("fetchFeed auto mode reports pages without a feed", async () => {
  await assert.rejects(fetchFeed({ ...source, type: "auto" }, fetchedAt, {
    fetcher: async () => new Response("<html><title>No feed</title></html>"),
    sleep: async () => {},
  }), /No RSS or Atom feed discovered/);

  await assert.rejects(fetchFeed(source, fetchedAt, {
    fetcher: async () => new Response("<html/>"),
    sleep: async () => {},
  }), /Unsupported feed format/);
});

test("parseWebPage extracts configured listing content", () => {
  const webSource: SourceConfig = {
    id: "blog",
    url: "https://example.com/blog/",
    type: "web",
    categories: ["Tech"],
    selectors: {
      item: "article",
      title: "h2",
      link: "a.story",
      date: "time",
      summary: ".summary",
    },
  };
  const items = parseWebPage(`
    <article><h2> First   article </h2><a class="story" href="/first">Read</a><time datetime="2026-07-22">Today</time><p class="summary"> A useful\n summary. </p></article>
    <article><h2>Second</h2><a class="story" href="second"></a><time>not a date</time><p class="summary"> </p></article>
    <article><h2>Unsafe</h2><a class="story" href="javascript:alert(1)"></a></article>
    <article><a class="story" href="/missing-title"></a></article>
  `, webSource, fetchedAt);

  assert.equal(items.length, 2);
  assert.deepEqual(items[0], {
    sourceId: "blog",
    title: "First article",
    url: "https://example.com/first",
    publishedAt: "2026-07-22T00:00:00.000Z",
    fetchedAt: fetchedAt.toISOString(),
    summary: "A useful summary.",
    categories: ["Tech"],
    method: "web",
    dedupeKey: "f7f1d9a8680a796587390b067e36b64d751357c8edb949dc2844d2ec6b84442f",
  });
  assert.equal(items[1]?.publishedAt, undefined);
  assert.equal(items[1]?.summary, undefined);
});

test("parseWebPage rejects missing or unusable selectors", () => {
  assert.throws(() => parseWebPage("<article/>", source, fetchedAt), /selectors are required/);
  const configured: SourceConfig = {
    ...source,
    type: "web",
    selectors: { item: "article", title: "h2", link: "a" },
  };
  assert.throws(() => parseWebPage("<main/>", configured, fetchedAt), /No items matched/);
  assert.throws(() => parseWebPage("<article><h2>Missing link</h2></article>", configured, fetchedAt), /No valid items/);
});

test("fetchFeed reads explicit web sources and auto-falls back to selectors", async () => {
  const configured: SourceConfig = {
    ...source,
    url: "https://example.com/blog",
    type: "web",
    selectors: { item: "article", title: "h2", link: "a" },
  };
  const html = '<article><h2>Listing item</h2><a href="/listing-item"></a></article>';
  const explicit = await fetchFeed(configured, fetchedAt, { fetcher: async () => new Response(html) });
  assert.equal(explicit[0]?.method, "web");

  const automatic = await fetchFeed({ ...configured, type: "auto" }, fetchedAt, {
    fetcher: async () => new Response(html),
  });
  assert.equal(automatic[0]?.title, "Listing item");
});
