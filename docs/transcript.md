# Claude Code JSONL Transcript Structure

## 1. Overview

Claude Code records every session as a `.jsonl` (JSON Lines) file. Each line is a single JSON object representing one message, ordered chronologically.

- **Storage location:** `~/.claude/projects/<project-hash>/`
- **File naming:** `<session-uuid>.jsonl`
- **Format:** one JSON object per line, no trailing comma

The cc-langfuse hook receives `session_id` and `transcript_path` via stdin JSON from the Claude Code Stop hook, then parses new lines since the last processed position.

## 2. Message Types

### User Message

A message sent by the user. The first user message in a transcript typically carries a `sessionId` field.

```json
{
  "sessionId": "abc-123",
  "type": "user",
  "timestamp": "2025-01-15T10:00:00Z",
  "content": "hello"
}
```

Subsequent user messages may omit `sessionId`:

```json
{
  "type": "user",
  "content": "second question"
}
```

### Assistant Message

A model response. Always has a nested `message` object with `role: "assistant"`. May include `model`, `usage`, and a `timestamp` at the top level or inside `message`.

```json
{
  "timestamp": "2025-01-15T10:00:05Z",
  "message": {
    "id": "m1",
    "role": "assistant",
    "model": "claude-sonnet-4-5-20250929",
    "content": [{ "type": "text", "text": "hi there" }],
    "usage": {
      "input_tokens": 100,
      "output_tokens": 50,
      "cache_read_input_tokens": 20
    }
  }
}
```

