import { describe, it, expect } from "vitest";
import {
  classifyMessage,
  getTimestamp,
  isToolResult,
  getToolCalls,
  getTextContent,
  getUsage,
  getSessionMetadata,
} from "../src/content.js";
import {
  mergeAssistantParts,
  groupTurns,
  matchToolResults,
} from "../src/parser.js";
import type {
  Message,
  UserMessage,
  AssistantMessage,
  ToolUseBlock,
} from "../src/types.js";

describe("classifyMessage", () => {
  it("classifies user message with string content", () => {
    const msg = classifyMessage({ type: "user", content: "hello" });
    expect(msg).toEqual(
      expect.objectContaining({
        role: "user",
        content: [{ type: "text", text: "hello" }],
      }),
    );
  });

  it("classifies user message with array content", () => {
    const msg = classifyMessage({
      type: "user",
      content: [{ type: "text", text: "hello" }],
    });
    expect(msg).toEqual(
      expect.objectContaining({
        role: "user",
        content: [{ type: "text", text: "hello" }],
      }),
    );
  });

  it("classifies assistant message from nested message field", () => {
    const msg = classifyMessage({
      message: { id: "m1", role: "assistant", content: "hello" },
    });
    expect(msg).toEqual(
      expect.objectContaining({
        role: "assistant",
        id: "m1",
        content: [{ type: "text", text: "hello" }],
      }),
    );
  });

  it("classifies assistant message with array content", () => {
    const msg = classifyMessage({
      message: {
        id: "m1",
        role: "assistant",
        model: "claude",
        content: [{ type: "text", text: "hello" }],
      },
    });
    expect(msg).toEqual(
      expect.objectContaining({
        role: "assistant",
        id: "m1",
        model: "claude",
        content: [{ type: "text", text: "hello" }],
      }),
    );
  });

  it("classifies system message", () => {
    const msg = classifyMessage({
      type: "system",
      subtype: "turn_duration",
      durationMs: 1234,
    });
    expect(msg).toEqual(
      expect.objectContaining({
        role: "system",
        subtype: "turn_duration",
        durationMs: 1234,
      }),
    );
  });

  it("returns null for meta messages", () => {
    expect(
      classifyMessage({ type: "user", content: "hello", isMeta: true }),
    ).toBeNull();
  });

  it("returns null for meta assistant messages", () => {
    expect(
      classifyMessage({
        message: { id: "m1", role: "assistant", content: "hello" },
        isMeta: true,
      }),
    ).toBeNull();
  });

  it("returns null for unrecognizable messages", () => {
    expect(classifyMessage({})).toBeNull();
  });

  it("returns empty content for message with no content", () => {
    const msg = classifyMessage({ type: "user" });
    expect(msg).toEqual(
      expect.objectContaining({
        role: "user",
        content: [],
      }),
    );
  });

  it("preserves session metadata on user messages", () => {
    const msg = classifyMessage({
      type: "user",
      content: "hello",
      sessionId: "s1",
      version: "1.0",
      slug: "project",
      cwd: "/home",
      gitBranch: "main",
    });
    expect(msg).toEqual(
      expect.objectContaining({
        role: "user",
        sessionId: "s1",
        version: "1.0",
        slug: "project",
        cwd: "/home",
        gitBranch: "main",
      }),
    );
  });

  it("preserves usage on assistant messages", () => {
    const msg = classifyMessage({
      message: {
        id: "m1",
        role: "assistant",
        content: "hi",
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    });
    expect(msg).toEqual(
      expect.objectContaining({
        role: "assistant",
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    );
  });

  it("uses top-level timestamp for assistant messages", () => {
    const msg = classifyMessage({
      timestamp: "2025-01-15T10:00:00Z",
      message: {
        id: "m1",
        role: "assistant",
        content: "hi",
        timestamp: "2025-01-15T09:00:00Z",
      },
    });
    expect(msg).toEqual(
      expect.objectContaining({
        role: "assistant",
        timestamp: "2025-01-15T10:00:00Z",
      }),
    );
  });

  it("falls back to nested timestamp for assistant messages", () => {
    const msg = classifyMessage({
      message: {
        id: "m1",
        role: "assistant",
        content: "hi",
        timestamp: "2025-01-15T09:00:00Z",
      },
    });
    expect(msg).toEqual(
      expect.objectContaining({
        role: "assistant",
        timestamp: "2025-01-15T09:00:00Z",
      }),
    );
  });

  it("defaults model to 'unknown' when not provided", () => {
    const msg = classifyMessage({
      message: { id: "m1", role: "assistant", content: "hi" },
    });
    expect(msg).toEqual(
      expect.objectContaining({ role: "assistant", model: "unknown" }),
    );
  });
});

describe("isToolResult", () => {
  it("returns true when content contains tool_result items", () => {
    const msg: UserMessage = {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "123", content: "ok" }],
    };
    expect(isToolResult(msg)).toBe(true);
  });

  it("returns false when content has no tool_result items", () => {
    const msg: UserMessage = {
      role: "user",
      content: [{ type: "text", text: "hello" }],
    };
    expect(isToolResult(msg)).toBe(false);
  });

  it("returns false for empty content", () => {
    const msg: UserMessage = { role: "user", content: [] };
    expect(isToolResult(msg)).toBe(false);
  });
});

describe("getToolCalls", () => {
  it("extracts tool_use blocks from content array", () => {
    const msg: AssistantMessage = {
      role: "assistant",
      id: "m1",
      model: "claude",
      content: [
        { type: "text", text: "thinking..." },
        { type: "tool_use", id: "t1", name: "Read", input: { path: "/a" } },
        { type: "tool_use", id: "t2", name: "Write", input: { path: "/b" } },
      ],
    };
    const calls = getToolCalls(msg);
    expect(calls).toHaveLength(2);
    expect(calls[0].name).toBe("Read");
    expect(calls[1].name).toBe("Write");
  });

  it("returns empty array when no tool_use blocks", () => {
    const msg: AssistantMessage = {
      role: "assistant",
      id: "m1",
      model: "claude",
      content: [{ type: "text", text: "hello" }],
    };
    expect(getToolCalls(msg)).toEqual([]);
  });

  it("returns empty array when content is empty", () => {
    const msg: AssistantMessage = {
      role: "assistant",
      id: "m1",
      model: "claude",
      content: [],
    };
    expect(getToolCalls(msg)).toEqual([]);
  });
});

describe("getTextContent", () => {
  it("extracts text from content array", () => {
    const msg: AssistantMessage = {
      role: "assistant",
      id: "m1",
      model: "claude",
      content: [
        { type: "text", text: "line 1" },
        { type: "tool_use", id: "t1", name: "Read", input: {} },
        { type: "text", text: "line 2" },
      ],
    };
    expect(getTextContent(msg)).toBe("line 1\nline 2");
  });

  it("returns empty string for empty content", () => {
    const msg: UserMessage = { role: "user", content: [] };
    expect(getTextContent(msg)).toBe("");
  });

  it("works with user messages", () => {
    const msg: UserMessage = {
      role: "user",
      content: [{ type: "text", text: "hello world" }],
    };
    expect(getTextContent(msg)).toBe("hello world");
  });
});

describe("mergeAssistantParts", () => {
  it("merges multiple assistant message parts into one", () => {
    const parts: AssistantMessage[] = [
      {
        role: "assistant",
        id: "m1",
        model: "claude",
        content: [{ type: "text", text: "part1" }],
      },
      {
        role: "assistant",
        id: "m1",
        model: "claude",
        content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }],
      },
    ];
    const merged = mergeAssistantParts(parts);
    expect(merged.content).toHaveLength(2);
    expect(merged.content[0]).toEqual({ type: "text", text: "part1" });
    expect(merged.content[1]).toEqual({
      type: "tool_use",
      id: "t1",
      name: "Read",
      input: {},
    });
  });

  it("uses usage from the last part", () => {
    const parts: AssistantMessage[] = [
      {
        role: "assistant",
        id: "m1",
        model: "claude",
        content: [{ type: "text", text: "part1" }],
        usage: { input_tokens: 100, output_tokens: 10 },
      },
      {
        role: "assistant",
        id: "m1",
        model: "claude",
        content: [{ type: "text", text: "part2" }],
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    ];
    const merged = mergeAssistantParts(parts);
    expect(merged.usage).toEqual({
      input_tokens: 100,
      output_tokens: 50,
    });
  });

  it("falls back to first part usage when last part has none", () => {
    const parts: AssistantMessage[] = [
      {
        role: "assistant",
        id: "m1",
        model: "claude",
        content: [{ type: "text", text: "part1" }],
        usage: { input_tokens: 100, output_tokens: 10 },
      },
      {
        role: "assistant",
        id: "m1",
        model: "claude",
        content: [{ type: "text", text: "part2" }],
      },
    ];
    const merged = mergeAssistantParts(parts);
    expect(merged.usage).toEqual({
      input_tokens: 100,
      output_tokens: 10,
    });
  });
});

