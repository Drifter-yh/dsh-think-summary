# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-11-08

### Changed

- Summaries are now **one or two plain sentences of progress** ("我读完了…，接下来…") instead
  of up to three bullets, and render as a paragraph under `思考 · 进度`. The old three-bullet
  cap and the bullet markers are gone.
- The cache key mixes in a prompt version (`progress-v2`), so entries written with the old
  bullet format are invalidated instead of being shown next to the new prose.
- README recommends `collapseTiming: next-input` for `ui-chat`, so the latest turn stays open
  and progress appears step by step without expanding the process row.

### Fixed

- The client no longer dies for the rest of the page once a lifetime request quota is spent.
  The old `MAX_REQUESTS = 240` cap is replaced by a sliding window (60 requests per 10
  minutes) that recovers on its own; long-lived desktop windows keep working.
- Host `skipped` answers (budget exhausted, disabled) are remembered for ten minutes, so
  remounting a row (scrolling, switching sessions) no longer re-posts the same text.
- In-flight requests are cancelled when their row unmounts, and shared dedupe now reference
  counts callers — the last one leaving aborts the fetch instead of burning a concurrency slot.
- Aborts, rate-limit rejections, suppressed answers, cached failures and the open circuit no
  longer count toward the five-strike circuit breaker; only real network/model failures do.
- The row shows `摘要已暂停` with a reason tooltip instead of silently degrading.

## [0.1.0] - 2026-11-07

First public release.

### Added

- Per-step thinking summaries: each settled reasoning block is condensed into 1–3 bullet
  points by a configurable, cheap LLM route, rendered inline in the collapsed state.
- Expandable original reasoning: clicking the row restores the full chain of thought with
  the shipped Markdown rendering.
- Content-hash cache, persisted to `~/.dsh/storages/think-summary/cache.json`, so identical
  reasoning is never billed twice and survives restarts.
- Cost controls: per-session and per-process call ceilings, input clamping, output token
  budget, per-call timeout, and two-way concurrency limit.
- Master switch (`config.enabled`) plus a browser-side emergency switch via
  `localStorage['dsh-think-summary.enabled']`.
- Hardened local endpoint: loopback-only, 512 KB body cap, POST required for summarising.
- Graceful degradation: every failure falls back to the original one-line excerpt, and the
  renderer is wrapped in an error boundary.

### Notes

- Verified against DeepSeek Harness `0.2.2-rc.1` using the desktop profile.
- The client shadows the shipped `assistant-step` renderer; file mentions inside assistant
  text currently render as plain text.
