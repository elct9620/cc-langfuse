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

### Hook Behavior

Triggered by Claude Code after each assistant response via `pnpm dlx`.

Exits immediately if `TRACE_TO_LANGFUSE` is not `"true"`.

| Step | Action                                                                          |
| ---- | ------------------------------------------------------------------------------- |
| 1    | Check `TRACE_TO_LANGFUSE` env var; exit if not enabled                          |
| 2    | Locate the most recently modified `.jsonl` transcript in `~/.claude/projects/`  |
| 3    | Load state from `~/.claude/state/cc-langfuse_state.json`                        |
| 4    | Parse new lines from the transcript since last processed line                   |
| 5    | Group messages into turns (user message -> assistant responses -> tool results) |
| 6    | Create Langfuse traces and spans for each turn                                  |
| 7    | Update state file with new line count                                           |

### Trace Structure in Langfuse

```
Session (Session ID)
└── Trace: "Turn N"
    └── Generation: "{model}"          (asType: "generation")
        └── Tool: "Tool: {name}"       (asType: "tool")
```

Each level carries the following data:

| Level      | input                                | output                             |
| ---------- | ------------------------------------ | ---------------------------------- |
| Trace      | User message                         | Last Generation's assistant text   |
| Generation | User message (first Generation only) | Assistant text for that invocation |
| Tool       | Tool call arguments                  | Tool execution result              |

- **Session** — Groups all turns by the transcript's session ID, corresponding to one Claude Code conversation
- **Trace** — One Turn (a user → assistant exchange), named `Turn N`. `output` is the final response the user sees.
- **Generation** (`asType: "generation"`) — One model invocation, named after the model. A single Turn may contain multiple Generations when the model calls tools and responds again. Only the first Generation carries `input` (the user's message). Subsequent Generations omit `input`; their context (tool results) is already captured in the preceding Generation's Tool observations.
- **Tool** (`asType: "tool"`) — One tool execution, named `Tool: {name}`; parented under the Generation that initiated the tool call

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
| Generation | One model invocation and its response (`asType: "generation"`); a single Turn may contain multiple Generations |
| Tool       | One tool execution observation (`asType: "tool"`); parented under the Generation that invoked it               |
| Transcript | The `.jsonl` file Claude Code writes for each session in `~/.claude/projects/`                                 |
| Hook       | A command Claude Code runs at specific lifecycle events (here: `Stop`)                                         |
