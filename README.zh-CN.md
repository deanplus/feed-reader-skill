# Feed Reader Skill

[English](README.md) | [简体中文](README.zh-CN.md)

通过 TypeScript CLI 和轻量 Agent Skill 读取 RSS、Atom，以及没有 Feed 的网站。

> 状态：确定性的 CLI 和轻量 Skill 已支持 RSS、Atom、Feed 自动发现、项目源注册、配置式列表页抓取、已识别的 WAF 验证、浏览器兜底，以及由调用方生成摘要。

## 安装 Skill

需要 Node.js 20.18.1 或更高版本。

推荐使用 Vercel Labs Skills CLI 自动检测已安装的 Agent，再选择安装位置：

```bash
npx skills add deanplus/feed-reader-skill
```

也可以全局安装到指定 Agent：

```bash
# Codex
npx skills add deanplus/feed-reader-skill --skill feed-reader -g -a codex -y

# Claude Code
npx skills add deanplus/feed-reader-skill --skill feed-reader -g -a claude-code -y
```

如果会定时或频繁使用，添加 Skill 后建议全局安装 CLI，让 Agent 使用稳定命令而不是 npm 缓存路径：

```bash
npm install --global feed-reader-skill@latest
feed-reader --help
```

偶尔使用时仍可不单独安装 CLI。Skill 会优先使用 `PATH` 中的 `feed-reader` 或已构建的仓库版本，最后回退到 `npx --yes feed-reader-skill@latest`，不会直接执行 npm 临时 `_npx` 缓存中的文件。`npx` 无回显或执行失败属于 npm 引导或网络异常，不能据此判断 CLI 没有 Feed 更新；若持续失败，请安装上面的全局 CLI。只有想查看仓库内容但不安装时，才使用 `--list`。

Claude Code 用户也可以把本仓库作为插件 marketplace 安装：

```text
/plugin marketplace add deanplus/feed-reader-skill
/plugin install feed-reader@feed-reader-skills
/reload-plugins
```

## 开发快速开始

需要 Node.js 20.18.1 或更高版本。

```bash
npm install
npm run build
```

创建 `feed-reader.json`，并将它注册到一个项目：

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

第一次同步会建立 baseline。之后无需再次读取 JSON 文件即可查看已保存的内容和来源状态：

```bash
node bin/feed-reader.js feeds import feed-reader.json --db ./feed-reader.sqlite --json
node bin/feed-reader.js sync --project example --db ./feed-reader.sqlite
node bin/feed-reader.js items --project example --db ./feed-reader.sqlite --json
node bin/feed-reader.js status --project example --db ./feed-reader.sqlite --json
```

在所有支持的 Node.js 版本上运行完整测试：

```bash
npm test
```

在 Node.js 22 或更高版本上强制检查 100% 行、分支和函数覆盖率：

```bash
npm run test:coverage
```

## 目标

- 读取 RSS 和 Atom Feed。
- 自动发现普通网页声明的 Feed。
- 通过配置的 CSS selectors 读取没有 Feed 的网站。
- 使用隔离的系统 Chrome 会话自动完成已识别的 JavaScript 工作量证明验证。
- 直接抓取无法验证网站时，让 Agent 使用浏览器兜底。
- 使用 SQLite 跟踪增量内容和来源健康状态。
- 调用方需要时，通过 project 隔离状态。
- 返回标准化内容，供调用方列出、过滤或生成摘要。

## 用法

用户可以直接使用自然语言，不需要了解内部状态模型：

```text
导入这个 OPML 文件。
获取新文章并列出内容。
总结最近 24 小时有用的 AI 文章。
```

仓库包含 [skills/feed-reader/SKILL.md](skills/feed-reader/SKILL.md)。通过 Agent 常规的 Git 仓库或本地 Skill 安装方式注册该目录。Skill 会优先使用已安装的 `feed-reader` 命令或已构建的仓库，最后回退到 `npx --yes feed-reader-skill@latest`，不会直接执行 npm 临时 `_npx` 缓存中的文件。

可以显式使用 `$feed-reader`，也可以用匹配的自然语言触发。Skill 不定义无法跨平台复用的自定义 slash command，而是由 Agent 将请求转换为 CLI 调用。

Agent 和应用也可以直接使用 CLI：

```bash
feed-reader discover https://example.com/blog --json
feed-reader feeds import subscriptions.opml --project daily-ai --json
feed-reader feeds list --project daily-ai --json
feed-reader sync --project daily-ai --json --no-items
feed-reader sync --project daily-ai --source example --json --no-items
feed-reader items --project daily-ai --category AI --since 24h --json
feed-reader status --project daily-ai --json
```

