# cc-langfuse

A [Claude Code](https://docs.anthropic.com/en/docs/claude-code) hook that sends session transcripts to [Langfuse](https://langfuse.com/) for observability.

It runs as a Claude Code `Stop` hook — each time Claude Code finishes a response, cc-langfuse parses the `.jsonl` transcript and creates traces, generations, and tool spans in Langfuse.

## Setup

### 1. Configure Claude Code hook

Add the following to your Claude Code settings (`.claude/settings.json`):

```json
{
  "hooks": {
    "Stop": [
      {
        "type": "command",
        "command": "pnpm dlx github:elct9620/cc-langfuse"
      }
    ]
  }
}
```

### 2. Set environment variables

Add the following to `.claude/settings.local.json` (not checked into version control):

```json
{
  "env": {
    "TRACE_TO_LANGFUSE": "true",
    "CC_LANGFUSE_PUBLIC_KEY": "pk-lf-...",
    "CC_LANGFUSE_SECRET_KEY": "sk-lf-...",
    "CC_LANGFUSE_HOST": "https://cloud.langfuse.com"
  }
}
```

`CC_LANGFUSE_HOST` is optional and defaults to `https://cloud.langfuse.com`.

`CC_LANGFUSE_*` prefixed variants take precedence over `LANGFUSE_*` variants, so you can use cc-langfuse alongside other Langfuse integrations without conflict.

## How It Works

1. Claude Code triggers the `Stop` hook after each assistant response
2. cc-langfuse locates the latest `.jsonl` transcript in `~/.claude/projects/`
3. New messages since last run are parsed and grouped into turns
4. Each turn is sent to Langfuse as a trace with generations and tool spans
5. State is persisted to `~/.claude/state/cc-langfuse_state.json` to avoid reprocessing

### Trace Structure

| Level      | Name           | Content                       |
|------------|----------------|-------------------------------|
| Session    | Session ID     | Groups all turns in a session |
| Trace      | `Turn N`       | One user-assistant exchange   |
| Generation | Model name     | Assistant response content    |
| Span       | `Tool: {name}` | Tool input and output         |

## Development

Requires [pnpm](https://pnpm.io/) and Node.js.

```bash
pnpm install
pnpm build        # Bundle with rolldown to dist/index.js
pnpm test         # Run tests (vitest)
pnpm typecheck    # Type-check with tsc
pnpm format       # Format with prettier
```

## License

[Apache-2.0](LICENSE)
