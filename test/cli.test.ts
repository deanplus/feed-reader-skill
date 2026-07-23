import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.ts";

interface Capture {
  stdout: string;
  stderr: string;
  io: {
    stdout: (value: string) => void;
    stderr: (value: string) => void;
  };
}

function capture(): Capture {
  const result: Capture = {
    stdout: "",
    stderr: "",
    io: {
      stdout: (value) => { result.stdout += value; },
      stderr: (value) => { result.stderr += value; },
    },
  };
  return result;
}

test("runCli handles help, missing commands, unknown options, and unknown commands", async () => {
  for (const flag of ["help", "--help", "-h"]) {
    const output = capture();
    assert.equal(await runCli([flag], { io: output.io }), 0);
    assert.match(output.stdout, /Usage:/);
  }

  const missing = capture();
  assert.equal(await runCli([], { io: missing.io }), 1);
  assert.match(missing.stderr, /Usage:/);

  const invalid = capture();
  assert.equal(await runCli(["status", "--unknown"], { io: invalid.io }), 1);
  assert.match(invalid.stderr, /Unknown option/);

  const directory = await mkdtemp(join(tmpdir(), "feed-reader-cli-errors-"));
  const unknown = capture();
  assert.equal(await runCli(["wat", "--db", join(directory, "db.sqlite")], { io: unknown.io }), 1);
  assert.match(unknown.stderr, /Unknown command: wat/);

  const positional = capture();
  assert.equal(await runCli(["status", "extra", "--db", join(directory, "db.sqlite")], { io: positional.io }), 1);
  assert.match(positional.stderr, /does not accept positional arguments/);
});

test("runCli discovers feeds in JSON and plain modes", async () => {
  const fetcher = async () => new Response('<link rel="alternate" type="application/rss+xml" href="/feed" title="Feed">');
  const json = capture();
  assert.equal(await runCli(["discover", "https://example.com", "--json"], { io: json.io, fetcher }), 0);
  assert.equal(JSON.parse(json.stdout).feeds[0].url, "https://example.com/feed");

  const plain = capture();
  assert.equal(await runCli(["discover", "https://example.com"], { io: plain.io, fetcher }), 0);
  assert.equal(plain.stdout, "rss\thttps://example.com/feed\tFeed\n");

  const untitled = capture();
  assert.equal(await runCli(["discover", "https://example.com"], {
    io: untitled.io,
    fetcher: async () => new Response('<link rel="alternate" type="application/atom+xml" href="/atom">'),
  }), 0);
  assert.equal(untitled.stdout, "atom\thttps://example.com/atom\t\n");

  const empty = capture();
  assert.equal(await runCli(["discover", "https://example.com"], {
    io: empty.io,
    fetcher: async () => new Response("<html/>"),
  }), 1);
  assert.equal(empty.stdout, "No RSS or Atom feed discovered.\n");

  for (const args of [["discover"], ["discover", "one", "two"]]) {
    const invalid = capture();
    assert.equal(await runCli(args, { io: invalid.io }), 1);
    assert.match(invalid.stderr, /requires exactly one URL/);
  }
});

test("runCli imports OPML into JSON config", async () => {
  const directory = await mkdtemp(join(tmpdir(), "feed-reader-cli-opml-"));
  const opml = join(directory, "feeds.opml");
  const config = join(directory, "feed-reader.json");
  await writeFile(opml, '<opml><body><outline text="Tech"><outline text="Feed" xmlUrl="https://example.com/rss"/></outline></body></opml>');

  const json = capture();
  assert.equal(await runCli(["feeds", "import", opml, "--config", config, "--project", "demo", "--category", "Imported", "--json"], { io: json.io }), 0);
  assert.deepEqual(JSON.parse(json.stdout), { configPath: config, project: "demo", imported: 1, total: 1 });

  const plain = capture();
  assert.equal(await runCli(["feeds", "import", opml, "--config", config], { io: plain.io }), 0);
  assert.match(plain.stdout, /Imported 1 feeds; 1 total/);

  for (const args of [["feeds"], ["feeds", "add", opml]]) {
    const invalid = capture();
    assert.equal(await runCli(args, { io: invalid.io }), 1);
    assert.match(invalid.stderr, /feeds requires/);
  }
});

