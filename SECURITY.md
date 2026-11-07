# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Use GitHub's private
vulnerability reporting on this repository (Security → Report a vulnerability), or email
the maintainer listed in `package.json`. You can expect an acknowledgement within a few
days.

## Scope and threat model

This plugin runs inside your DeepSeek Harness process and adds one local HTTP endpoint.
It is deliberately small, but three things are worth knowing:

### 1. Local endpoint

- `GET /dsh-think-summary/status` — counters, no secrets.
- `GET /dsh-think-summary/debug` — the reasoning-effort levels the configured model exposes.
- `POST /dsh-think-summary/summarize` — the only route that spends money.

Mitigations:

- requests are rejected unless they originate from loopback;
- request bodies are capped at 512 KB;
- `summarize` requires `POST`;
- at most two model calls run concurrently, and both a per-session and a per-process call
  ceiling apply;
- if Harness exposes `connection.requestRejection`, it is consulted first.

A local process running as your user can still call `summarize` and consume budget up to
those ceilings. That is why the ceilings exist.

### 2. Data leaving the machine

Reasoning text is sent to the **provider you configure** (`config.provider` /
`config.model`), which is normally the same provider already serving the conversation.
No other network calls are made. Summaries are cached on disk at
`~/.dsh/storages/think-summary/cache.json`; delete that file to remove them.

### 3. Renderer shadowing

The client registers a replacement for the `assistant-step` chat node. It renders text,
reasoning, and images from the node payload and never injects remote content. Markdown is
rendered by Harness's own `MarkdownText` component, so its sanitisation applies unchanged.
An error boundary degrades a failing render to plain text.

## Supported versions

Only the latest published version is supported. Harness versions outside the range
declared in `package.json` (`engines.dsh`) are untested.
