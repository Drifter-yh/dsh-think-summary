# dsh-think-summary

[English](README.md) | [简体中文](README.zh-CN.md)

[![npm](https://img.shields.io/npm/v/@drifter-yh/dsh-think-summary)](https://www.npmjs.com/package/@drifter-yh/dsh-think-summary)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dsh](https://img.shields.io/badge/dsh-0.2.2--rc.1-4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that turns each
reasoning step into **1–3 readable bullet points**, so a 30-minute long-horizon run stays
skimmable. The full chain of thought is still one click away.

> Community plugin. Not affiliated with or maintained by DeepSeek AI.

## The problem

Harness renders the model's **raw** chain of thought. In a long task that means:

- collapsed: a one-line excerpt that tells you nothing, plus a step list like
  "ran a command, read a file, searched code";
- expanded: several thousand words of stream-of-consciousness, in the order the model
  happened to think it.

Codex feels different because it shows a **summary that the model itself produces**
(OpenAI's reasoning-summary channel). DeepSeek has no such channel — the only way to get
that experience is to generate the summary locally, one extra cheap call per step.

## What it does

Before:

```text
› 思考   The user reports a UI issue after the latest changes: a message shows raw
         evidence (the fallback) at the front, trace panel shows 24 tools…
```

After:

```text
› 思考 · 摘要
  • Root cause: the backend blocks the final event on memory extraction, so the client
    falls back to raw evidence
  • Plan: emit the final event before sealing, add a 12s timeout, fix the continuation
    helper to skip orphan user messages
  • Still needs tests for event ordering and timeout behaviour
```

Click the row to read the original reasoning, rendered as Markdown exactly as before.

## Install

```bash
dsh plugin --profile <your-profile> add @drifter-yh/dsh-think-summary
```

Some builds also expose a plugin registry under **Settings → Plugins**; otherwise use the command above.

Restart Harness once after installing: the host half is loaded as a forked module and
cannot be hot-swapped.

## Configure

Configuration lives in your profile's `cordis.patch.yml` (or the plugin's config panel):

```yaml
- id: think-summary
  name: '@drifter-yh/dsh-think-summary'
  config:
    provider: opencode-go          # any registered LLM route
    model: deepseek-v4.1-flash     # a cheap, fast model is the point
    enabled: true                  # master switch; false = no model calls at all
    maxOutputTokens: 2000          # budget for (reasoning + answer) tokens
    maxInputChars: 6000            # longer reasoning is clamped head+tail
    maxCallsPerSession: 300        # per-session cost ceiling
    maxCallsTotal: 600             # per-process cost ceiling
```

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch. `false` keeps the UI but makes no model calls. |
| `provider` / `model` | `opencode-go` / `deepseek-v4.1-flash` | Route used for summarising. |
| `maxInputChars` | `6000` | Reasoning is clamped head+tail beyond this. |
| `maxOutputTokens` | `2000` | Total completion budget. |
| `timeoutMs` | `25000` | Per-call timeout. |
| `minChars` | `160` | Steps shorter than this are not worth a call. |
| `maxCallsPerSession` / `maxCallsTotal` | `300` / `600` | Hard cost ceilings. |
| `cacheFile` | `~/.dsh/storages/think-summary/cache.json` | Persisted cache. |

Emergency switch: `localStorage.setItem('dsh-think-summary.enabled', 'false')` in the
browser disables requests for that page without touching the profile.

## How it works

```text
browser                                              host process
┌───────────────────────────┐   POST /summarize   ┌──────────────────────────────┐
│ shadows assistant-step    │ ──────────────────▶ │ ctx.llm.stream()             │
│ collapsed → bullets       │ ◀────────────────── │   provider/model from config │
│ expanded  → raw reasoning │     1–3 bullets     │ content-hash cache + budget  │
└───────────────────────────┘                     └──────────────────────────────┘
```

- The client registers `conversation.chat.node` at `priority: -1` for `assistant-step`,
  filtering blocks exactly like the shipped renderer (`groupPart` rules, `text` /
  `reasoning` / `image`; tool calls stay separate nodes).
- A summary is requested only when a step **settles** — never mid-stream.
- Summaries are keyed by a SHA-1 of the (clamped) reasoning text, so identical text is
  never billed twice, and the cache survives restarts.
- Any failure (no route, timeout, truncation, empty output) degrades to the original
  one-line excerpt. The plugin can never make the transcript worse than stock.

## Cost and latency

One cheap call per settled step. On `deepseek-v4.1-flash` a typical step takes 3–20 s
and a few thousand input tokens; the answer itself is ~3 short lines. A 40-step run is
well under one unit of currency on most routes — but this is a **paid** feature, so the
budgets above exist on purpose.

Rows older than three hours are not backfilled; opening an old session does not trigger
a wave of calls.

## Privacy and security

- Reasoning text is sent **only** to the provider you configure — the same provider that
  already serves the conversation.
- Summaries are cached locally at `~/.dsh/storages/think-summary/cache.json`.
- The HTTP endpoint (`/dsh-think-summary/*`) accepts loopback connections only, caps
  request bodies at 512 KB, requires `POST` for summarising, and runs at most two model
  calls at a time.
- No telemetry, no analytics, no network calls other than the model request.

## Compatibility

- Harness `>=0.2.2-rc.1 <0.2.3-0`; verified on `0.2.2-rc.1` using the desktop profile (the same web client Harness serves).
- The plugin shadows the shipped `assistant-step` renderer. A Harness release that
  changes the node contract can break rendering; the renderer is wrapped in an error
  boundary that falls back to plain text.

## Limitations

- **File mentions** (`@path`) inside assistant text render as plain text for now.
- **Chinese bullets only** — the prompt asks for Chinese; other languages are not wired up.
- **Reasoning effort cannot be disabled** on routes that only expose `low/high/max`, so
  `maxOutputTokens` must leave room for thinking. That is why the default is 2000.
- **History is not fully backfilled** (3-hour window) to keep costs predictable.
- Tool calls are still rendered by Harness itself; only `assistant-step` nodes are shadowed.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| No bullets anywhere | Is the plugin enabled? `curl http://127.0.0.1:<port>/dsh-think-summary/status` |
| `skipped: budget` | Raise `maxCallsPerSession` / `maxCallsTotal` |
| `摘要输出超长` in the host log | Raise `maxOutputTokens` or lower `maxInputChars` |
| Summaries stop after a Harness update | Open an issue with the Harness version and the console error |

## Development

```bash
node --check index.js
node --check client.js
npm pack --dry-run
```

Releases are published from CI on tag push (`.github/workflows/release.yml`) with npm
provenance; it needs an `NPM_TOKEN` repository secret.

The host half is a Cordis plugin (`apply(ctx, config)`); the client half is an ESM
module registered through `window.__ModuleLoader__.load`.

## License

MIT — see [LICENSE](LICENSE). Third-party notices: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
