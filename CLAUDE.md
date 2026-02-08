# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

cc-langfuse is a Node.js CLI hook tool for Claude Code that parses `.jsonl` transcripts and sends session data to Langfuse for observability. It runs as a Claude Code `Stop` hook via `pnpm dlx` — no local installation or setup command needed.

## Commands

- `pnpm build` — bundle with rolldown to `dist/index.js`
- `pnpm typecheck` — type-check with `tsc --noEmit` (no output files)
- `pnpm test` — run all tests (vitest)
- `pnpm test -- test/parser.test.ts` — run a single test file
- `pnpm format` — format all files with prettier
- `pnpm format:check` — check formatting without writing

## Architecture

- **TypeScript** source in `src/`, bundled via rolldown to single-file `dist/index.js` (ESM)
- **Entry point:** `bin/cli.js` — plain JS shim that imports `dist/index.js` and calls `hook()`
- **Runtime dependency:** Langfuse SDK v4 (`@langfuse/tracing`, `@langfuse/otel`) + `@opentelemetry/sdk-node` for trace/observation creation
- **Package manager:** pnpm (enforced via `packageManager` field)
- **Build:** rolldown bundles all src into one file; `@langfuse/*`, `@opentelemetry/*`, and `node:*` are externals

### Source Modules

| File                | Responsibility                                                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `src/types.ts`      | Shared type definitions (Message, ContentBlock variants, ToolCall, Turn, GroupTurnsResult)                                        |
| `src/content.ts`    | Content helpers: type guards, accessors (getContent, getTextContent, getToolCalls, etc.)                                          |
| `src/parser.ts`     | Turn grouping (TurnBuilder), assistant part merging, tool result matching; re-exports types + content helpers for backward compat |
| `src/tracer.ts`     | Langfuse trace/generation/tool observation creation from parsed turns                                                             |
| `src/filesystem.ts` | State persistence (load/save) + transcript file discovery                                                                         |
| `src/logger.ts`     | Constants (STATE_FILE, LOG_FILE, DEBUG, HOOK_WARNING_THRESHOLD_SECONDS) + file logging                                            |
| `src/index.ts`      | Main `hook()` entry point, orchestrates all modules                                                                               |

### Module Dependencies

```
index.ts → tracer.ts → content.ts → types.ts
                      → parser.ts  → content.ts
         → filesystem.ts
         → logger.ts
```

Each module imports directly from its dependencies; there are no re-exports.

### Hook Flow

Triggered by Claude Code `Stop` hook via `pnpm dlx github:elct9620/cc-langfuse`:

1. Check `TRACE_TO_LANGFUSE` env var; exit if not enabled
2. Locate the most recently modified `.jsonl` transcript in `~/.claude/projects/`
3. Load state from `~/.claude/state/cc-langfuse_state.json`
4. Parse new lines, group into turns (user → assistant → tool results)
5. Create Langfuse traces/spans (Session → Turn → Generation/Tool spans)
6. Update state file

### Trace Structure

| Level      | Parent     | Name           | Content                              |
| ---------- | ---------- | -------------- | ------------------------------------ |
| Session    |            | Session ID     | Groups all turns in a session        |
| Trace      | Session    | `Turn N`       | One user-assistant exchange          |
| Generation | Trace      | Model name     | Assistant response (one per message) |
| Tool       | Generation | `Tool: {name}` | Tool input and output                |

### Environment Variables

| Variable                                         | Purpose                                                   |
| ------------------------------------------------ | --------------------------------------------------------- |
| `TRACE_TO_LANGFUSE`                              | Must be `"true"` to enable tracing                        |
| `CC_LANGFUSE_PUBLIC_KEY` / `LANGFUSE_PUBLIC_KEY` | Langfuse public API key                                   |
| `CC_LANGFUSE_SECRET_KEY` / `LANGFUSE_SECRET_KEY` | Langfuse secret API key                                   |
| `CC_LANGFUSE_BASE_URL` / `LANGFUSE_BASE_URL`     | Langfuse base URL (default: `https://cloud.langfuse.com`) |

`CC_LANGFUSE_*` prefixed variants take precedence over `LANGFUSE_*` variants.

## Conventions

- Conventional commits (e.g. `feat(scope):`, `fix:`, `chore:`)
- Prettier auto-runs on Edit/Write via Claude Code PostToolUse hook
- Tests use vitest with `describe`/`it`/`expect` pattern
