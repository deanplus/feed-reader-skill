---
name: feed-reader
description: Discover, import, and incrementally read RSS, Atom, and configured blog listing pages. Use when a user asks to import an OPML file, add or inspect feed sources, fetch recent posts, list or filter stored items, summarize feed updates, check source health, or handle a site that has no RSS feed.
---

# Feed Reader

Use the repository CLI for deterministic discovery, fetching, deduplication, and SQLite state. Keep semantic filtering, summaries, and browser fallback in the calling agent.

## Resolve the CLI and state

1. Use `feed-reader` when it is available on `PATH`.
2. In a repository checkout, use `node <repository-root>/bin/feed-reader.js` after confirming `dist/cli.js` exists. If it does not, run the repository's documented install and build steps only when dependency installation is authorized.
3. If neither form is available, stop and explain that the Feed Reader CLI must be installed or built. Do not recreate its logic inside the skill.

Use an existing config when one is provided. Otherwise use `feed-reader.json` in the working directory.

Treat project and category as optional:

- Reuse an explicit project or the config's project.
- In a repository, persist a stable repository-based project when separate state is useful.
- Otherwise let the CLI use `default`; do not ask the user merely to obtain a project name.
- Preserve imported or configured categories. Do not invent or persist semantic categories unless the user requests them.

In the commands below, replace `feed-reader` with the resolved CLI form when necessary.

## Import or add sources

Import OPML groups as categories:

```bash
feed-reader feeds import <subscriptions.opml> --config <feed-reader.json> --json
```

Add `--project` or `--category` only when supplied or clearly established.

For a normal page URL, run:

```bash
feed-reader discover <url> --json
```

Add the discovered feed to the JSON config. If no feed is declared, inspect the static page and configure stable `item`, `title`, and `link` CSS selectors; add optional `date` and `summary` selectors only when present. Use `type: "auto"` to retain feed-first behavior or `type: "web"` to read the listing directly. Never infer a generic layout without checking the page.

## Sync and read

Run sync before answering an update request:

```bash
feed-reader sync --config <feed-reader.json> --json
```

The first successful sync establishes a baseline, so `newItems` is empty even though stored items may exist. Use `items` when the user asks to inspect that baseline or stored history:

```bash
feed-reader items --config <feed-reader.json> --since 24h --json
feed-reader status --config <feed-reader.json> --json
```

Add deterministic `--project`, `--source`, or `--category` filters when needed. Inspect every per-source sync result; one source may fail while others succeed.

## Present results

- For a list request, return normalized titles, links, dates, source, categories, and feed- or listing-provided summary/content.
- For a summary request, deterministically select the relevant items first, then summarize them with the current agent. The CLI does not call an AI provider.
- For semantic filtering, explain the criterion and filter in the current agent without silently changing source categories.
- Do not open every article or claim full-text coverage. Stored content comes only from the feed or listing page.
- Keep raw JSON when another tool or application will consume the result.

## Use browser fallback

Use an available agent browser only after direct discovery or sync cannot verify a source. Check the ordinary page and distinguish:

- the page is readable but the feed or selector fetch failed;
- the page is readable and shows no new posts;
- the page remains unverified because of login, bot checks, dynamic rendering, or network failure.

Never report “no updates” for an unverified source, disable a source after one failure, or treat a dismissible overlay as proof that the page is inaccessible. Browser observations are not persisted by the current CLI; state that limitation when it affects later deduplication.
