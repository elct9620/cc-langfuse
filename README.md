# cc-langfuse

A [Claude Code](https://docs.anthropic.com/en/docs/claude-code) hook that sends session transcripts to [Langfuse](https://langfuse.com/) for observability.

It runs as a Claude Code `Stop` hook — each time Claude Code finishes a response, cc-langfuse receives the session ID and transcript path via stdin, parses the `.jsonl` transcript, and creates traces, generations, and tool spans in Langfuse.

## Setup

### 1. Configure Claude Code hook

Add the following to your Claude Code settings (`.claude/settings.json`):

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
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

### Version Pinning

By default, `pnpm dlx github:elct9620/cc-langfuse` installs from the latest commit on `main`. To pin to a specific release, append `#<tag>` to the package specifier:

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "pnpm dlx github:elct9620/cc-langfuse#v0.1.0"
          }
        ]
      }
    ]
  }
}
```

Replace `v0.1.0` with the desired version tag. Available tags can be found on the [releases page](https://github.com/elct9620/cc-langfuse/releases).

### 2. Set environment variables

Add the following to `.claude/settings.local.json` (not checked into version control):

```json
{
  "env": {
    "TRACE_TO_LANGFUSE": "true",
    "CC_LANGFUSE_PUBLIC_KEY": "pk-lf-...",
    "CC_LANGFUSE_SECRET_KEY": "sk-lf-...",
    "CC_LANGFUSE_BASE_URL": "https://cloud.langfuse.com"
  }
}
```

`CC_LANGFUSE_BASE_URL` is optional and defaults to `https://cloud.langfuse.com`.

`CC_LANGFUSE_*` prefixed variants take precedence over `LANGFUSE_*` variants, so you can use cc-langfuse alongside other Langfuse integrations without conflict.

### Debugging

Set `CC_LANGFUSE_DEBUG=true` to enable debug logging. Logs are written to `~/.claude/state/cc-langfuse_hook.log`.

## How It Works

1. Claude Code triggers the `Stop` hook after each assistant response
2. cc-langfuse receives `session_id` and `transcript_path` via stdin from Claude Code
3. New messages since last run are parsed and grouped into turns
4. Each turn is sent to Langfuse as a trace with agent, generation, and tool spans
5. State is persisted to `~/.claude/state/cc-langfuse_state.json` to avoid reprocessing

### Trace Structure

| Level      | Parent     | Name       | Content                       |
| ---------- | ---------- | ---------- | ----------------------------- |
| Session    |            | Session ID | Groups all turns in a session |
| Trace      | Session    | `Turn N`   | One user-assistant exchange   |
| Agent      | Trace      | `Turn N`   | Agent span for the turn       |
| Generation | Agent      | Model name | Assistant response content    |
| Tool       | Generation | `{name}`   | Tool input and output         |

## Development

Requires [pnpm](https://pnpm.io/) and Node.js.

```bash
pnpm install
pnpm build          # Bundle with rolldown to dist/index.js
pnpm test           # Run tests (vitest)
pnpm typecheck      # Type-check with tsc
pnpm format         # Format with prettier
pnpm format:check   # Check formatting without writing
```

### Force Fetching Latest Version

`pnpm dlx` caches downloaded packages. To force-fetch the latest version, run:

```bash
pnpm --config.dlx-cache-max-age=0 dlx github:elct9620/cc-langfuse
```

This is intended for one-off manual updates, not for use inside hook configuration.

## License

[Apache-2.0](LICENSE)
