import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { log, debug } from "./logger.js";

const HOOK_WARNING_THRESHOLD_SECONDS = 180;
import { loadState, saveState, findPreviousSession } from "./filesystem.js";
import type { State } from "./filesystem.js";
import {
  processTranscript,
  processTranscriptWithRecovery,
} from "./processor.js";

interface HookInput {
  session_id: string;
  transcript_path: string;
}

export async function readHookInput(
  input: AsyncIterable<string | Buffer> = process.stdin,
): Promise<HookInput | null> {
  const chunks: string[] = [];
  for await (const chunk of input) {
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

function initializeSDK(config: LangfuseConfig): {
  sdk: NodeSDK;
  spanProcessor: LangfuseSpanProcessor;
} {
  const spanProcessor = new LangfuseSpanProcessor({
    publicKey: config.publicKey,
    secretKey: config.secretKey,
    baseUrl: config.baseUrl,
  });

  const sdk = new NodeSDK({
    spanProcessors: [spanProcessor],
  });

  sdk.start();

  return { sdk, spanProcessor };
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

async function processSession(
  input: HookInput,
  state: State,
): Promise<{ turns: number; updatedState: State }> {
  const previous = findPreviousSession(input.transcript_path, input.session_id);

  return previous
    ? processTranscriptWithRecovery(
        input.session_id,
        input.transcript_path,
        previous.sessionId,
        previous.transcriptPath,
        state,
      )
    : processTranscript(input.session_id, input.transcript_path, state);
}

function logDuration(scriptStart: number, turns: number): void {
  const duration = (Date.now() - scriptStart) / 1000;
  log("INFO", `Processed ${turns} turns in ${duration.toFixed(1)}s`);

  if (duration > HOOK_WARNING_THRESHOLD_SECONDS) {
    log(
      "WARN",
      `Hook took ${duration.toFixed(1)}s (>3min), consider optimizing`,
    );
  }
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

  const { sdk, spanProcessor } = initializeSDK(config);

  const state = loadState();

  const input = await readHookInput();
  if (!input) {
    debug("No hook input received via stdin");
    await sdk.shutdown();
    return;
  }

  debug(`Processing session: ${input.session_id}`);

  try {
    const { turns, updatedState } = await processSession(input, state);
    saveState(updatedState);
    logDuration(scriptStart, turns);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    log("ERROR", `Failed to process transcript: ${message}`);
  } finally {
    await spanProcessor.forceFlush();
    await sdk.shutdown();
  }
}
