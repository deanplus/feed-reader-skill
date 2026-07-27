import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { loadConfig, parseConfig } from "./config.ts";
import { defaultDatabasePath, FeedDatabase } from "./database.ts";
import type { FetchOptions } from "./feed.ts";
import { discoverFeeds } from "./feed.ts";
import { importOpmlFile, mergeFeedConfig, parseOpml } from "./opml.ts";
import { syncFeeds } from "./sync.ts";
import type { FeedConfig } from "./types.ts";

interface CliIo {
  stdout: (value: string) => void;
  stderr: (value: string) => void;
}

export interface CliOptions extends FetchOptions {
  io?: CliIo;
  now?: () => Date;
}

const usage = `Usage:
  feed-reader discover <url> [--json]
  feed-reader feeds import <file> [--project <name>] [--category <name>] [--config <file>] [--db <file>] [--json]
  feed-reader feeds list [--project <name>] [--db <file>] [--json]
  feed-reader feeds remove <source-id> [--project <name>] [--db <file>] [--json]
  feed-reader sync [--project <name>] [--source <id>] [--config <file>] [--db <file>] [--json] [--no-items]
  feed-reader items [--project <name>] [--source <id>] [--category <name>] [--since <duration>] [--config <file>] [--db <file>] [--json]
  feed-reader status [--project <name>] [--config <file>] [--db <file>] [--json]
`;

function duration(value: string, now: Date): Date {
  const match = /^(\d+)(h|d)$/.exec(value);
  if (match === null) {
    throw new Error("--since must use hours or days, for example 24h or 7d");
  }
  const count = Number(match[1]);
  const unit = match[2] === "h" ? 60 * 60 * 1_000 : 24 * 60 * 60 * 1_000;
  return new Date(now.valueOf() - count * unit);
}

function print(io: CliIo, json: boolean | undefined, value: unknown, plain: string): void {
  io.stdout(json === true ? `${JSON.stringify(value, null, 2)}\n` : `${plain}\n`);
}

async function optionalProject(explicit: string | undefined, configPath: string | undefined): Promise<string> {
  if (explicit !== undefined) {
    return explicit;
  }
  const path = configPath ?? "feed-reader.json";
  try {
    return (await loadConfig(path)).project ?? "default";
  } catch (error) {
    const message = (error as Error).message;
    if (configPath === undefined && message.includes("ENOENT")) {
      return "default";
    }
    throw error;
  }
}

