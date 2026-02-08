# cc-langfuse

## Purpose

A Node.js CLI tool that sets up Claude Code hooks to send usage data to Langfuse, enabling observability of Claude Code sessions with minimal configuration.

## Users

- Claude Code users who want to track and analyze their Claude Code usage through Langfuse.

## Impacts

- Users can monitor Claude Code sessions in Langfuse without writing custom hook scripts.
- Users complete setup in under a minute with a single command.

## Non-goals

- Custom hook logic or plugin system.
- Supporting tracing backends other than Langfuse.
- Real-time streaming of data during a session.

## Success Criteria

- Running `pnpm dlx github:elct9620/cc-langfuse` configures the hook with interactive prompts.
- Claude Code's `Stop` hook triggers `pnpm dlx github:elct9620/cc-langfuse hook`, sending session data to Langfuse.
- No local script files are installed; all execution happens via `pnpm dlx`.
- Traces appear in Langfuse with session, turn, generation, and tool span structure.

---

## Behaviors

### Setup Command

```
pnpm dlx github:elct9620/cc-langfuse
```

Supports version pinning:

```
pnpm dlx github:elct9620/cc-langfuse#0.1.0
```

The CLI runs interactively to configure the hook.

| Step | Action                                          | Details                                      |
| ---- | ----------------------------------------------- | -------------------------------------------- |
| 1    | Prompt for Langfuse credentials                 | `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` |
| 2    | Prompt for Langfuse host                        | Default: `https://cloud.langfuse.com`        |
| 3    | Register hook in `~/.claude/settings.json`      | Add `Stop` hook entry                        |
| 4    | Write env vars to `.claude/settings.local.json` | In the current project directory             |
| 5    | Confirm success                                 | Print summary of what was configured         |

When the user specifies a version (e.g., `#0.1.0`), the hook command also pins to that version.

#### Hook Configuration (`~/.claude/settings.json`)

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "pnpm dlx github:elct9620/cc-langfuse hook"
          }
        ]
      }
    ]
  }
}
```

#### Per-Project Environment (`.claude/settings.local.json`)

Tracing is opt-in per project. The setup command writes this file in the current project directory.

```json
{
  "env": {
    "TRACE_TO_LANGFUSE": "true",
    "LANGFUSE_PUBLIC_KEY": "pk-lf-...",
    "LANGFUSE_SECRET_KEY": "sk-lf-...",
    "LANGFUSE_HOST": "https://cloud.langfuse.com"
  }
}
```

### Hook Subcommand (`hook`)

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

| Level      | Name                       | Content                                   |
| ---------- | -------------------------- | ----------------------------------------- |
| Session    | Session ID from transcript | Groups all turns in a Claude Code session |
| Trace      | `Turn N`                   | One user-assistant exchange               |
| Generation | Model name                 | Assistant response content                |
| Span       | `Tool: {name}`             | Tool input and output                     |

### Error Scenarios

| Scenario                                                   | Behavior                                                                                 |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `~/.claude/settings.json` does not exist                   | Create the file with hook configuration                                                  |
| `~/.claude/settings.json` already has a `cc-langfuse` hook | Overwrite the existing hook entry, preserve other hooks                                  |
| `.claude/settings.local.json` already exists in project    | Merge `env` entries, preserve other settings                                             |
| Transcript file not found                                  | Exit silently (no error to avoid disrupting Claude Code)                                 |
| Langfuse API unreachable                                   | Log error to `~/.claude/state/cc-langfuse_hook.log`, exit without disrupting Claude Code |
| Invalid credentials at setup time                          | Do not validate; errors surface in hook log at runtime                                   |
| State file corrupted or missing                            | Reset state, reprocess from beginning of current transcript                              |

---

## Technical Decisions

| Decision        | Choice                                    | Reason                                                            |
| --------------- | ----------------------------------------- | ----------------------------------------------------------------- |
| Hook type       | `Stop` only                               | Matches official integration; transcript is complete at stop time |
| Execution model | Always via `pnpm dlx`                     | No local install required; version pinning via git ref            |
| Runtime         | Node.js (ES Modules)                      | Matches project ecosystem; available where Claude Code runs       |
| Langfuse SDK    | `langfuse` npm package                    | Declared as dependency, resolved by `pnpm dlx`                    |
| State file      | `~/.claude/state/cc-langfuse_state.json`  | Follows Claude Code convention for state storage                  |
| Log file        | `~/.claude/state/cc-langfuse_hook.log`    | Follows Claude Code convention for log storage                    |
| Credentials     | Per-project `.claude/settings.local.json` | Opt-in per project; follows official pattern                      |

## Terminology

| Term       | Definition                                                                                            |
| ---------- | ----------------------------------------------------------------------------------------------------- |
| Turn       | One user message followed by all assistant responses and tool invocations until the next user message |
| Transcript | The `.jsonl` file Claude Code writes for each session in `~/.claude/projects/`                        |
| Hook       | A command Claude Code runs at specific lifecycle events (here: `Stop`)                                |
