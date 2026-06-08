# AGENTS.md - SignMate AI Collaboration Guide

## Project Overview

SignMate is a Node.js / Express / Playwright automation service for site sign-in, visit-based keepalive, scheduling, notification, backup, and a browser-based management UI.

## Shared Knowledge Graph

- Use `.understand-anything/knowledge-graph.json` as the shared architecture map for OpenClaw, Hermes, and other agents.
- The Understand-Anything output language is Chinese (`zh`) and auto-update is disabled in `.understand-anything/config.json`.
- Regenerate the graph manually before important releases or architecture handoff commits.
- Commit only final shared artifacts: `.understand-anything/knowledge-graph.json`, `.understand-anything/config.json`, `.understand-anything/meta.json`, and `.understand-anything/.understandignore`.
- Do not commit `.understand-anything/intermediate/`, `.understand-anything/tmp/`, or `.understand-anything/fingerprints.json`.

## CodeGraph Policy

- CodeGraph indexes are local-only and must not be committed.
- Keep `.codegraph/` and any CodeGraph cache/database output ignored.
- Each machine or agent should build its own CodeGraph index after cloning.
- Current local CodeGraph CLI indexing is available through `~/.openclaw/tools/cg`; it is intentionally not a project dependency.

## Engineering Rules

- Treat the built-in site catalog and driver capabilities as the source of truth for whether a site is sign-in or keepalive.
- Do not persist derived capability fields such as `kind`, `signin_mode`, or `enforced_kind` in user config.
- Keep diagnostics secret-safe: report cookie/token/password metadata only, never secret values.
- After source changes in deployed Docker environments, rebuild the service image rather than only restarting the container.
- After frontend asset changes, bump cache/versioning so browsers do not keep stale UI logic.

## Release Hygiene

- Inspect `git status` before commits and releases.
- Do not commit runtime config, cookies, logs, backups, secrets, `.env*`, `data/`, or generated local caches.
- For formal releases, update `CHANGELOG.md`, version references, and release notes; run the project release checks before tagging.