describe("groupTurns", () => {
  it("groups a simple user-assistant exchange", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        id: "m1",
        model: "claude",
        content: [{ type: "text", text: "hello" }],
      },
    ];
    const { turns } = groupTurns(messages);
    expect(turns).toHaveLength(1);
    expect(getTextContent(turns[0].user)).toBe("hi");
    expect(turns[0].assistants).toHaveLength(1);
    expect(turns[0].toolResults).toHaveLength(0);
  });

  it("groups tool results with the current turn", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "read file" }] },
      {
        role: "assistant",
        id: "m1",
        model: "claude",
        content: [
          { type: "tool_use", id: "t1", name: "Read", input: { path: "/" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "file data" },
        ],
      },
      {
        role: "assistant",
        id: "m2",
        model: "claude",
        content: [{ type: "text", text: "done" }],
      },
    ];
    const { turns } = groupTurns(messages);
    expect(turns).toHaveLength(1);
    expect(turns[0].toolResults).toHaveLength(1);
    expect(turns[0].assistants).toHaveLength(2);
  });

  it("creates a new turn on a new user message", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "first" }] },
      {
        role: "assistant",
        id: "m1",
        model: "claude",
        content: [{ type: "text", text: "reply1" }],
      },
      { role: "user", content: [{ type: "text", text: "second" }] },
      {
        role: "assistant",
        id: "m2",
        model: "claude",
        content: [{ type: "text", text: "reply2" }],
      },
    ];
    const { turns } = groupTurns(messages);
    expect(turns).toHaveLength(2);
    expect(getTextContent(turns[0].user)).toBe("first");
    expect(getTextContent(turns[1].user)).toBe("second");
  });

  it("merges assistant parts with the same message ID", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        id: "m1",
        model: "claude",
        content: [{ type: "text", text: "part1" }],
      },
      {
        role: "assistant",
        id: "m1",
        model: "claude",
        content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }],
      },
    ];
    const { turns } = groupTurns(messages);
    expect(turns).toHaveLength(1);
    expect(turns[0].assistants).toHaveLength(1);
    const merged = turns[0].assistants[0];
    expect(merged.content).toHaveLength(2);
  });

  it("returns empty result for no messages", () => {
    const { turns, consumed } = groupTurns([]);
    expect(turns).toEqual([]);
    expect(consumed).toBe(0);
  });

  it("returns no turns for only user message without assistant", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ];
    const { turns, consumed } = groupTurns(messages);
    expect(turns).toEqual([]);
    expect(consumed).toBe(0);
  });

  it("reports consumed count for complete turns only", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "first" }] },
      {
        role: "assistant",
        id: "m1",
        model: "claude",
        content: [{ type: "text", text: "reply1" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "second (incomplete)" }],
      },
    ];
    const { turns, consumed } = groupTurns(messages);
    expect(turns).toHaveLength(1);
    expect(consumed).toBe(2);
  });

  it("consumes all messages when all turns complete", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "first" }] },
      {
        role: "assistant",
        id: "m1",
        model: "claude",
        content: [{ type: "text", text: "reply1" }],
      },
      { role: "user", content: [{ type: "text", text: "second" }] },
      {
        role: "assistant",
        id: "m2",
        model: "claude",
        content: [{ type: "text", text: "reply2" }],
      },
    ];
    const { turns, consumed } = groupTurns(messages);
    expect(turns).toHaveLength(2);
    expect(consumed).toBe(4);
  });

  it("returns consumed 0 when no complete turns", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ];
    const { consumed } = groupTurns(messages);
    expect(consumed).toBe(0);
  });

  it("captures durationMs from system turn_duration message", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      {
        role: "assistant",
        id: "m1",
        model: "claude",
        content: [{ type: "text", text: "hi" }],
      },
      { role: "system", subtype: "turn_duration", durationMs: 1234 },
    ];
    const { turns } = groupTurns(messages);
    expect(turns).toHaveLength(1);
    expect(turns[0].durationMs).toBe(1234);
  });

  it("attaches durationMs to correct turn when multiple turns exist", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "first" }] },
      {
        role: "assistant",
        id: "m1",
        model: "claude",
        content: [{ type: "text", text: "reply1" }],
      },
      { role: "system", subtype: "turn_duration", durationMs: 500 },
      { role: "user", content: [{ type: "text", text: "second" }] },
      {
        role: "assistant",
        id: "m2",
        model: "claude",
        content: [{ type: "text", text: "reply2" }],
      },
      { role: "system", subtype: "turn_duration", durationMs: 800 },
    ];
    const { turns } = groupTurns(messages);
    expect(turns).toHaveLength(2);
    expect(turns[0].durationMs).toBe(500);
    expect(turns[1].durationMs).toBe(800);
  });

  it("leaves durationMs undefined when no turn_duration message", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      {
        role: "assistant",
        id: "m1",
        model: "claude",
        content: [{ type: "text", text: "hi" }],
      },
    ];
    const { turns } = groupTurns(messages);
    expect(turns).toHaveLength(1);
    expect(turns[0].durationMs).toBeUndefined();
  });

  it("consumes system turn_duration messages in consumed count", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      {
        role: "assistant",
        id: "m1",
        model: "claude",
        content: [{ type: "text", text: "hi" }],
      },
      { role: "system", subtype: "turn_duration", durationMs: 1234 },
      { role: "user", content: [{ type: "text", text: "incomplete" }] },
    ];
    const { turns, consumed } = groupTurns(messages);
    expect(turns).toHaveLength(1);
    expect(consumed).toBe(3);
  });

  it("does not produce turns when messages start with tool_result", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "file data" },
        ],
      },
      {
        role: "assistant",
        id: "m1",
        model: "claude",
        content: [{ type: "text", text: "continuing" }],
      },
    ];
    const { turns, consumed } = groupTurns(messages);
    expect(turns).toEqual([]);
    expect(consumed).toBe(0);
  });
});

