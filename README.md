# Feed Reader Skill

Read RSS, Atom, and websites without feeds through a TypeScript CLI and a thin agent skill.

> Status: documentation and design only. The CLI and skill are not implemented yet.

## Goals

- Read RSS and Atom feeds.
- Discover feeds declared by ordinary web pages.
- Read sites without feeds through configured CSS selectors.
- Let an agent use its browser when direct fetching cannot verify a site.
- Track incremental items and source health in SQLite.
- Keep state isolated when callers choose a project.
- Return normalized items for callers to list, filter, or summarize.

## Planned usage

People can use natural language without learning the internal state model:

```text
Import this OPML file.
Fetch new articles and show me the list.
Summarize the useful AI articles from the last 24 hours.
```

Agents and applications can use the planned CLI directly:

```bash
feed-reader feeds import subscriptions.opml --project daily-ai --category AI
feed-reader sync --project daily-ai
feed-reader items --project daily-ai --category AI --since 24h --json
feed-reader status --project daily-ai --json
```

`--project` and `--category` are optional:

- Project resolution is: explicit option, config value, then `default`.
- An agent working in a repository should use a stable repository-based project name and persist it in config.
- Categories come from OPML groups, JSON configuration, or explicit user input.
- Missing categories remain unclassified; the tool does not ask or guess.
- Config resolution is: explicit `--config`, then `feed-reader.json` in the current directory.

## Output modes

The package will always expose deterministic normalized items. It will not depend on an AI provider.

- **List:** return titles, links, source metadata, dates, categories, and feed- or listing-provided content.
- **Summary:** let the calling agent summarize the normalized items.
- **Filter:** support deterministic filters in the CLI and leave semantic filtering to the caller.

The first version will not open every article to extract full text.

## Sources without RSS

The planned fallback order is:

1. Discover RSS or Atom metadata from the page.
2. Use configured CSS selectors when no feed exists.
3. Ask the calling agent to inspect the page with its browser.
4. Return `unverified` when the page still cannot be confirmed.

The package will not bundle Playwright or attempt to infer arbitrary website layouts.

## Architecture

- A TypeScript package and CLI perform deterministic fetching, parsing, deduplication, and persistence.
- SQLite stores runtime state and items; reviewable JSON files remain the source configuration.
- A thin skill translates natural-language requests into CLI calls and handles optional browser fallback and summarization.

See [docs/design.md](docs/design.md) for the current requirements and implementation contract.

## Planned milestones

1. Implement the config model, SQLite storage, and normalized output types.
2. Implement feed discovery, RSS/Atom parsing, retries, baseline, and deduplication.
3. Add selector-based web sources and OPML/JSON import.
4. Add the thin agent skill and browser-ingestion path.
5. Validate against real mixed RSS and non-RSS sources before publishing.

## License

[MIT](LICENSE)
