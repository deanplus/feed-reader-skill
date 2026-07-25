# Feed Reader Design

This document records the implemented product boundary. The deterministic CLI and thin skill include selector-based websites, recognized WAF challenge handling, and agent browser fallback. Persisting agent-browser-extracted items remains planned.

## 1. Product boundary

The project has two layers:

1. A TypeScript package and CLI for deterministic feed discovery, fetching, parsing, state, and output.
2. A thin agent skill for natural-language invocation, browser fallback, semantic filtering, and summaries.

The skill must call the CLI rather than duplicate its implementation. It does not register a portable custom slash command; users may invoke it by natural language or by its skill name.

## 2. First-version requirements

### Sources

- Support RSS 2.0 and Atom.
- Accept a normal page URL and inspect declared feed links before using web extraction.
- Support explicitly configured CSS selectors for sites without feeds.
- Store only summaries or content directly present in the feed or listing page.
- Do not fetch every article for full-text extraction.
- Do not bundle a browser binary or use the user's browser profile.
- Do not attempt generic article-list inference for arbitrary sites.

### Fetching

- Fetch sources independently so one failure does not abort a run.
- Attempt each source up to four times with delays of 1, 2, and 4 seconds after failures.
- Establish a baseline on the first sync instead of reporting all history as new.
- Allow an explicit history limit when creating the baseline.
- Never disable a source from a single transient failure.
- Use an isolated system Chrome session only for recognized `waf_pow` challenges, keep its cookies in memory, and fail closed for unsupported CAPTCHA or login flows.

The implemented core loop baselines every item returned by the feed. An explicit first-run history limit remains planned.

### State

Use one SQLite database with project-scoped keys. The storage is:

- `sources`, unique by `(project, source_key)` and `(project, url)`.
- `source_state`, unique by `(project, source_key)`.
- `items`, unique by `(project, source_key, dedupe_key)`.

This deliberately permits duplicated item storage when the same source is used by multiple projects. A shared global article cache is deferred until duplication becomes a measured problem.

Registered projects use SQLite source definitions at runtime. Reviewable JSON remains a portable import and explicit sync format rather than a required working-directory file.

Use a platform-appropriate application data directory for the default database. Allow `--db <file>` when callers need a portable or physically isolated database.

## 3. Projects and categories

Projects and categories are independent and optional.

- A **project** isolates baseline, deduplication, and source state for a caller.
- A **category** describes content and supports filtering. One source may have multiple categories.

CLI project resolution:

1. Explicit `--project`.
2. `project` from configuration.
3. `default`.

Skill project resolution:

1. Use a project explicitly supplied by the user.
2. Reuse an already registered project or a project stored in configuration.
3. In a repository, derive a stable name from the repository and register it.
4. Otherwise omit the option and let the CLI use `default`.

The skill should not ask the user for a missing project or category. It may add a category only when the user supplied it, the imported source carries it, or an existing project taxonomy defines it. Temporary semantic classification does not mutate source configuration.

## 4. Configuration and imports

The CLI imports OPML or native JSON into the SQLite source registry. CSV, a second JSON format, and remote account synchronization are out of scope.

`sync --project <name>` reads registered sources from SQLite. Explicit `sync --config <file>` uses portable file mode. With neither option, resolve `feed-reader.json` in the current directory and then the registered `default` project.

For compatibility, `feeds import <opml> --config <file>` converts or merges OPML into native JSON instead of registering it.

Configuration shape:

```json
{
  "project": "daily-ai",
  "sources": [
    {
      "id": "example",
      "url": "https://example.com/blog",
      "type": "auto",
      "categories": ["AI"],
      "selectors": {
        "item": "article",
        "title": "h2",
        "link": "a",
        "date": "time",
        "summary": ".summary"
      }
    }
  ]
}
```

Import behavior:

- Convert OPML outline groups into categories.
- Preserve categories present in JSON.
- Apply every explicit `--category` to all imported sources in that invocation.
- Merge duplicate source URLs.
- Leave sources unclassified when no category exists.

## 5. CLI

```bash
feed-reader discover <url> [--json]
feed-reader feeds import <file> [--project <name>] [--category <name>] [--config <file>] [--db <file>]
feed-reader feeds list [--project <name>] [--db <file>] [--json]
feed-reader feeds remove <source-id> [--project <name>] [--db <file>] [--json]
feed-reader sync [--project <name>] [--config <file>] [--db <file>] [--json] [--no-items]
feed-reader items [--project <name>] [--source <id>] [--category <name>] [--since <duration>] [--config <file>] [--db <file>] [--json]
feed-reader items ingest --source <id> [--project <name>] [--input <file>] [--db <file>]
feed-reader status [--project <name>] [--config <file>] [--db <file>] [--json]
```