A single model invocation may be split across multiple JSONL lines sharing the same `message.id`. The parser merges these into one assistant message (see [Multi-Part Assistant Messages](#multi-part-assistant-messages)).

### Tool Result Message

A message with `type: "user"` whose `content` array contains `tool_result` blocks. Despite having `type: "user"`, these are **not** treated as new user turns — the parser detects them via `isToolResult()` and groups them with the current turn.

```json
{
  "type": "user",
  "timestamp": "2025-01-15T10:00:10Z",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "t1",
      "content": "file data"
    }
  ]
}
```

### Meta Message

Any message with `isMeta: true` is injected by the Claude Code framework (e.g., skill scaffolding from `/fix` or other slash commands). The parser **skips** these entirely during turn grouping.

```json
{
  "type": "user",
  "content": "skill rubric scaffolding...",
  "isMeta": true
}
```

Meta messages can also appear as assistant messages:

```json
{
  "message": {
    "id": "m1",
    "role": "assistant",
    "content": "meta response"
  },
  "isMeta": true
}
```

## 3. Content Block Types

The `content` field in messages can be a string or an array of typed blocks:

### TextBlock

```json
{ "type": "text", "text": "some text content" }
```

### ToolUseBlock

A tool invocation request from the assistant:

```json
{
  "type": "tool_use",
  "id": "t1",
  "name": "Read",
  "input": { "path": "/test" }
}
```

### ToolResultBlock

The result of a tool execution, matched to its request by `tool_use_id`:

```json
{
  "type": "tool_result",
  "tool_use_id": "t1",
  "content": "file data"
}
```

## 4. Role Detection

The parser determines a message's role with:

```typescript
const role = msg.type ?? msg.message?.role;
```

- **User messages** have `type: "user"` at the top level.
- **Assistant messages** have no top-level `type`; instead, they have `message.role: "assistant"`.

### Tool Result Detection

Before treating a `role === "user"` message as a new turn, the parser checks `isToolResult()`:

```typescript
function isToolResult(msg: Message): boolean {
  const content = getContent(msg);
  if (!Array.isArray(content)) return false;
  return content.some(isToolResultBlock);
}
```

If a user-typed message contains any `tool_result` block in its content array, it is classified as a tool result and appended to the current turn's `toolResults` rather than starting a new turn.

## 5. Turn Grouping

`groupTurns()` converts a flat sequence of messages into structured `Turn` objects.

### Turn Definition

```typescript
interface Turn {
  user: Message; // The user message that started this turn
  assistants: Message[]; // All assistant messages in this turn (merged)
  toolResults: Message[]; // All tool result messages in this turn
}
```

### Grouping Algorithm

1. Iterate through messages sequentially.
2. Skip any message with `isMeta: true`.
3. For `role === "user"`:
   - If `isToolResult()` is true → append to `currentToolResults`, continue.
   - Otherwise → finalize the previous turn, start a new turn with this as `currentUser`.
4. For `role === "assistant"`:
   - If `message.id` matches `currentMsgId` → append to `currentParts` (same multi-part message).
   - If `message.id` is new → finalize previous parts, start new `currentParts`.
   - If `message.id` is absent → append to `currentParts`.
5. At the end, finalize the last turn.

A turn is only emitted if it has **both** a user message and at least one assistant message.

### Multi-Part Assistant Messages

When multiple JSONL lines share the same `message.id`, they represent parts of one model response. `mergeAssistantParts()` combines their content arrays into a single message, preserving the first part's metadata.

### consumed Tracking

`groupTurns()` returns `{ turns, consumed }`:

- `consumed` is the index (in the input array) up to the last **complete** turn.
- Incomplete turns (user message without assistant response) are not consumed and will be reprocessed on the next hook invocation.

### Example

**JSONL input (4 lines):**

```json
{ "sessionId": "sess1", "type": "user", "content": "read a file" }
{ "message": { "id": "m1", "role": "assistant", "content": [{ "type": "tool_use", "id": "t1", "name": "Read", "input": { "path": "/" } }] } }
{ "type": "user", "content": [{ "type": "tool_result", "tool_use_id": "t1", "content": "file data" }] }
{ "message": { "id": "m2", "role": "assistant", "content": [{ "type": "text", "text": "done" }] } }
```

**Result:** 1 Turn

```
Turn {
  user: { type: "user", content: "read a file" }
  assistants: [
    { message: { id: "m1", ... } },  // merged: tool_use block
    { message: { id: "m2", ... } },  // text block
  ]
  toolResults: [
    { type: "user", content: [{ type: "tool_result", ... }] }
  ]
}
consumed: 4
```

The tool result message (line 3) is grouped with the turn instead of starting a new turn because `isToolResult()` returns `true`.

## 6. Important Fields

| Field           | Location                                     | Purpose                              |
| --------------- | -------------------------------------------- | ------------------------------------ |
| `sessionId`     | User message (typically the first line)      | Session grouping in Langfuse         |
| `timestamp`     | `msg.timestamp` or `msg.message.timestamp`   | Observation start/end times          |
| `message.id`    | Assistant message                            | Multi-part merge key                 |
| `message.role`  | Assistant message                            | Role detection (`"assistant"`)       |
| `message.model` | Assistant message                            | Generation name and model tracking   |
| `message.usage` | Assistant message                            | Token usage details                  |
| `type`          | User / tool result messages                  | Role detection (`"user"`)            |
| `content`       | Any message (top-level or `message.content`) | Message body (string or block array) |
| `isMeta`        | Any message                                  | Framework-injected message, skipped  |

### Timestamp Resolution

```typescript
function getTimestamp(msg: Message): Date | undefined {
  const ts = msg.timestamp ?? msg.message?.timestamp;
  if (typeof ts === "string") return new Date(ts);
  return undefined;
}
```

Top-level `timestamp` takes precedence over `message.timestamp`. Non-string timestamps are ignored.

### Content Resolution

```typescript
function getContent(msg: Message): ContentBlock[] | string | undefined {
  if (msg.message && typeof msg.message === "object")
    return msg.message.content;
  return msg.content;
}
```

Nested `message.content` takes precedence over top-level `content`.

## 7. Trace Mapping

Each Turn maps to a Langfuse trace with the following hierarchy:

```
Session (sessionId)
└── Trace: "Turn N"
    └── Root Span: "Turn N"            (asType: "agent")
        ├── Generation: "{model}"      (asType: "generation")
        │   └── Tool: "{name}"          (asType: "tool")
        ├── Generation: "{model}"      (asType: "generation")
        │   ├── Tool: "{name}"         (asType: "tool")
        │   └── Tool: "{name}"         (asType: "tool")
        └── Generation: "{model}"      (asType: "generation")
```

### Data Mapping

| Level      | Name      | input                                              | output                                              |
| ---------- | --------- | -------------------------------------------------- | --------------------------------------------------- |
| Trace      | `Turn N`  | `{ role: "user", content: userText }`              | `{ role: "assistant", content: lastAssistantText }` |
| Root Span  | `Turn N`  | `{ role: "user", content: userText }`              | `{ role: "assistant", content: lastAssistantText }` |
| Generation | `{model}` | `{ role: "user", content: userText }` (first only) | `{ role: "assistant", content: assistantText }`     |
| Tool       | `{name}`  | Tool call `input`                                  | Matched `tool_result` content                       |

- Only the **first** Generation in a turn carries `input`. Subsequent Generations omit it.
- The Trace and Root Span both use the **last** assistant message's text as output.

### Timing

| Level      | startTime                          | endTime                                                |
| ---------- | ---------------------------------- | ------------------------------------------------------ |
| Trace      | User message timestamp             | Latest timestamp among all assistants and tool results |
| Root Span  | User message timestamp             | Same as Trace endTime                                  |
| Generation | Assistant message timestamp        | Next Generation's startTime, or `new Date()` if last   |
| Tool       | Parent assistant message timestamp | Matching `tool_result` message timestamp               |

If a message lacks a `timestamp` field, timing for that observation is omitted (SDK defaults apply).

### Usage

Each Generation includes `usageDetails` when `message.usage` is present:

| Key                       | Source                          |
| ------------------------- | ------------------------------- |
| `input`                   | `usage.input_tokens`            |
| `output`                  | `usage.output_tokens`           |
| `total`                   | `input_tokens + output_tokens`  |
| `cache_read_input_tokens` | `usage.cache_read_input_tokens` |

If `usage` is absent, `usageDetails` is omitted entirely.

### Metadata

| Level      | Metadata                                             |
| ---------- | ---------------------------------------------------- |
| Trace      | `{ source: "claude-code", turn_number, session_id }` |
| Generation | `{ tool_count: N }`                                  |
| Tool       | `{ tool_name, tool_id }`                             |

## 8. Incremental Processing

The Stop hook processes transcripts incrementally across invocations:

### State Structure

```typescript
interface SessionState {
  last_line: number; // Line count up to last complete turn (1-based)
  turn_count: number; // Total turns processed so far
  updated: string; // ISO timestamp of last update
}
type State = Record<string, SessionState>; // keyed by sessionId
```

State is persisted at `~/.claude/state/cc-langfuse_state.json`.

### Processing Flow

1. Check transcript first line for a previous session ID (see [Session Transitions](#10-session-transitions)). If found and unprocessed, recover its turns first.
2. Read all lines from the transcript file.
3. Skip lines `0` to `last_line - 1` (already processed).
4. Parse remaining lines as JSON. Lines that fail to parse are skipped (logged).
5. `groupTurns()` groups parsed messages into Turns, returning `consumed` count.
6. Create Langfuse traces for each complete Turn.
7. Update `last_line` to `lineOffsets[consumed - 1]` — the 1-based line number of the last message in the last complete turn.

### lineOffsets

Because some lines may fail JSON parsing, the relationship between message index and line number is tracked via `lineOffsets`:

```typescript
const lineOffsets: number[] = [];
for (let i = lastLine; i < totalLines; i++) {
  try {
    newMessages.push(JSON.parse(lines[i]));
    lineOffsets.push(i + 1); // 1-based line number
  } catch (e) {
    continue; // skip unparseable lines
  }
}
```

`lineOffsets[consumed - 1]` gives the correct 1-based line number even when some lines were skipped.

### Incomplete Turn Handling

- `last_line` only advances to the end of the last **complete** turn.
- An incomplete turn (user message without assistant response) is **not consumed**.
- On the next hook invocation, the incomplete messages are re-read and reprocessed, potentially forming a complete turn if the assistant has since responded.

## 9. Edge Cases

### Multi-Part Assistant (Same ID, Multiple Lines)

Multiple JSONL lines with the same `message.id` are merged into a single assistant message. Their content arrays are concatenated. The first part's metadata (model, timestamp, etc.) is preserved.

### Missing Timestamp

When `timestamp` is absent from a message:

- Trace/Generation/Tool timing is omitted for that observation.
- The SDK falls back to its own creation time.
- `getTimestamp()` returns `undefined` for non-string or missing timestamp values.

### Tool Result Without Matching tool_use

`matchToolResults()` maps each `tool_use` block to its corresponding `tool_result` by matching `id` to `tool_use_id`. If no match is found, the tool call's `output` is set to `null`.

### Incomplete Turn (User Without Assistant)

A user message at the end of the transcript without a subsequent assistant response produces no Turn. `consumed` remains at the previous complete turn boundary. The incomplete messages are reprocessed on the next invocation.

### JSON Parse Failure

Lines that fail `JSON.parse()` are silently skipped (logged at debug level). The `lineOffsets` array ensures line numbering stays correct despite gaps.

### Assistant Without message.id

If an assistant message lacks `message.id`, it is added to `currentParts` without a merge key. It will be merged with any adjacent parts that also lack an ID, or finalized on its own when the next distinct ID appears.

### Meta Messages Interleaved

Meta messages (`isMeta: true`) can appear anywhere in the sequence — as user messages or assistant messages. They are completely ignored by the grouping logic, as if they were not in the transcript at all.

## 10. Session Transitions

When Claude Code exits Plan Mode or undergoes certain session transitions, the session ID changes but the Stop hook for the previous session is **not triggered**. This leaves the previous session's turns unprocessed.

### Detection

The transcript's **first line** reveals whether a session transition occurred:

**Normal session** — first line is `file-history-snapshot` (no `sessionId` field):

```json
{"type": "file-history-snapshot", "messageId": "...", "snapshot": {...}}
```

**Continuation session** (e.g. after Plan Mode) — first line carries the **previous session's** `sessionId`. The current session's messages begin from line 2 or 3 onward:

```json
{"parentUuid": "...", "sessionId": "<previous-session-id>", "type": "user", ...}
```

### Recovery

The hook detects orphaned previous sessions via `findPreviousSession()`:

1. Read the first line of the current transcript.
2. Parse the `sessionId` field.
3. If `sessionId` differs from the current session ID and the previous session's transcript file (at `{directory}/{sessionId}.jsonl`) exists, the previous session is processed first.
4. Recovery failure does not block processing of the current session (independent try/catch).
