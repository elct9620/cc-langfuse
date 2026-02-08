import { describe, it, expect } from "vitest";
import {
  getContent,
  isToolResult,
  getToolCalls,
  getTextContent,
  mergeAssistantParts,
  groupTurns,
  matchToolResults,
} from "../src/parser.js";
import type { Turn, ToolUseBlock } from "../src/parser.js";

describe("getContent", () => {
  it("extracts content from a message with nested message field", () => {
    const msg = { message: { content: "hello" } };
    expect(getContent(msg)).toBe("hello");
  });

  it("extracts content from a flat message", () => {
    const msg = { content: "hello" };
    expect(getContent(msg)).toBe("hello");
  });

  it("returns undefined for non-object input", () => {
    expect(getContent(null)).toBeUndefined();
    expect(getContent("string")).toBeUndefined();
  });

  it("returns undefined for empty object", () => {
    expect(getContent({})).toBeUndefined();
  });
});

describe("isToolResult", () => {
  it("returns true when content contains tool_result items", () => {
    const msg = {
      content: [{ type: "tool_result", tool_use_id: "123", content: "ok" }],
    };
    expect(isToolResult(msg)).toBe(true);
  });

  it("returns false when content has no tool_result items", () => {
    const msg = { content: [{ type: "text", text: "hello" }] };
    expect(isToolResult(msg)).toBe(false);
  });

  it("returns false when content is a string", () => {
    const msg = { content: "hello" };
    expect(isToolResult(msg)).toBe(false);
  });

  it("returns false for empty content", () => {
    expect(isToolResult({})).toBe(false);
  });
});

describe("getToolCalls", () => {
  it("extracts tool_use blocks from content array", () => {
    const msg = {
      message: {
        content: [
          { type: "text", text: "thinking..." },
          { type: "tool_use", id: "t1", name: "Read", input: { path: "/a" } },
          { type: "tool_use", id: "t2", name: "Write", input: { path: "/b" } },
        ],
      },
    };
    const calls = getToolCalls(msg);
    expect(calls).toHaveLength(2);
    expect(calls[0].name).toBe("Read");
    expect(calls[1].name).toBe("Write");
  });

  it("returns empty array when no tool_use blocks", () => {
    const msg = { message: { content: [{ type: "text", text: "hello" }] } };
    expect(getToolCalls(msg)).toEqual([]);
  });

  it("returns empty array when content is a string", () => {
    const msg = { message: { content: "hello" } };
    expect(getToolCalls(msg)).toEqual([]);
  });
});

describe("getTextContent", () => {
  it("returns string content directly", () => {
    const msg = { content: "hello world" };
    expect(getTextContent(msg)).toBe("hello world");
  });

  it("extracts text from content array", () => {
    const msg = {
      message: {
        content: [
          { type: "text", text: "line 1" },
          { type: "tool_use", id: "t1", name: "Read", input: {} },
          { type: "text", text: "line 2" },
        ],
      },
    };
    expect(getTextContent(msg)).toBe("line 1\nline 2");
  });

  it("handles string items in content array", () => {
    const msg = { content: ["hello", "world"] };
    expect(getTextContent(msg)).toBe("hello\nworld");
  });

  it("returns empty string for missing content", () => {
    expect(getTextContent({})).toBe("");
  });
});

describe("mergeAssistantParts", () => {
  it("merges multiple assistant message parts into one", () => {
    const parts = [
      { message: { id: "m1", content: [{ type: "text", text: "part1" }] } },
      {
        message: {
          id: "m1",
          content: [
            { type: "tool_use", id: "t1", name: "Read", input: {} },
          ],
        },
      },
    ];
    const merged = mergeAssistantParts(parts);
    const content = getContent(merged);
    expect(Array.isArray(content)).toBe(true);
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: "text", text: "part1" });
    expect(content[1]).toEqual({
      type: "tool_use",
      id: "t1",
      name: "Read",
      input: {},
    });
  });

  it("returns empty object for empty parts", () => {
    expect(mergeAssistantParts([])).toEqual({});
  });

  it("wraps non-array content as text", () => {
    const parts = [{ content: "hello" }, { content: "world" }];
    const merged = mergeAssistantParts(parts);
    expect(getContent(merged)).toEqual([
      { type: "text", text: "hello" },
      { type: "text", text: "world" },
    ]);
  });
});

describe("groupTurns", () => {
  it("groups a simple user-assistant exchange", () => {
    const messages = [
      { type: "user", content: "hi" },
      {
        message: { id: "m1", role: "assistant", content: "hello" },
      },
    ];
    const turns = groupTurns(messages);
    expect(turns).toHaveLength(1);
    expect(getTextContent(turns[0].user)).toBe("hi");
    expect(turns[0].assistants).toHaveLength(1);
    expect(turns[0].toolResults).toHaveLength(0);
  });

  it("groups tool results with the current turn", () => {
    const messages = [
      { type: "user", content: "read file" },
      {
        message: {
          id: "m1",
          role: "assistant",
          content: [
            { type: "tool_use", id: "t1", name: "Read", input: { path: "/" } },
          ],
        },
      },
      {
        type: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "file data" },
        ],
      },
      {
        message: {
          id: "m2",
          role: "assistant",
          content: [{ type: "text", text: "done" }],
        },
      },
    ];
    const turns = groupTurns(messages);
    expect(turns).toHaveLength(1);
    expect(turns[0].toolResults).toHaveLength(1);
    expect(turns[0].assistants).toHaveLength(2);
  });

  it("creates a new turn on a new user message", () => {
    const messages = [
      { type: "user", content: "first" },
      { message: { id: "m1", role: "assistant", content: "reply1" } },
      { type: "user", content: "second" },
      { message: { id: "m2", role: "assistant", content: "reply2" } },
    ];
    const turns = groupTurns(messages);
    expect(turns).toHaveLength(2);
    expect(getTextContent(turns[0].user)).toBe("first");
    expect(getTextContent(turns[1].user)).toBe("second");
  });

  it("merges assistant parts with the same message ID", () => {
    const messages = [
      { type: "user", content: "hi" },
      {
        message: {
          id: "m1",
          role: "assistant",
          content: [{ type: "text", text: "part1" }],
        },
      },
      {
        message: {
          id: "m1",
          role: "assistant",
          content: [
            { type: "tool_use", id: "t1", name: "Read", input: {} },
          ],
        },
      },
    ];
    const turns = groupTurns(messages);
    expect(turns).toHaveLength(1);
    expect(turns[0].assistants).toHaveLength(1);
    const merged = turns[0].assistants[0];
    const content = getContent(merged);
    expect(Array.isArray(content)).toBe(true);
    expect(content).toHaveLength(2);
  });

  it("returns empty array for no messages", () => {
    expect(groupTurns([])).toEqual([]);
  });

  it("returns empty array for only user message without assistant", () => {
    const messages = [{ type: "user", content: "hi" }];
    expect(groupTurns(messages)).toEqual([]);
  });
});

describe("matchToolResults", () => {
  it("matches tool results to tool use blocks by id", () => {
    const toolUseBlocks: ToolUseBlock[] = [
      { type: "tool_use", id: "t1", name: "Read", input: { path: "/a" } },
      { type: "tool_use", id: "t2", name: "Write", input: { path: "/b" } },
    ];
    const toolResults = [
      {
        type: "user",
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
    });
    expect(calls[1]).toEqual({
      id: "t2",
      name: "Write",
      input: { path: "/b" },
      output: "ok",
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
});