test("runCli registers, lists, syncs, and removes project sources", async () => {
  const directory = await mkdtemp(join(tmpdir(), "feed-reader-cli-registry-"));
  const config = join(directory, "feeds.json");
  const database = join(directory, "state.sqlite");
  await writeFile(config, JSON.stringify({
    project: "registered",
    sources: [{ id: "feed", url: "https://example.com/feed", categories: ["AI"] }],
  }));

  const imported = capture();
  assert.equal(await runCli(["feeds", "import", config, "--db", database, "--json"], { io: imported.io }), 0);
  assert.deepEqual(JSON.parse(imported.stdout), { project: "registered", imported: 1, total: 1 });

  const repeated = capture();
  assert.equal(await runCli(["feeds", "import", config, "--db", database, "--category", "Imported", "--json"], { io: repeated.io }), 0);
  assert.equal(JSON.parse(repeated.stdout).total, 1);

  const list = capture();
  assert.equal(await runCli(["feeds", "list", "--project", "registered", "--db", database, "--json"], { io: list.io }), 0);
  assert.deepEqual(JSON.parse(list.stdout).sources[0].categories, ["AI", "Imported"]);

  const pending = capture();
  assert.equal(await runCli(["status", "--project", "registered", "--db", database, "--json"], { io: pending.io }), 0);
  assert.equal(JSON.parse(pending.stdout).sources[0].status, "pending");

  const synced = capture();
  assert.equal(await runCli(["sync", "--project", "registered", "--db", database, "--json"], {
    io: synced.io,
    fetcher: async () => new Response("<rss><channel><item><title>Old</title><link>https://example.com/old</link></item></channel></rss>"),
    now: () => new Date("2026-07-23T00:00:00.000Z"),
  }), 0);
  assert.equal(JSON.parse(synced.stdout).sources[0].baseline, true);

  const removed = capture();
  assert.equal(await runCli(["feeds", "remove", "feed", "--project", "registered", "--db", database, "--json"], { io: removed.io }), 0);
  assert.equal(JSON.parse(removed.stdout).removed, true);

  const status = capture();
  assert.equal(await runCli(["status", "--project", "registered", "--db", database, "--json"], { io: status.io }), 0);
  assert.deepEqual(JSON.parse(status.stdout).sources, []);

  const items = capture();
  assert.equal(await runCli(["items", "--project", "registered", "--db", database, "--json"], { io: items.io }), 0);
  assert.equal(JSON.parse(items.stdout).items[0].title, "Old");

  const missing = capture();
  assert.equal(await runCli(["sync", "--project", "registered", "--db", database], { io: missing.io }), 1);
  assert.match(missing.stderr, /No sources configured/);
});

test("runCli registers OPML sources and reports registry errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "feed-reader-cli-registry-opml-"));
  const opml = join(directory, "feeds.opml");
  const invalid = join(directory, "invalid.json");
  const database = join(directory, "state.sqlite");
  await writeFile(opml, '<opml><body><outline text="Tech"><outline text="Feed" xmlUrl="https://example.com/rss"/></outline></body></opml>');
  await writeFile(invalid, "{");

  const imported = capture();
  assert.equal(await runCli(["feeds", "import", opml, "--project", "opml", "--category", "Imported", "--db", database, "--json"], { io: imported.io }), 0);
  assert.deepEqual(JSON.parse(imported.stdout), { project: "opml", imported: 1, total: 1 });

  const isolated = capture();
  assert.equal(await runCli(["feeds", "import", opml, "--project", "other", "--db", database, "--json"], { io: isolated.io }), 0);
  assert.equal(JSON.parse(isolated.stdout).total, 1);

  const plain = capture();
  assert.equal(await runCli(["feeds", "list", "--project", "opml", "--db", database], { io: plain.io }), 0);
  assert.match(plain.stdout, /feed\trss\thttps:\/\/example.com\/rss/);

  const empty = capture();
  assert.equal(await runCli(["feeds", "list", "--project", "empty", "--db", database], { io: empty.io }), 0);
  assert.equal(empty.stdout, "No registered sources.\n");

  const absent = capture();
  assert.equal(await runCli(["feeds", "remove", "missing", "--project", "opml", "--db", database], { io: absent.io }), 1);
  assert.match(absent.stderr, /Source not found/);

  for (const file of [join(directory, "missing.json"), invalid]) {
    const failed = capture();
    assert.equal(await runCli(["feeds", "import", file, "--db", database], { io: failed.io }), 1);
    assert.match(failed.stderr, /Cannot read import/);
  }
});

