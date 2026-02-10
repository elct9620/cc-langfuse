import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";

import {
  mockStartObservation,
  mockForceFlush,
  mockSdkStart,
  mockSdkShutdown,
  langfuseTracingMock,
  langfuseOtelMock,
  openTelemetryMock,
} from "./helpers/langfuse-mock.js";
import {
  setupTranscript,
  setupTranscriptAt,
  mockStdin,
} from "./helpers/transcript.js";

// Mock homedir before importing modules that use it
const testDir = join(tmpdir(), `cc-langfuse-test-${Date.now()}`);

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return { ...original, homedir: () => testDir };
});

vi.mock("@langfuse/tracing", () => langfuseTracingMock());
vi.mock("@langfuse/otel", () => langfuseOtelMock());
vi.mock("@opentelemetry/sdk-node", () => openTelemetryMock());

// Isolate tests from host environment variables
const LANGFUSE_ENV_KEYS = [
  "TRACE_TO_LANGFUSE",
  "CC_LANGFUSE_PUBLIC_KEY",
  "CC_LANGFUSE_SECRET_KEY",
  "CC_LANGFUSE_BASE_URL",
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "LANGFUSE_BASE_URL",
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  mkdirSync(join(testDir, ".claude", "state"), { recursive: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

// Import after mocks
const { hook, readHookInput } = await import("../src/index.js");
const { NodeSDK } = await import("@opentelemetry/sdk-node");
const { LangfuseSpanProcessor } = await import("@langfuse/otel");

describe("hook", () => {
  beforeEach(() => {
    for (const key of LANGFUSE_ENV_KEYS) {
      vi.stubEnv(key, "");
    }
  });

  it("exits silently when TRACE_TO_LANGFUSE is not set", async () => {
    await hook();
    expect(NodeSDK).not.toHaveBeenCalled();
  });

  it("exits silently when API keys are missing", async () => {
    vi.stubEnv("TRACE_TO_LANGFUSE", "true");
    await hook();
    expect(NodeSDK).not.toHaveBeenCalled();
  });

  it("passes credentials to LangfuseSpanProcessor", async () => {
    vi.stubEnv("TRACE_TO_LANGFUSE", "true");
    vi.stubEnv("CC_LANGFUSE_PUBLIC_KEY", "pk-test");
    vi.stubEnv("CC_LANGFUSE_SECRET_KEY", "sk-test");
    vi.stubEnv("CC_LANGFUSE_BASE_URL", "https://langfuse.example.com");

    const filePath = setupTranscript(testDir, [
      { sessionId: "sess1", type: "user", content: "hello" },
      {
        message: {
          id: "m1",
          role: "assistant",
          model: "claude-sonnet-4-5-20250929",
          content: [{ type: "text", text: "hi" }],
        },
      },
    ]);
    mockStdin({ session_id: "sess1", transcript_path: filePath });

    await hook();

    expect(LangfuseSpanProcessor).toHaveBeenCalledWith({
      publicKey: "pk-test",
      secretKey: "sk-test",
      baseUrl: "https://langfuse.example.com",
    });
  });

  it("omits baseUrl when not set", async () => {
    vi.stubEnv("TRACE_TO_LANGFUSE", "true");
    vi.stubEnv("CC_LANGFUSE_PUBLIC_KEY", "pk-test");
    vi.stubEnv("CC_LANGFUSE_SECRET_KEY", "sk-test");

    const filePath = setupTranscript(testDir, [
      { sessionId: "sess1", type: "user", content: "hello" },
      {
        message: {
          id: "m1",
          role: "assistant",
          model: "claude-sonnet-4-5-20250929",
          content: [{ type: "text", text: "hi" }],
        },
      },
    ]);
    mockStdin({ session_id: "sess1", transcript_path: filePath });

    await hook();

    expect(LangfuseSpanProcessor).toHaveBeenCalledWith({
      publicKey: "pk-test",
      secretKey: "sk-test",
      baseUrl: undefined,
    });
  });

  it("calls forceFlush even when processing throws an error", async () => {
    vi.stubEnv("TRACE_TO_LANGFUSE", "true");
    vi.stubEnv("CC_LANGFUSE_PUBLIC_KEY", "pk-test");
    vi.stubEnv("CC_LANGFUSE_SECRET_KEY", "sk-test");

    // Provide a transcript path that doesn't exist to trigger an error
    mockStdin({
      session_id: "sess1",
      transcript_path: "/nonexistent/path.jsonl",
    });

    await hook();

    expect(mockForceFlush).toHaveBeenCalled();
    expect(mockSdkShutdown).toHaveBeenCalled();
  });

  it("initializes NodeSDK and processes transcript", async () => {
    vi.stubEnv("TRACE_TO_LANGFUSE", "true");
    vi.stubEnv("CC_LANGFUSE_PUBLIC_KEY", "pk-test");
    vi.stubEnv("CC_LANGFUSE_SECRET_KEY", "sk-test");

    const filePath = setupTranscript(testDir, [
      { sessionId: "sess1", type: "user", content: "hello" },
      {
        message: {
          id: "m1",
          role: "assistant",
          model: "claude-sonnet-4-5-20250929",
          content: [{ type: "text", text: "hi there" }],
        },
      },
    ]);
    mockStdin({ session_id: "sess1", transcript_path: filePath });

    await hook();

    expect(NodeSDK).toHaveBeenCalled();
    expect(mockSdkStart).toHaveBeenCalled();
    expect(mockStartObservation).toHaveBeenCalledWith("Turn 1", {}, undefined);
    expect(mockStartObservation).toHaveBeenCalledWith(
      "claude-sonnet-4-5-20250929",
      expect.objectContaining({ model: "claude-sonnet-4-5-20250929" }),
      expect.objectContaining({ asType: "generation" }),
    );
    expect(mockForceFlush).toHaveBeenCalled();
    expect(mockSdkShutdown).toHaveBeenCalled();
  });
});

describe("orphan session recovery", () => {
  beforeEach(() => {
    for (const key of LANGFUSE_ENV_KEYS) {
      vi.stubEnv(key, "");
    }
  });

  it("recovers previous session before processing current session", async () => {
    vi.stubEnv("TRACE_TO_LANGFUSE", "true");
    vi.stubEnv("CC_LANGFUSE_PUBLIC_KEY", "pk-test");
    vi.stubEnv("CC_LANGFUSE_SECRET_KEY", "sk-test");

    // Previous session transcript
    setupTranscriptAt(testDir, "prev-session.jsonl", [
      { sessionId: "prev-session", type: "user", content: "prev hello" },
      {
        message: {
          id: "m1",
          role: "assistant",
          model: "claude",
          content: [{ type: "text", text: "prev hi" }],
        },
      },
    ]);

    // Current transcript starts with prev session's message
    const currentPath = setupTranscriptAt(testDir, "current-session.jsonl", [
      { sessionId: "prev-session", type: "user", content: "leftover" },
      { sessionId: "current-session", type: "user", content: "current hello" },
      {
        message: {
          id: "m2",
          role: "assistant",
          model: "claude",
          content: [{ type: "text", text: "current hi" }],
        },
      },
    ]);

    mockStdin({
      session_id: "current-session",
      transcript_path: currentPath,
    });

    await hook();

    // Should have processed both sessions (2 turns total: 1 prev + 1 current)
    // Each turn creates: 1 outer span + 1 agent + 1 generation = 3 calls
    const spanCalls = mockStartObservation.mock.calls.filter(
      (call) => !call[2]?.asType,
    );
    expect(spanCalls).toHaveLength(2);
    expect(mockStartObservation).toHaveBeenCalledWith("Turn 1", {}, undefined);
  });

  it("continues processing current session when previous session recovery fails", async () => {
    vi.stubEnv("TRACE_TO_LANGFUSE", "true");
    vi.stubEnv("CC_LANGFUSE_PUBLIC_KEY", "pk-test");
    vi.stubEnv("CC_LANGFUSE_SECRET_KEY", "sk-test");

    // Previous session transcript with invalid content (will cause processTranscript to have 0 turns)
    setupTranscriptAt(testDir, "prev-session.jsonl", [
      { sessionId: "prev-session", type: "user", content: "orphaned" },
      // No assistant response — incomplete turn, 0 turns processed
    ]);

    // Current transcript
    const currentPath = setupTranscriptAt(testDir, "current-session.jsonl", [
      { sessionId: "prev-session", type: "user", content: "leftover" },
      { sessionId: "current-session", type: "user", content: "hello" },
      {
        message: {
          id: "m1",
          role: "assistant",
          model: "claude",
          content: [{ type: "text", text: "hi" }],
        },
      },
    ]);

    mockStdin({
      session_id: "current-session",
      transcript_path: currentPath,
    });

    await hook();

    // Current session should still be processed (1 turn)
    expect(mockStartObservation).toHaveBeenCalledWith("Turn 1", {}, undefined);
    expect(mockSdkShutdown).toHaveBeenCalled();
  });
});

describe("readHookInput", () => {
  it("parses valid hook input from an async iterable", async () => {
    const input = Readable.from([
      JSON.stringify({
        session_id: "sess1",
        transcript_path: "/path/to/file.jsonl",
      }),
    ]);

    const result = await readHookInput(input);

    expect(result).toEqual({
      session_id: "sess1",
      transcript_path: "/path/to/file.jsonl",
    });
  });

  it("returns null for empty input", async () => {
    const input = Readable.from([""]);

    const result = await readHookInput(input);

    expect(result).toBeNull();
  });

  it("returns null for invalid JSON", async () => {
    const input = Readable.from(["not valid json"]);

    const result = await readHookInput(input);

    expect(result).toBeNull();
  });

  it("returns null when required fields are missing", async () => {
    const input = Readable.from([JSON.stringify({ session_id: "sess1" })]);

    const result = await readHookInput(input);

    expect(result).toBeNull();
  });
});
