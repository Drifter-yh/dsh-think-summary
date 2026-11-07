# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