test("runCli resolves local config before the registered default project", async () => {
  const directory = await mkdtemp(join(tmpdir(), "feed-reader-cli-resolution-"));
  const config = join(directory, "feed-reader.json");
  const database = join(directory, "state.sqlite");
  await writeFile(config, JSON.stringify({
    sources: [{ id: "local", url: "https://example.com/local" }],
  }));
  const previous = process.cwd();
  process.chdir(directory);
  try {
    const local = capture();
    assert.equal(await runCli(["sync", "--db", database], {
      io: local.io,
      fetcher: async () => new Response("<rss><channel><title>Local</title></channel></rss>"),
    }), 0);
    assert.match(local.stdout, /Synced 1 sources/);

    await writeFile(config, "{");
    const invalid = capture();
    assert.equal(await runCli(["sync", "--db", database], { io: invalid.io }), 1);
    assert.match(invalid.stderr, /Cannot read config/);
    const invalidItems = capture();
    assert.equal(await runCli(["items", "--db", database], { io: invalidItems.io }), 1);
    assert.match(invalidItems.stderr, /Cannot read config/);
  } finally {
    process.chdir(previous);
  }

  const defaultConfig = join(directory, "default.json");
  await writeFile(defaultConfig, JSON.stringify({ sources: [{ id: "registered", url: "https://example.com/registered" }] }));
  assert.equal(await runCli(["feeds", "import", defaultConfig, "--db", database], { io: capture().io }), 0);
  const registered = capture();
  assert.equal(await runCli(["sync", "--db", database], {
    io: registered.io,
    fetcher: async () => new Response("<rss><channel><title>Registered</title></channel></rss>"),
  }), 0);
  assert.match(registered.stdout, /Synced 1 sources/);
});

test("runCli covers default registry paths and explicit project overrides", async () => {
  const directory = await mkdtemp(join(tmpdir(), "feed-reader-cli-default-registry-"));
  const config = join(directory, "feeds.json");
  const database = join(directory, "portable.sqlite");
  await writeFile(config, JSON.stringify({ sources: [{ id: "feed", url: "https://example.com/feed" }] }));
  const previous = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = directory;
  try {
    assert.equal(await runCli(["feeds", "import", config], { io: capture().io }), 0);
    const listed = capture();
    assert.equal(await runCli(["feeds", "list"], { io: listed.io }), 0);
    assert.match(listed.stdout, /feed/);
    assert.equal(await runCli(["feeds", "remove", "feed"], { io: capture().io }), 0);

    const overridden = capture();
    assert.equal(await runCli(["sync", "--config", config, "--project", "override", "--db", database], {
      io: overridden.io,
      fetcher: async () => new Response("<rss><channel><title>Override</title></channel></rss>"),
    }), 0);
    assert.match(overridden.stdout, /Synced 1 sources/);
  } finally {
    if (previous === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = previous;
    }
  }

  for (const args of [["feeds", "import"], ["feeds", "import", "one", "two"], ["feeds", "list", "extra"], ["feeds", "remove"]]) {
    const invalid = capture();
    assert.equal(await runCli(args, { io: invalid.io }), 1);
    assert.match(invalid.stderr, /feeds requires/);
  }
});

test("runCli syncs, lists, filters, and reports status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "feed-reader-cli-"));
  const config = join(directory, "feed-reader.json");
  const database = join(directory, "state.sqlite");
  await writeFile(config, JSON.stringify({
    project: "cli-project",
    sources: [{ id: "source", url: "https://example.com/feed", categories: ["AI"] }],
  }));
  let run = 0;
  const fetcher = async () => new Response(`<rss><channel>
    <item><title>Old</title><link>https://example.com/old</link><pubDate>2026-07-21</pubDate></item>
    <item><title>Undated</title><link>https://example.com/undated</link></item>
    ${run === 0 ? "" : "<item><title>New</title><link>https://example.com/new</link><pubDate>2026-07-22</pubDate></item>"}
  </channel></rss>`);
  const times = [new Date("2026-07-22T12:00:00Z"), new Date("2026-07-23T12:00:00Z")];
  const now = () => times.shift() as Date;

  const baseline = capture();
  assert.equal(await runCli(["sync", "--config", config, "--db", database], {
    io: baseline.io, fetcher, now,
  }), 0);
  assert.match(baseline.stdout, /0 new items/);

  run = 1;
  const incremental = capture();
  assert.equal(await runCli(["sync", "--config", config, "--db", database, "--json", "--no-items"], {
    io: incremental.io, fetcher, now,
  }), 0);
  const syncResult = JSON.parse(incremental.stdout);
  assert.equal(syncResult.newItemCount, 1);
  assert.equal("newItems" in syncResult, false);
  assert.equal(incremental.stderr, "[1/1] Syncing source\n");

  const items = capture();
  assert.equal(await runCli(["items", "--config", config, "--db", database, "--source", "source", "--category", "AI", "--since", "3d", "--json"], {
    io: items.io,
    now: () => new Date("2026-07-23T12:00:00Z"),
  }), 0);
  assert.equal(JSON.parse(items.stdout).items.length, 3);

  const hours = capture();
  assert.equal(await runCli(["items", "--project", "cli-project", "--db", database, "--since", "36h"], {
    io: hours.io,
    now: () => new Date("2026-07-23T12:00:00Z"),
  }), 0);
  assert.match(hours.stdout, /New/);
  assert.match(hours.stdout, /Undated/);
  assert.doesNotMatch(hours.stdout, /Old/);

  const status = capture();
  assert.equal(await runCli(["status", "--config", config, "--db", database, "--json"], { io: status.io }), 0);
  assert.equal(JSON.parse(status.stdout).sources[0].status, "ok");

  const plainStatus = capture();
  assert.equal(await runCli(["status", "--config", config, "--db", database], { io: plainStatus.io }), 0);
  assert.match(plainStatus.stdout, /source\tok/);
});

