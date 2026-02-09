# cc-langfuse

## Purpose

A Node.js CLI hook tool that sends Claude Code session data to Langfuse, enabling observability of Claude Code sessions.

## Users

- Claude Code users who want to track and analyze their Claude Code usage through Langfuse.

## Impacts

- Users can monitor Claude Code sessions in Langfuse without writing custom hook scripts.

## Non-goals

- Custom hook logic or plugin system.
- Supporting tracing backends other than Langfuse.
- Real-time streaming of data during a session.

## Success Criteria

- Claude Code's `Stop` hook triggers `pnpm dlx github:elct9620/cc-langfuse`, sending session data to Langfuse.
- No local script files are installed; all execution happens via `pnpm dlx`.
- Traces appear in Langfuse with session, turn, generation, and tool observation structure.

---

## Behaviors

### Configuration

Users manually configure the hook and credentials.

#### Hook Configuration (`~/.claude/settings.json`)

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "pnpm dlx github:elct9620/cc-langfuse"
          }
        ]
      }
    ]
  }
}
```

#### Per-Project Environment (`.claude/settings.local.json`)

Tracing is opt-in per project. Users add this to the project's `.claude/settings.local.json`.

```json
{
  "env": {
    "TRACE_TO_LANGFUSE": "true",
    "LANGFUSE_PUBLIC_KEY": "pk-lf-...",
    "LANGFUSE_SECRET_KEY": "sk-lf-...",
    "LANGFUSE_BASE_URL": "https://cloud.langfuse.com"
  }
}
```

#### Debug Logging

Set `CC_LANGFUSE_DEBUG` to `"true"` to enable debug-level logging to `~/.claude/state/cc-langfuse_hook.log`.

### Hook Behavior

Triggered by Claude Code after each assistant response via `pnpm dlx`.

Exits immediately if `TRACE_TO_LANGFUSE` is not `"true"`.

| Step | Action                                                                                                                        |
| ---- | ----------------------------------------------------------------------------------------------------------------------------- |
| 1    | Check `TRACE_TO_LANGFUSE` env var; exit if not enabled                                                                        |
| 2    | Read `session_id` and `transcript_path` from stdin JSON                                                                       |
| 3    | Load state from `~/.claude/state/cc-langfuse_state.json`                                                                      |
| 4    | Check transcript first line for previous session ID; if different from current and transcript exists, recover its turns first |
| 5    | Parse new lines from the transcript since last processed line                                                                 |
| 6    | Group messages into turns (user message -> assistant responses -> tool results)                                               |
| 7    | Create Langfuse traces and spans for each turn                                                                                |
| 8    | Update state file with new line count                                                                                         |

### Trace Structure in Langfuse

```
Session (Session ID)
└── Trace: "Turn N"
    └── Root Span: "Turn N"            (asType: "agent")
        ├── Generation: "{model}"      (asType: "generation")
        │   └── Tool: "{name}"          (asType: "tool")
        ├── Generation: "{model}"      (asType: "generation")
        │   ├── Tool: "{name}"         (asType: "tool")
        │   └── Tool: "{name}"         (asType: "tool")
        └── Generation: "{model}"      (asType: "generation")