async function importConfig(path: string, category: string | undefined): Promise<FeedConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Cannot read import ${path}: ${(error as Error).message}`);
  }
  if (!text.trimStart().startsWith("{")) {
    return { sources: parseOpml(text, category) };
  }
  let config: FeedConfig;
  try {
    config = parseConfig(JSON.parse(text));
  } catch (error) {
    throw new Error(`Cannot read import ${path}: ${(error as Error).message}`);
  }
  if (category === undefined) {
    return config;
  }
  return {
    ...config,
    sources: config.sources.map((source) => ({
      ...source,
      categories: [...new Set([...source.categories, category])],
    })),
  };
}

async function sourceConfig(
  project: string | undefined,
  configPath: string | undefined,
  database: FeedDatabase,
): Promise<FeedConfig & { project: string }> {
  if (configPath !== undefined) {
    const config = await loadConfig(configPath);
    return { ...config, project: project ?? config.project ?? "default" };
  }
  if (project !== undefined) {
    return { project, sources: database.listSources(project) };
  }
  try {
    const config = await loadConfig("feed-reader.json");
    return { ...config, project: config.project ?? "default" };
  } catch (error) {
    if (!(error as Error).message.includes("ENOENT")) {
      throw error;
    }
    return { project: "default", sources: database.listSources("default") };
  }
}

export async function runCli(argv: string[], options: CliOptions = {}): Promise<number> {
  const io = options.io ?? {
    stdout: (value: string) => process.stdout.write(value),
    stderr: (value: string) => process.stderr.write(value),
  };

  if (argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    io.stdout(usage);
    return 0;
  }
  if (argv.length === 0) {
    io.stderr(usage);
    return 1;
  }

  try {
    const command = argv[0];
    const { values, positionals } = parseArgs({
      args: argv.slice(1),
      strict: true,
      allowPositionals: true,
      options: {
        project: { type: "string" },
        config: { type: "string" },
        db: { type: "string" },
        source: { type: "string" },
        category: { type: "string" },
        since: { type: "string" },
        json: { type: "boolean" },
        "no-items": { type: "boolean" },
      },
    });
    if (command === "discover") {
      if (positionals.length !== 1) {
        throw new Error("discover requires exactly one URL");
      }
      const feeds = await discoverFeeds(positionals[0] as string, options);
      const plain = feeds.length === 0
        ? "No RSS or Atom feed discovered."
        : feeds.map((feed) => `${feed.type}\t${feed.url}\t${feed.title ?? ""}`).join("\n");
      print(io, values.json, { url: positionals[0], feeds }, plain);
      return feeds.length === 0 ? 1 : 0;
    }
    if (command === "feeds") {
      const action = positionals[0];
      if (action === "import" && positionals.length === 2) {
        if (values.config !== undefined) {
          const result = await importOpmlFile(positionals[1] as string, values.config, {
            project: values.project,
            category: values.category,
          });
          print(io, values.json, result, `Imported ${result.imported} feeds; ${result.total} total in ${result.configPath}.`);
          return 0;
        }
        const database = new FeedDatabase(values.db ?? defaultDatabasePath());
        try {
          const imported = await importConfig(positionals[1] as string, values.category);
          const project = values.project ?? imported.project ?? "default";
          const merged = mergeFeedConfig({ project, sources: database.listSources(project) }, imported.sources, project);
          database.upsertSources(project, merged.sources);
          const result = { project, imported: imported.sources.length, total: merged.sources.length };
          print(io, values.json, result, `Imported ${result.imported} feeds; ${result.total} registered for ${project}.`);
          return 0;
        } finally {
          database.close();
        }
      }
      if (!((action === "list" && positionals.length === 1) || (action === "remove" && positionals.length === 2))) {
        throw new Error("feeds requires: feeds import <file>, feeds list, or feeds remove <source-id>");
      }
      const project = values.project ?? "default";
      const database = new FeedDatabase(values.db ?? defaultDatabasePath());
      try {
        if (action === "list" && positionals.length === 1) {
          const sources = database.listSources(project);
          const plain = sources.length === 0
            ? "No registered sources."
            : sources.map((source) => `${source.id}\t${source.type}\t${source.url}`).join("\n");
          print(io, values.json, { project, sources }, plain);
          return 0;
        }
        const sourceId = positionals[1] as string;
        if (!database.removeSource(project, sourceId)) {
          throw new Error(`Source not found in project ${project}: ${sourceId}`);
        }
        print(io, values.json, { project, sourceId, removed: true }, `Removed ${sourceId} from ${project}.`);
        return 0;
      } finally {
        database.close();
      }
    }
    if (positionals.length !== 0) {
      throw new Error(`${command} does not accept positional arguments`);
    }
    const database = new FeedDatabase(values.db ?? defaultDatabasePath());
    try {
      if (command === "sync") {
        const config = await sourceConfig(values.project, values.config, database);
        if (values.source !== undefined) {
          config.sources = config.sources.filter((source) => source.id === values.source);
        }
        if (config.sources.length === 0) {
          throw new Error(values.source === undefined
            ? `No sources configured for project ${config.project}`
            : `Source not found in project ${config.project}: ${values.source}`);
        }
        const result = await syncFeeds(config, database, {
          project: values.project,
          fetcher: options.fetcher,
          sleep: options.sleep,
          now: options.now,
          onSource: (source, index, total) => io.stderr(`[${index + 1}/${total}] Syncing ${source.id}\n`),
        });
        const errors = result.sources.filter((source) => source.status === "error").length;
        const output = values["no-items"] === true
          ? { project: result.project, newItemCount: result.newItems.length, sources: result.sources }
          : result;
        print(io, values.json, output, `Synced ${result.sources.length} sources; ${result.newItems.length} new items; ${errors} errors.`);
        return errors === result.sources.length && errors > 0 ? 1 : 0;
      }

      if (command === "items") {
        const project = await optionalProject(values.project, values.config);
        const items = database.listItems(project, {
          sourceId: values.source,
          category: values.category,
          since: values.since === undefined ? undefined : duration(values.since, options.now?.() ?? new Date()),
        });
        const plain = items.length === 0
          ? "No items."
          : items.map((item) => `${item.publishedAt ?? item.fetchedAt}\t${item.title}\t${item.url}`).join("\n");
        print(io, values.json, { project, items }, plain);
        return 0;
      }
      if (command === "status") {
        const config = await sourceConfig(values.project, values.config, database);
        const statuses = database.listSourceStatuses(config.project, config.sources);
        const plain = statuses.length === 0
          ? "No sources."
          : statuses.map((status) => `${status.sourceId}\t${status.status}\t${status.error ?? ""}`).join("\n");
        print(io, values.json, { project: config.project, sources: statuses }, plain);
        return 0;
      }
      throw new Error(`Unknown command: ${command}`);
    } finally {
      database.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`${message}\n`);
    return 1;
  }
}
