import { parseArgs } from "node:util";
import { loadConfig } from "./config.ts";
import { defaultDatabasePath, FeedDatabase } from "./database.ts";
import type { FetchOptions } from "./feed.ts";
import { syncFeeds } from "./sync.ts";

interface CliIo {
  stdout: (value: string) => void;
  stderr: (value: string) => void;
}

export interface CliOptions extends FetchOptions {
  io?: CliIo;
  now?: () => Date;
}

const usage = `Usage:
  feed-reader sync [--project <name>] [--config <file>] [--db <file>] [--json]
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

async function optionalProject(explicit: string | undefined, configPath: string): Promise<string> {
  if (explicit !== undefined) {
    return explicit;
  }
  try {
    return (await loadConfig(configPath)).project ?? "default";
  } catch (error) {
    const message = (error as Error).message;
    if (message.includes("ENOENT")) {
      return "default";
    }
    throw error;
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
    const { values } = parseArgs({
      args: argv.slice(1),
      strict: true,
      options: {
        project: { type: "string" },
        config: { type: "string", default: "feed-reader.json" },
        db: { type: "string" },
        source: { type: "string" },
        category: { type: "string" },
        since: { type: "string" },
        json: { type: "boolean" },
      },
    });
    const database = new FeedDatabase(values.db ?? defaultDatabasePath());
    try {
      if (command === "sync") {
        const config = await loadConfig(values.config);
        const result = await syncFeeds(config, database, {
          project: values.project,
          fetcher: options.fetcher,
          sleep: options.sleep,
          now: options.now,
        });
        const errors = result.sources.filter((source) => source.status === "error").length;
        print(io, values.json, result, `Synced ${result.sources.length} sources; ${result.newItems.length} new items; ${errors} errors.`);
        return errors === result.sources.length && errors > 0 ? 1 : 0;
      }

      const project = await optionalProject(values.project, values.config);
      if (command === "items") {
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
        const statuses = database.listStatuses(project);
        const plain = statuses.length === 0
          ? "No sources."
          : statuses.map((status) => `${status.sourceId}\t${status.status}\t${status.error ?? ""}`).join("\n");
        print(io, values.json, { project, sources: statuses }, plain);
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