```

Each level carries the following data:

| Level      | input                                | output                             |
| ---------- | ------------------------------------ | ---------------------------------- |
| Trace      | User message                         | Last Generation's assistant text   |
| Root Span  | User message                         | Last Generation's assistant text   |
| Generation | User message (first Generation only) | Assistant text for that invocation |
| Tool       | Tool call arguments                  | Tool execution result              |

- **Session** — Groups all turns by the transcript's session ID, corresponding to one Claude Code conversation
- **Trace** — One Turn (a user → assistant exchange), named `Turn N`. `output` is the final response the user sees.
- **Root Span** (`asType: "agent"`) — The root observation of each turn, typed as `"agent"` to represent a Claude Code agent interaction. Carries the same `input`/`output` as its parent Trace.
- **Generation** (`asType: "generation"`) — One model invocation, named after the model. A single Turn may contain multiple Generations when the model calls tools and responds again. Only the first Generation carries `input` (the user's message). Subsequent Generations omit `input`; their context (tool results) is already captured in the preceding Generation's Tool observations.
- **Tool** (`asType: "tool"`) — One tool execution, named `{name}` (the tool name directly); parented under the Generation that initiated the tool call

#### Usage and Cost

Each Generation observation includes token usage when available in the JSONL transcript:

| Field          | Key                       | Description                   |
| -------------- | ------------------------- | ----------------------------- |
| `usageDetails` | `input`                   | Number of input tokens        |
| `usageDetails` | `output`                  | Number of output tokens       |
| `usageDetails` | `total`                   | Total tokens (input + output) |
| `usageDetails` | `cache_read_input_tokens` | Cached input tokens           |

Cost is not set explicitly; Langfuse derives cost automatically from the model registry when `usageDetails` and `model` are provided.

#### Timing

Each observation carries start and end timestamps derived from the JSONL transcript's `timestamp` field:

| Level      | startTime                                          | endTime                                                       |
| ---------- | -------------------------------------------------- | ------------------------------------------------------------- |
| Trace      | User message timestamp                             | Latest timestamp among all assistant and tool result messages |
| Root Span  | User message timestamp                             | Same as Trace endTime                                         |
| Generation | Assistant message timestamp                        | Next Generation's start, or current wall-clock time if last   |
| Tool       | Previous Tool's endTime, or Generation's startTime | Matching tool_result message timestamp                        |

Tools within a Generation are sequential: the first Tool starts at the Generation's startTime, and each subsequent Tool starts at the previous Tool's endTime (its tool_result timestamp). This reflects that Claude Code executes tool calls one after another, not in parallel.

If a message lacks a `timestamp` field, timing for that observation is omitted (SDK defaults to creation time).

### Message Filtering

- Messages with `isMeta: true` (e.g., skill framework scaffolding injected by `/fix` or other slash commands) are skipped during turn grouping. This prevents framework text from replacing the real user message as trace input.

### Incremental Processing

- `last_line` only advances to the end of the last complete turn, not to the end of the transcript. An incomplete turn (a user message without a subsequent assistant response) is reprocessed on the next hook invocation.

### Cross-Session Recovery

When Claude Code exits Plan Mode, the session ID changes. The new transcript may begin with messages from the previous session (a user message from the old session). This creates an orphaned cross-session message.

**Detection**: The first line of the current transcript carries a `sessionId`. If it differs from the current session ID and the previous session's transcript file exists in the same directory, recovery is triggered.

**Recovery processes each session independently** via sequential `processTranscript` calls:

1. Process previous session's transcript (recovers any unprocessed turns)
2. Process current session's transcript (using updated state from step 1)

Each call follows the same proven code path used for normal (non-recovery) sessions. The previous session's `last_line` in state determines where to resume reading its transcript, so already-processed lines are naturally skipped.

| Scenario                                   | Previous session in state? | Behavior                                                         |
| ------------------------------------------ | -------------------------- | ---------------------------------------------------------------- |
| Previous session's Stop hook never fired   | No                         | Recover all unprocessed turns from previous transcript           |
| Previous session's Stop hook already fired | Yes                        | Skip already-processed lines; no new turns from previous session |

**Turn attribution**: All turns in a transcript are attributed to the session ID passed to `processTranscript`. An orphaned previous-session user message in the current transcript (with no matching assistant response) is skipped as an incomplete turn. If it does pair with an assistant response, it is attributed to the current session.

| Transcript              | Attributed to    | Turn count incremented on            |
| ----------------------- | ---------------- | ------------------------------------ |
| Previous session's file | Previous session | `state[prevSessionId].turn_count`    |
| Current session's file  | Current session  | `state[currentSessionId].turn_count` |

### Error Scenarios

| Scenario                        | Behavior                                                                                 |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| Transcript file not found       | Exit silently (no error to avoid disrupting Claude Code)                                 |
| Langfuse API unreachable        | Log error to `~/.claude/state/cc-langfuse_hook.log`, exit without disrupting Claude Code |
| State file corrupted or missing | Reset state, reprocess from beginning of current transcript                              |

---

## Technical Decisions

| Decision        | Choice                                     | Reason                                                                         |
| --------------- | ------------------------------------------ | ------------------------------------------------------------------------------ |
| Hook type       | `Stop` only                                | Matches official integration; transcript is complete at stop time              |
| Execution model | Always via `pnpm dlx`                      | No local install required; version pinning via git ref                         |
| Language        | TypeScript (compiled to JavaScript)        | Type safety; compiled to ES Modules for runtime                                |
| Runtime         | Node.js (ES Modules)                       | Matches project ecosystem; available where Claude Code runs                    |
| Bundler         | Rolldown → single `dist/index.js`          | Single-file output reduces `pnpm dlx` install time and simplifies distribution |
| Langfuse SDK    | v4 (`@langfuse/tracing`, `@langfuse/otel`) | Supports semantic observation types (generation, tool); requires OpenTelemetry |
| State file      | `~/.claude/state/cc-langfuse_state.json`   | Follows Claude Code convention for state storage                               |
| Log file        | `~/.claude/state/cc-langfuse_hook.log`     | Follows Claude Code convention for log storage                                 |
| Credentials     | Per-project `.claude/settings.local.json`  | Opt-in per project; follows official pattern                                   |

## Terminology

| Term       | Definition                                                                                                     |
| ---------- | -------------------------------------------------------------------------------------------------------------- |
| Turn       | One user message followed by all assistant responses and tool invocations until the next user message          |
| Root Span  | The root observation of each turn (`asType: "agent"`); represents the agent interaction boundary               |
| Generation | One model invocation and its response (`asType: "generation"`); a single Turn may contain multiple Generations |
| Tool       | One tool execution observation (`asType: "tool"`); parented under the Generation that invoked it               |
| Transcript | The `.jsonl` file Claude Code writes for each session in `~/.claude/projects/`                                 |
| Hook       | A command Claude Code runs at specific lifecycle events (here: `Stop`)                                         |
| Timestamp  | ISO 8601 UTC time recorded on each JSONL message, used to derive observation start/end times                   |
