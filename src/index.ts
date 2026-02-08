import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { log, debug, HOOK_WARNING_THRESHOLD_SECONDS } from "./logger.js";
import { loadState, saveState, findPreviousSession } from "./filesystem.js";
import { processTranscript } from "./tracer.js";

interface HookInput {
  session_id: string;
  transcript_path: string;
}

async function readHookInput(): Promise<HookInput | null> {
  const chunks: string[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  }
  const raw = chunks.join("").trim();
  if (!raw) return null;

  try {
    const data = JSON.parse(raw);
    if (
      typeof data.session_id === "string" &&
      typeof data.transcript_path === "string"
    ) {
      return {
        session_id: data.session_id,
        transcript_path: data.transcript_path,
      };
    }
    return null;
  } catch {
    return null;
  }
}

interface LangfuseConfig {
  publicKey: string;
  secretKey: string;
  baseUrl?: string;
}

function resolveEnvVars(): LangfuseConfig | null {
  const publicKey =
    process.env.CC_LANGFUSE_PUBLIC_KEY ?? process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey =
    process.env.CC_LANGFUSE_SECRET_KEY ?? process.env.LANGFUSE_SECRET_KEY;
  const baseUrl =
    process.env.CC_LANGFUSE_BASE_URL ?? process.env.LANGFUSE_BASE_URL;

  if (!publicKey || !secretKey) return null;

  return { publicKey, secretKey, baseUrl: baseUrl || undefined };
}

export async function hook(): Promise<void> {
  const scriptStart = Date.now();
  debug("Hook started");

  if ((process.env.TRACE_TO_LANGFUSE ?? "").toLowerCase() !== "true") {
    debug("Tracing disabled (TRACE_TO_LANGFUSE != true)");
    return;
  }

  const config = resolveEnvVars();
  if (!config) {
    log(
      "ERROR",
      "Langfuse API keys not set (CC_LANGFUSE_PUBLIC_KEY / CC_LANGFUSE_SECRET_KEY)",
    );
    return;
  }

  const spanProcessor = new LangfuseSpanProcessor({
    exportMode: "immediate",
    publicKey: config.publicKey,
    secretKey: config.secretKey,
    baseUrl: config.baseUrl,
  });

  const sdk = new NodeSDK({
    spanProcessors: [spanProcessor],
  });

  sdk.start();

  const state = loadState();

  const input = await readHookInput();
  if (!input) {
    debug("No hook input received via stdin");
    await sdk.shutdown();
    return;
  }

  const sessionId = input.session_id;
  const filePath = input.transcript_path;
  debug(`Processing session: ${sessionId}`);

  let currentState = state;

  // Recover orphaned previous session (e.g. Plan Mode exit)
  const previous = findPreviousSession(filePath, sessionId, currentState);
  if (previous) {
    debug(`Recovering previous session: ${previous.sessionId}`);
    try {
      const { updatedState } = await processTranscript(
        previous.sessionId,
        previous.transcriptPath,
        currentState,
      );
      currentState = updatedState;
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      log("ERROR", `Failed to recover previous session: ${message}`);
    }
  }

  try {
    const { turns, updatedState } = await processTranscript(
      sessionId,
      filePath,
      currentState,
    );
    saveState(updatedState);

    await spanProcessor.forceFlush();

    const duration = (Date.now() - scriptStart) / 1000;
    log("INFO", `Processed ${turns} turns in ${duration.toFixed(1)}s`);

    if (duration > HOOK_WARNING_THRESHOLD_SECONDS) {
      log(
        "WARN",
        `Hook took ${duration.toFixed(1)}s (>3min), consider optimizing`,
      );
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    log("ERROR", `Failed to process transcript: ${message}`);
  } finally {
    await sdk.shutdown();
  }
}