describe("getTimestamp", () => {
  it("should return Date from timestamp field", () => {
    const msg: UserMessage = {
      role: "user",
      content: [],
      timestamp: "2025-01-15T10:30:00Z",
    };
    const result = getTimestamp(msg);
    expect(result).toBeInstanceOf(Date);
    expect(result!.toISOString()).toBe("2025-01-15T10:30:00.000Z");
  });

  it("should return Date from assistant message timestamp", () => {
    const msg: AssistantMessage = {
      role: "assistant",
      id: "m1",
      model: "claude",
      content: [],
      timestamp: "2025-01-15T10:31:00Z",
    };
    const result = getTimestamp(msg);
    expect(result).toBeInstanceOf(Date);
    expect(result!.toISOString()).toBe("2025-01-15T10:31:00.000Z");
  });

  it("should return undefined when no timestamp field exists", () => {
    const msg: UserMessage = {
      role: "user",
      content: [{ type: "text", text: "hello" }],
    };
    expect(getTimestamp(msg)).toBeUndefined();
  });
});

describe("getUsage", () => {
  it("extracts cache_creation_input_tokens", () => {
    const msg: AssistantMessage = {
      role: "assistant",
      id: "m1",
      model: "claude",
      content: [{ type: "text", text: "hello" }],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 20,
      },
    };
    const usage = getUsage(msg);
    expect(usage).toEqual({
      input: 100,
      output: 50,
      total: 150,
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: 20,
    });
  });

  it("omits cache_creation_input_tokens when not present", () => {
    const msg: AssistantMessage = {
      role: "assistant",
      id: "m1",
      model: "claude",
      content: [{ type: "text", text: "hello" }],
      usage: { input_tokens: 100, output_tokens: 50 },
    };
    const usage = getUsage(msg);
    expect(usage).toEqual({
      input: 100,
      output: 50,
      total: 150,
    });
  });
});