test("runCli syncs selector-based web sources", async () => {
  const directory = await mkdtemp(join(tmpdir(), "feed-reader-cli-web-"));
  const config = join(directory, "feed-reader.json");
  const database = join(directory, "state.sqlite");
  await writeFile(config, JSON.stringify({
    sources: [{
      id: "blog",
      url: "https://example.com/blog",
      type: "web",
      selectors: { item: "article", title: "h2", link: "a", summary: "p" },
    }],
  }));
  let includeNew = false;
  const fetcher = async () => new Response(`
    <article><h2>Old</h2><a href="/old"></a><p>Old summary</p></article>
    ${includeNew ? '<article><h2>New</h2><a href="/new"></a><p>New summary</p></article>' : ""}
  `);
  assert.equal(await runCli(["sync", "--config", config, "--db", database], {
    io: capture().io, fetcher,
  }), 0);
  includeNew = true;
  const sync = capture();
  assert.equal(await runCli(["sync", "--config", config, "--db", database, "--json"], {
    io: sync.io, fetcher,
  }), 0);
  assert.equal(JSON.parse(sync.stdout).newItems[0].method, "web");

  const items = capture();
  assert.equal(await runCli(["items", "--config", config, "--db", database, "--json"], { io: items.io }), 0);
  assert.deepEqual(JSON.parse(items.stdout).items.map((item: { title: string }) => item.title), ["New", "Old"]);
});

test("runCli handles empty output, invalid durations, missing config, and total sync failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "feed-reader-cli-empty-"));
  const database = join(directory, "state.sqlite");
  const emptyItems = capture();
  assert.equal(await runCli(["items", "--db", database], { io: emptyItems.io }), 0);
  assert.equal(emptyItems.stdout, "No items.\n");

  const emptyStatus = capture();
  assert.equal(await runCli(["status", "--db", database], { io: emptyStatus.io }), 0);
  assert.equal(emptyStatus.stdout, "No sources.\n");

  const invalidSince = capture();
  assert.equal(await runCli(["items", "--db", database, "--since", "yesterday"], { io: invalidSince.io }), 1);
  assert.match(invalidSince.stderr, /--since must use hours or days/);

  const config = join(directory, "feed-reader.json");
  await writeFile(config, JSON.stringify({ sources: [{ id: "bad", url: "https://example.com/bad" }] }));
  const failed = capture();
  assert.equal(await runCli(["sync", "--config", config, "--db", database], {
    io: failed.io,
    fetcher: async () => { throw new Error("offline"); },
    sleep: async () => {},
    now: () => new Date("2026-07-22T00:00:00Z"),
  }), 1);
  assert.match(failed.stdout, /1 errors/);

  const failedStatus = capture();
  assert.equal(await runCli(["status", "--config", config, "--db", database], { io: failedStatus.io }), 0);
  assert.match(failedStatus.stdout, /bad\terror\toffline/);

  const configDefault = capture();
  assert.equal(await runCli(["items", "--config", config, "--db", database, "--since", "1d", "--json"], { io: configDefault.io }), 0);
  assert.equal(JSON.parse(configDefault.stdout).project, "default");

  await writeFile(config, "{");
  const badConfig = capture();
  assert.equal(await runCli(["status", "--config", config, "--db", database], { io: badConfig.io }), 1);
  assert.match(badConfig.stderr, /Cannot read config/);
});

test("runCli can use its default IO and database path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "feed-reader-cli-defaults-"));
  const previous = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = directory;
  try {
    assert.equal(await runCli(["status", "--project", "default-io"]), 0);
    assert.equal(await runCli(["wat", "--db", join(directory, "unknown.sqlite")]), 1);
  } finally {
    if (previous === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = previous;
    }
  }
});

test("runCli reports non-Error output failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "feed-reader-cli-output-"));
  let stderr = "";
  const code = await runCli(["status", "--project", "output", "--db", join(directory, "db.sqlite")], {
    io: {
      stdout: () => { throw "write failed"; },
      stderr: (value) => { stderr += value; },
    },
  });
  assert.equal(code, 1);
  assert.equal(stderr, "write failed\n");
});
