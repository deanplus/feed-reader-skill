---
name: feed-reader
description: Discover, import, and incrementally read RSS, Atom, and configured blog listing pages. Use when a user asks to import an OPML file, add or inspect feed sources, fetch recent posts, list or filter stored items, summarize feed updates, check source health, or handle a site that has no RSS feed.
---

# Feed Reader

Use the repository CLI for deterministic discovery, fetching, recognized WAF challenge handling, deduplication, and SQLite state. Keep semantic filtering, summaries, and unsupported browser fallback in the calling agent.

## Resolve the CLI and state

1. Use `feed-reader` when it is available on `PATH`.
2. In a repository checkout with built output and installed dependencies, use `node <repository-root>/bin/feed-reader.js`.
3. If npm already has an `_npx` copy of `feed-reader-skill`, find it under `<npm-cache>/_npx/*/node_modules/feed-reader-skill`, where `<npm-cache>` comes from `npm config get cache`. Prefer the newest cached package version and run its `bin/feed-reader.js` with Node after confirming that `--help` succeeds.
4. Otherwise use `npx --yes feed-reader-skill@latest` once to bootstrap the CLI. Reuse the resolved executable for every later command in the task instead of invoking `npx` again.

Do not recreate the CLI logic inside the skill or install repository dependencies without authorization.

If the `npx` bootstrap produces no output within 30 seconds, stop it and report an npm bootstrap or network failure. Do not classify missing `npx` output as a CLI failure or as “no feed updates.” A pinned package version can make runs reproducible, but it does not remove npm's registry dependency when the package is not already installed.

Prefer a registered project when one is established. Use an explicit config for portable file-based runs.

Treat project and category as optional:

- Reuse an explicit or already registered project.
- In a repository, register a stable repository-based project when separate state is useful.
- Otherwise let the CLI use `default`; do not ask the user merely to obtain a project name.
- Preserve imported or configured categories. Do not invent or persist semantic categories unless the user requests them.

In the commands below, replace `feed-reader` with the resolved CLI form when necessary.

## Import or add sources

Register OPML groups or native JSON sources in SQLite:

```bash
feed-reader feeds import <file> --project <name> --json
feed-reader feeds list --project <name> --json
```

Add `--project` or `--category` only when supplied or clearly established.

Use `--config <feed-reader.json>` with `feeds import` only when the user explicitly wants OPML converted into a portable JSON file instead of registered sources.

For a normal page URL, run:

```bash
feed-reader discover <url> --json
```

Add the discovered feed to a native JSON import file, then register it. If no feed is declared, inspect the static page and configure stable `item`, `title`, and `link` CSS selectors; add optional `date` and `summary` selectors only when present. Use `type: "auto"` to retain feed-first behavior or `type: "web"` to read the listing directly. Never infer a generic layout without checking the page.

## Sync and read

Run sync before answering an update request:

```bash
feed-reader sync --project <name> --json --no-items
```

Use `sync --config <feed-reader.json>` when the caller supplied a portable config that has not been registered.
Add `--source <id>` when only one source should be synchronized.

Prefer `--no-items` for agent syncs: progress is written to stderr, while stdout stays compact and machine-readable. Fetch content afterward with `items`.

The first successful sync establishes a baseline, so `newItems` is empty even though stored items may exist. Use `items` when the user asks to inspect that baseline or stored history:

```bash
feed-reader items --project <name> --since 24h --json
feed-reader status --project <name> --json
```

Add deterministic `--project`, `--source`, or `--category` filters when needed. Inspect every per-source sync result; one source may fail while others succeed.

Remove a registered source only when requested. Removal stops future syncs but preserves stored items and historical state:

```bash
feed-reader feeds remove <source-id> --project <name> --json
```

## Present results

- For a list request, return normalized titles, links, dates, source, categories, and feed- or listing-provided summary/content.
- For a summary request, deterministically select the relevant items first, then summarize them with the current agent. The CLI does not call an AI provider.
- For semantic filtering, explain the criterion and filter in the current agent without silently changing source categories.
- Do not open every article or claim full-text coverage. Stored content comes only from the feed or listing page.
- Keep raw JSON when another tool or application will consume the result.

## Use browser fallback

Let the CLI handle recognized `waf_pow` challenges automatically with an isolated system Chrome session. It does not read the user's Chrome profile or persist challenge cookies.

Use an available agent browser only after direct discovery or sync still cannot verify a source. Check the ordinary page and distinguish:

- the page is readable but the feed or selector fetch failed;
- the page is readable and shows no new posts;
- the page remains unverified because of login, bot checks, dynamic rendering, or network failure.

Never report “no updates” for an unverified source, disable a source after one failure, or treat a dismissible overlay as proof that the page is inaccessible. Browser observations are not persisted by the current CLI; state that limitation when it affects later deduplication.