describe("getSessionMetadata", () => {
  it("extracts metadata fields from a user message", () => {
    const msg: UserMessage = {
      role: "user",
      content: [{ type: "text", text: "hello" }],
      version: "1.0.32",
      slug: "my-project",
      cwd: "/home/user/project",
      gitBranch: "main",
    };
    const metadata = getSessionMetadata(msg);
    expect(metadata).toEqual({
      version: "1.0.32",
      slug: "my-project",
      cwd: "/home/user/project",
      gitBranch: "main",
    });
  });

  it("returns partial metadata when some fields are missing", () => {
    const msg: UserMessage = {
      role: "user",
      content: [{ type: "text", text: "hello" }],
      version: "1.0.32",
    };
    const metadata = getSessionMetadata(msg);
    expect(metadata).toEqual({ version: "1.0.32" });
  });

  it("returns undefined when no metadata fields are present", () => {
    const msg: UserMessage = {
      role: "user",
      content: [{ type: "text", text: "hello" }],
    };
    expect(getSessionMetadata(msg)).toBeUndefined();
  });
});

describe("matchToolResults", () => {
  it("matches tool results to tool use blocks by id", () => {
    const toolUseBlocks: ToolUseBlock[] = [
      { type: "tool_use", id: "t1", name: "Read", input: { path: "/a" } },
      { type: "tool_use", id: "t2", name: "Write", input: { path: "/b" } },
    ];
    const toolResults: UserMessage[] = [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "file data" },
          { type: "tool_result", tool_use_id: "t2", content: "ok" },
        ],
      },
    ];

    const calls = matchToolResults(toolUseBlocks, toolResults);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      id: "t1",
      name: "Read",
      input: { path: "/a" },
      output: "file data",
      timestamp: undefined,
      is_error: false,
    });
    expect(calls[1]).toEqual({
      id: "t2",
      name: "Write",
      input: { path: "/b" },
      output: "ok",
      timestamp: undefined,
      is_error: false,
    });
  });

  it("returns null output when tool result is missing", () => {
    const toolUseBlocks: ToolUseBlock[] = [
      { type: "tool_use", id: "t1", name: "Read", input: {} },
    ];

    const calls = matchToolResults(toolUseBlocks, []);
    expect(calls).toHaveLength(1);
    expect(calls[0].output).toBeNull();
  });

  it("should include timestamp from tool result message", () => {
    const toolUseBlocks: ToolUseBlock[] = [
      { type: "tool_use", id: "t1", name: "Read", input: { path: "/a" } },
    ];
    const toolResults: UserMessage[] = [
      {
        role: "user",
        timestamp: "2025-01-15T10:32:00Z",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "file data" },
        ],
      },
    ];

    const calls = matchToolResults(toolUseBlocks, toolResults);
    expect(calls[0].timestamp).toBeInstanceOf(Date);
    expect(calls[0].timestamp!.toISOString()).toBe("2025-01-15T10:32:00.000Z");
  });

  it("should return undefined timestamp when tool result message has no timestamp", () => {
    const toolUseBlocks: ToolUseBlock[] = [
      { type: "tool_use", id: "t1", name: "Read", input: {} },
    ];
    const toolResults: UserMessage[] = [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
      },
    ];

    const calls = matchToolResults(toolUseBlocks, toolResults);
    expect(calls[0].timestamp).toBeUndefined();
  });

  it("should set is_error to true when tool result has is_error true", () => {
    const toolUseBlocks: ToolUseBlock[] = [
      {
        type: "tool_use",
        id: "t1",
        name: "Bash",
        input: { command: "exit 1" },
      },
    ];
    const toolResults: UserMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: "command failed",
            is_error: true,
          },
        ],
      },
    ];

    const calls = matchToolResults(toolUseBlocks, toolResults);
    expect(calls[0].is_error).toBe(true);
  });

  it("should set is_error to false when tool result has is_error false", () => {
    const toolUseBlocks: ToolUseBlock[] = [
      { type: "tool_use", id: "t1", name: "Read", input: { path: "/a" } },
    ];
    const toolResults: UserMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: "file data",
            is_error: false,
          },
        ],
      },
    ];

    const calls = matchToolResults(toolUseBlocks, toolResults);
    expect(calls[0].is_error).toBe(false);
  });

  it("should default is_error to false when tool result is missing", () => {
    const toolUseBlocks: ToolUseBlock[] = [
      { type: "tool_use", id: "t1", name: "Read", input: {} },
    ];

    const calls = matchToolResults(toolUseBlocks, []);
    expect(calls[0].is_error).toBe(false);
  });
});
