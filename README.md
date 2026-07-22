# Feed Reader Skill

[English](README.md) | [简体中文](README.zh-CN.md)

Read RSS, Atom, and websites without feeds through a TypeScript CLI and a thin agent skill.

> Status: the deterministic CLI and thin agent skill are implemented for RSS, Atom, feed discovery, OPML import, configured listing pages, browser fallback, and caller-generated summaries.

## Install the CLI

Requires Node.js 20.18.1 or newer.

```bash
npm install --global feed-reader-skill
feed-reader --help
```

## Install the Skill

Install interactively to any agent supported by the Vercel Labs Skills CLI:

```bash
npx skills add deanplus/feed-reader-skill
```

Or install globally to a specific agent:

```bash
npx skills add deanplus/feed-reader-skill --skill feed-reader -g -a codex -y
npx skills add deanplus/feed-reader-skill --skill feed-reader -g -a claude-code -y
```

This installs the Skill instructions. When `feed-reader` is not on `PATH`, the Skill runs the published CLI through `npx feed-reader-skill@latest`, so a separate global CLI installation is optional. Add `--list` only to inspect the Skills found in the repository without installing them.

Claude Code users can alternatively install from this repository's marketplace:

```text
/plugin marketplace add deanplus/feed-reader-skill
/plugin install feed-reader@feed-reader-skills
/reload-plugins
```

## Development quick start

Requires Node.js 20.18.1 or newer and pnpm.

```bash
pnpm install
pnpm build
```

Create `feed-reader.json`:

```json
{
  "sources": [
    {
      "id": "example",
      "url": "https://example.com/feed.xml",
      "categories": ["Example"]
    }
  ]
}
```

Run the first sync to establish a baseline, then inspect stored items and source status:

```bash
node bin/feed-reader.js sync --db ./feed-reader.sqlite
node bin/feed-reader.js items --db ./feed-reader.sqlite --json
node bin/feed-reader.js status --db ./feed-reader.sqlite --json
```

Run the complete test suite on any supported Node.js version:

```bash
pnpm test
```

On Node.js 22 or newer, enforce 100% line, branch, and function coverage:

```bash
pnpm test:coverage
```

## Goals

- Read RSS and Atom feeds.
- Discover feeds declared by ordinary web pages.
- Read sites without feeds through configured CSS selectors.
- Let an agent use its browser when direct fetching cannot verify a site.
- Track incremental items and source health in SQLite.
- Keep state isolated when callers choose a project.
- Return normalized items for callers to list, filter, or summarize.

## Usage

People can use natural language without learning the internal state model:

```text
Import this OPML file.
Fetch new articles and show me the list.
Summarize the useful AI articles from the last 24 hours.
```

The repository includes [skills/feed-reader/SKILL.md](skills/feed-reader/SKILL.md). Register that directory through the agent's normal Git repository or local Skill installation flow. The Skill uses an installed `feed-reader` command, a built repository checkout, or `npx feed-reader-skill@latest`.

Invoke the skill explicitly with `$feed-reader` or use matching natural language. It does not define a portable custom slash command; the agent translates the request into CLI calls.

Agents and applications can use the implemented core CLI directly:

```bash
feed-reader discover https://example.com/blog --json
feed-reader feeds import subscriptions.opml --config feed-reader.json --json
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

Configure stable selectors for the listing page:

```json
{
  "sources": [
    {
      "id": "example-blog",
      "url": "https://example.com/blog",
      "type": "auto",
      "categories": ["Example"],
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

`type: "auto"` first discovers RSS or Atom and uses selectors only when no feed is declared. Use `type: "web"` to read the listing page directly. `item`, `title`, and `link` are required; `date` and `summary` are optional.

The fallback order is:

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

## Milestones

1. **Complete:** config model, SQLite storage, normalized output, RSS/Atom parsing, retries, baseline, deduplication, and core CLI.
2. **Complete:** feed discovery from ordinary web pages and automatic source resolution.
3. **Complete:** import OPML groups as categories and merge duplicate feed URLs into native JSON configuration.
4. **Complete:** extract static listing pages with explicit CSS selectors and store normalized `web` items.
5. **Complete:** add the thin agent skill for natural-language invocation, list/summary selection, and browser fallback.
6. **Complete:** validate RSS discovery, OPML import, selector extraction, Node.js 20 compatibility, Skill packaging, and npm contents before publishing `v0.1.0`.

## License

[MIT](LICENSE)