`sync` 开始处理每个来源时会把进度写入 stderr。使用 `--source <id>` 可只同步一个已注册来源。JSON 输出可加 `--no-items`，只返回新增数量和逐源结果；需要内容时再调用 `items`。

`--project` 和 `--category` 都是可选参数：

- `feeds import` 接受 OPML 或原生 JSON，并把完整来源定义注册到 SQLite。
- 导入时 project 的解析顺序为：显式参数、JSON 配置值、`default`。
- `sync --project <name>` 直接从 SQLite 读取注册源，不需要配置文件。
- category 来自 OPML 分组、JSON 配置或用户的显式输入。
- 没有 category 时保持未分类；工具不会追问或猜测。
- `sync --config <file>` 继续支持便携、可审查的文件模式。
- 没有 `--project` 或 `--config` 时，CLI 先读取当前目录的 `feed-reader.json`，否则使用已注册的 `default` 项目。

通过 `feeds list` 确认导入后，运行时不再需要该 JSON；只有需要可审查备份时才保留。

如果只想把 OPML 转换或合并到 JSON，而不注册进 SQLite，可以显式提供 `--config`：

```bash
feed-reader feeds import subscriptions.opml --config feed-reader.json --json
```

删除注册源会停止后续同步，但保留历史内容和状态：

```bash
feed-reader feeds remove example --project daily-ai --json
```

## 输出模式

Package 始终提供确定性的标准化内容，不依赖任何 AI 服务。

- **列表：** 返回标题、链接、来源信息、日期、分类，以及 Feed 或列表页直接提供的内容。
- **摘要：** 由调用 Agent 对标准化内容生成摘要。
- **过滤：** CLI 负责确定性的字段过滤，语义过滤交给调用方。

首个版本不会逐篇打开文章抓取全文。

## 没有 RSS 的来源

为列表页配置稳定的 selectors：

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

`type: "auto"` 会先尝试发现 RSS 或 Atom，仅在页面没有声明 Feed 时使用 selectors。使用 `type: "web"` 可以直接读取列表页。`item`、`title` 和 `link` 必填；`date` 和 `summary` 可选。

兜底顺序如下：

1. 从页面元数据发现 RSS 或 Atom。
2. 没有 Feed 时使用配置的 CSS selectors。
3. 使用隔离的系统 Chrome 会话完成已识别的 `waf_pow` 验证。
4. 登录、CAPTCHA 或其他动态页面仍无法处理时，让调用 Agent 使用浏览器检查。
5. 页面仍无法确认时返回 `unverified`。

Package 包含 `playwright-core`，但不捆绑浏览器二进制，也不读取用户的 Chrome profile。验证 Cookie 仅保存在内存中，主机需已安装 Google Chrome。Package 不会猜测任意网站的页面结构，也不会绕过未支持的 CAPTCHA。

## 架构

- TypeScript Package 和 CLI 负责确定性的抓取、解析、去重和持久化。
- SQLite 保存注册源、运行状态和内容；JSON 保留为可选的便携配置。
- 轻量 Skill 将自然语言转换为 CLI 调用，并处理可选的浏览器兜底和摘要生成。

当前需求和实现约定见 [设计文档](docs/design.md)。

## 里程碑

1. **已完成：** 配置模型、SQLite 存储、标准化输出、RSS/Atom 解析、重试、baseline、去重和核心 CLI。
2. **已完成：** 从普通网页发现 Feed，并自动解析来源。
3. **已完成：** 将 OPML 分组导入为分类，并按 URL 合并重复 Feed。
4. **已完成：** 使用显式 CSS selectors 抽取静态列表页并保存标准化的 `web` 内容。
5. **已完成：** 添加轻量 Agent Skill，支持自然语言调用、列表/摘要选择和浏览器兜底。
6. **已完成：** 在发布 `v0.1.0` 前验证 RSS 发现、OPML 导入、selector 抽取、Node.js 20 兼容性、Skill 打包和 npm 内容。
7. **已完成：** 将项目来源注册到 SQLite，使 Agent 只需导入一次，之后可从任意目录按 project 同步。
8. **已完成：** 无需共享用户浏览器 Cookie，自动抓取受已识别 `waf_pow` 验证保护的 Feed。

## 许可证

[MIT](LICENSE)
