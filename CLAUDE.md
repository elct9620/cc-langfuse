# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

cc-langfuse is a Node.js CLI hook tool for Claude Code that parses `.jsonl` transcripts and sends session data to Langfuse for observability. It runs as a Claude Code `Stop` hook via `pnpm dlx` — no local installation or setup command needed.

## Commands

- `pnpm test` — run all tests (vitest)
- `pnpm test -- test/cli.test.js` — run a single test file
- `pnpm format` — format all files with prettier
- `pnpm format:check` — check formatting without writing

## Architecture

- **ES Modules only** (`"type": "module"` in package.json), plain JavaScript, no build step
- **Entry point:** `bin/cli.js` — CLI executable registered via npm `bin` field
- **Runtime dependency:** Langfuse SDK (`langfuse`) for trace/span creation
- **Package manager:** pnpm (enforced via `packageManager` field)

### Hook Flow

Triggered by Claude Code `Stop` hook via `pnpm dlx github:elct9620/cc-langfuse hook`:

1. Check `TRACE_TO_LANGFUSE` env var; exit if not enabled
2. Locate the most recently modified `.jsonl` transcript in `~/.claude/projects/`
3. Load state from `~/.claude/state/cc-langfuse_state.json`
4. Parse new lines, group into turns (user → assistant → tool results)
5. Create Langfuse traces/spans (Session → Turn → Generation/Tool spans)
6. Update state file

### Trace Structure

| Level      | Name           | Content                         |
| ---------- | -------------- | ------------------------------- |
| Session    | Session ID     | Groups all turns in a session   |
| Trace      | `Turn N`       | One user-assistant exchange     |
| Generation | Model name     | Assistant response content      |
| Span       | `Tool: {name}` | Tool input and output           |

## Conventions

- Conventional commits (e.g. `feat(scope):`, `fix:`, `chore:`)
- Prettier auto-runs on Edit/Write via Claude Code PostToolUse hook
- Tests use vitest with `describe`/`it`/`expect` pattern
