# Extensions

Pi loads every `extensions/*` entrypoint automatically. The `extensions` array in `settings.json` turns off `custom-ocr` and `summaries`; remove a negation and run `/reload` to turn one on. `shared/` holds helpers and loads nothing itself.

| Responsibility | Extension | Notes |
| --- | --- | --- |
| Delegation | `subagents` | `subagent_*`, `/subagents`, `/btw`; Pi, Claude, and Codex backends |
| Planned workflows | `workflows` | `workflow` tool and `/workflows`; scripted multi-step runs with a dashboard and sandbox |
| Background processes | `background-terminals` | `bg_*` and `/ps`; process trees are killed at session shutdown |
| Header and footer | `ui-customization` | Sole `setHeader`/`setFooter` owner; directory, model, usage, git, and extension status lines |
| Git status and pull requests | `git-info` | Branch, changed-file count, and open PR via `gh`; `/lg`, `/pr` |
| Model and context status | `model-info` | Provider, model, context %, cost, tok/s; no tools or commands |
| Run recaps (off) | `summaries` | Per-run recap entries; `/summary-model` picks the recap model |
| File and content search | `file-search` | `fd` and `rg` tools; system binaries first, `bin/` download as fallback |
| Web search and scraping | `firecrawl-search` | `search`, `crawl`, `scrape` through Firecrawl; needs `FIRECRAWL_API_KEY` in `.env` |
| Copy thread | `copy-all` | `/copy-all` copies user and assistant messages to the clipboard |
| Input composer | `composer` | Custom editor with image previews, skill and tool completion, and a draft stash. See [composer controls](composer/README.md) |
| Documents and images (off) | `custom-ocr` | `parse-file`, `/ocr`, `/private-image`. See [custom-ocr](custom-ocr/README.md) |
| Usage and cache diagnosis | `stats` | `/stats`, `/stats-warnings`, `pi-stats`. See [stats](stats/README.md) |
| Questions | `ask-user-question` | `ask_user_question` tool for multiple-choice questions with previews. See [ask-user-question](ask-user-question/README.md) |
| Codex conversion | `010-lazy-codex-conversion.ts` | Loads `@howaboua/pi-codex-conversion` when a Codex-like model is selected |

`workflows`, `summaries`, `copy-all`, `file-search`, `firecrawl-search`, `ui-customization`, `subagents`, `background-terminals`, `git-info`, `model-info`, and `shared/` started as a fork of [`davis7dotsh/my-pi-setup`](https://github.com/davis7dotsh/my-pi-setup) (MIT; see [`LICENSE.my-pi-setup`](../LICENSE.my-pi-setup)). `ask-user-question` is a fork of [`@juicesharp/rpiv-ask-user-question`](https://github.com/juicesharp/rpiv-mono) and keeps its MIT [license](ask-user-question/LICENSE).

Pi workers started by `subagents` and `workflows` go through `shared/child-session.ts`. They get Pi's native tools and the provider integrations, but not the parent's UI, delegation tools, or question tools. Project instructions follow Pi's context loading, and project skills still need project trust.

Live Codex integration tests open real sessions and are skipped by default:

```sh
PI_LIVE_CODEX_TESTS=1 node --test --experimental-strip-types extensions/subagents/codex.test.ts
```