`discover`, `feeds import` for OPML and JSON, `feeds list`, `feeds remove`, `sync`, `items`, and `status` are implemented. `items ingest` remains planned.

For configured web extraction, `item`, `title`, and `link` selectors are required. `date` and `summary` are optional. `type: "auto"` tries a direct feed and declared feed metadata before selectors; `type: "web"` skips feed discovery and reads the listing page directly. A page with no matching or valid items is an error rather than a verified empty update.

`items ingest` accepts normalized items extracted by an agent browser, reading stdin when `--input` is absent. It lets those items use the same deduplication state as directly fetched items.

The first version does not include scheduling, notifications, report templates, topic clustering, or integrations with note-taking applications.

## 6. Normalized output

Every command with `--json` must write machine-readable JSON to stdout and diagnostics to stderr.

A normalized item contains at least:

```json
{
  "sourceId": "example",
  "title": "Article title",
  "url": "https://example.com/article",
  "publishedAt": "2026-07-22T00:00:00.000Z",
  "fetchedAt": "2026-07-22T01:00:00.000Z",
  "summary": "Content supplied by the feed or listing page.",
  "categories": ["AI"],
  "method": "rss",
  "dedupeKey": "implementation-defined"
}
```

`method` is one of `rss`, `web`, or `browser`. Optional source fields must remain optional rather than being filled with invented data.

Sync output includes the effective project, new items, per-source status, and errors so callers can distinguish partial success from complete failure. With `--no-items`, it returns `newItemCount` instead of the complete items; callers then use `items` to read content. Per-source progress is written to stderr.

## 7. Source status

The package and skill must preserve these distinctions:

- Source is registered but has not completed its first sync (`pending`).
- Feed fetched successfully.
- Feed failed but its normal web page is accessible.
- Web page was checked and has no new items.
- Source remains unverified.

Network disconnects, incomplete responses, blocked raw feed URLs, and dismissible page overlays are not sufficient reasons to disable a source.

## 8. List, filter, and summary behavior

The CLI returns deterministic normalized items and supports field-based filters such as project, category, source, and time.

The skill chooses presentation from the user's request:

- Return a content list when the user asks to list or inspect items.
- Ask the current agent to summarize after deterministic filtering when the user asks for a summary.
- Return raw JSON when another application needs structured output.
- Apply semantic filtering in the agent without silently persisting inferred categories.

The package does not depend on an AI model or API key.

## 9. Runtime and dependencies

- Support Node.js 20.18.1 and newer maintained releases supported by the runtime dependencies.
- Use TypeScript.
- Use `better-sqlite3` rather than requiring the newer built-in SQLite API.
- Prefer built-in `fetch` and existing platform features before adding dependencies.
- Load `playwright-core` only after a recognized WAF response and require a host-installed Google Chrome.
- Keep the CLI and public TypeScript API on the same underlying functions.

The first public package version is `0.1.0` under the unscoped name `feed-reader-skill`.

## 10. Skill packaging

The repository contains:

```text
skills/feed-reader/
├── SKILL.md
└── agents/
    └── openai.yaml
```

`SKILL.md` should contain only the workflow and non-obvious decisions needed by an agent. It should not contain another copy of the TypeScript implementation or separate user documentation.

The skill may be triggered by matching natural language or explicitly as `$feed-reader`. It does not define a portable custom slash command. It calls an installed `feed-reader` executable or the built CLI in a repository checkout.

## 11. Implementation acceptance checks

Before publication, verify at least:

- RSS and Atom parsing.
- Feed discovery from an HTML page.
- Selector-based extraction from a static page.
- OPML category import and duplicate merging.
- Idempotent source registration and project-only sync without a config file.
- Removing a registered source stops future syncs and status output without deleting stored items.
- First-run baseline and subsequent incremental results.
- Project isolation with the same source in two projects.
- Four-attempt retry behavior without aborting other sources.
- JSON stdout remains parseable when a source fails.
- Sync progress stays on stderr and `--no-items` omits complete item payloads.
- A recognized `waf_pow` challenge can fetch the original feed without reading or persisting the user's browser cookies.
- Browser-ingested items deduplicate against later runs.
- Skill list and summary requests produce different presentations from the same stored items.
