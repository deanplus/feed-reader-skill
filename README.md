# Feed Reader Skill

[English](README.md) | [简体中文](README.zh-CN.md)

Read RSS, Atom, and websites without feeds through a TypeScript CLI and a thin agent skill.

> Status: the deterministic CLI and thin agent skill support RSS, Atom, feed discovery, project source registration, configured listing pages, recognized WAF challenges, browser fallback, and caller-generated summaries.

## Install the Skill

Requires Node.js 20.18.1 or newer.

Recommended: let the Vercel Labs Skills CLI detect your installed agents and choose where to install:

```bash
npx skills add deanplus/feed-reader-skill
```

Install globally to a specific agent:

```bash
# Codex
npx skills add deanplus/feed-reader-skill --skill feed-reader -g -a codex -y

# Claude Code
npx skills add deanplus/feed-reader-skill --skill feed-reader -g -a claude-code -y
```

No separate CLI installation is required. When `feed-reader` is not on `PATH`, the Skill runs `npx --yes feed-reader-skill@latest` automatically. Use `--list` only to inspect the repository without installing anything.

Claude Code users can alternatively use this repository as a plugin marketplace:

```text
/plugin marketplace add deanplus/feed-reader-skill
/plugin install feed-reader@feed-reader-skills
/reload-plugins
```

## Optional: install the CLI globally

```bash
npm install --global feed-reader-skill
feed-reader --help
```

## Development quick start

Requires Node.js 20.18.1 or newer and pnpm.

```bash
pnpm install
pnpm build
```

Create `feed-reader.json` and register it under a project:

```json
{
  "project": "example",
  "sources": [
    {
      "id": "example",
      "url": "https://example.com/feed.xml",
      "categories": ["Example"]
    }
  ]
}
```

Run the first sync to establish a baseline, then inspect stored items and source status without re-reading the JSON file:

```bash
node bin/feed-reader.js feeds import feed-reader.json --db ./feed-reader.sqlite --json
node bin/feed-reader.js sync --project example --db ./feed-reader.sqlite
node bin/feed-reader.js items --project example --db ./feed-reader.sqlite --json
node bin/feed-reader.js status --project example --db ./feed-reader.sqlite --json
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
- Automatically complete recognized JavaScript proof-of-work challenges with an isolated system Chrome session.
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
feed-reader feeds import subscriptions.opml --project daily-ai --json
feed-reader feeds list --project daily-ai --json
feed-reader sync --project daily-ai --json --no-items
feed-reader items --project daily-ai --category AI --since 24h --json
feed-reader status --project daily-ai --json
```

`sync` reports each source to stderr as it starts. Use `--no-items` with JSON output to return only the new-item count and per-source results; call `items` when content is needed.

`--project` and `--category` are optional:

- `feeds import` accepts OPML or native JSON and registers complete source definitions in SQLite.
- Project resolution during import is: explicit option, JSON config value, then `default`.
- `sync --project <name>` loads registered sources from SQLite and does not require a config file.
- Categories come from OPML groups, JSON configuration, or explicit user input.
- Missing categories remain unclassified; the tool does not ask or guess.
- `sync --config <file>` remains available for portable, reviewable file-based runs.
- Without `--project` or `--config`, the CLI uses `feed-reader.json` in the current directory, then the registered `default` project.

After `feeds list` confirms the import, the JSON file is no longer required at runtime; keep it only when you want a reviewable backup.

Importing OPML into a JSON file instead of the SQLite registry remains supported explicitly:

```bash
feed-reader feeds import subscriptions.opml --config feed-reader.json --json
```

Removing a registered source stops future syncs but keeps stored items and historical state:

```bash
feed-reader feeds remove example --project daily-ai --json
```

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
3. Complete a recognized `waf_pow` challenge with an isolated system Chrome session.
4. Ask the calling agent to inspect unsupported login, CAPTCHA, or dynamic pages.
5. Return `unverified` when the page still cannot be confirmed.

The package includes `playwright-core` but does not bundle a browser binary or read the user's Chrome profile. Challenge cookies stay in memory and require Google Chrome installed on the host. It does not attempt to infer arbitrary website layouts or bypass unsupported CAPTCHA flows.

## Architecture

- A TypeScript package and CLI perform deterministic fetching, parsing, deduplication, and persistence.
- SQLite stores registered source definitions, runtime state, and items. JSON remains an optional portable configuration.
- A thin skill translates natural-language requests into CLI calls and handles optional browser fallback and summarization.

See [docs/design.md](docs/design.md) for the current requirements and implementation contract.

## Milestones

1. **Complete:** config model, SQLite storage, normalized output, RSS/Atom parsing, retries, baseline, deduplication, and core CLI.
2. **Complete:** feed discovery from ordinary web pages and automatic source resolution.
3. **Complete:** import OPML groups as categories and merge duplicate feed URLs into native JSON configuration.
4. **Complete:** extract static listing pages with explicit CSS selectors and store normalized `web` items.
5. **Complete:** add the thin agent skill for natural-language invocation, list/summary selection, and browser fallback.
6. **Complete:** validate RSS discovery, OPML import, selector extraction, Node.js 20 compatibility, Skill packaging, and npm contents before publishing `v0.1.0`.
7. **Complete:** register project sources in SQLite so agents can import once and later sync by project from any directory.
8. **Complete:** automatically fetch feeds protected by the recognized `waf_pow` challenge without sharing user browser cookies.

## License

[MIT](LICENSE)
