import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { log, debug, HOOK_WARNING_THRESHOLD_SECONDS } from "./logger.js";
import { loadState, findLatestTranscript, saveState } from "./filesystem.js";
import { processTranscript } from "./tracer.js";

function resolveEnvVars(): boolean {
  const publicKey =
    process.env.CC_LANGFUSE_PUBLIC_KEY ?? process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey =
    process.env.CC_LANGFUSE_SECRET_KEY ?? process.env.LANGFUSE_SECRET_KEY;
  const baseUrl =
    process.env.CC_LANGFUSE_BASE_URL ?? process.env.LANGFUSE_BASE_URL;

  if (!publicKey || !secretKey) return false;

  process.env.LANGFUSE_PUBLIC_KEY = publicKey;
  process.env.LANGFUSE_SECRET_KEY = secretKey;
  if (baseUrl) process.env.LANGFUSE_BASE_URL = baseUrl;

  return true;
}

export async function hook(): Promise<void> {
  const scriptStart = Date.now();
  debug("Hook started");

  if ((process.env.TRACE_TO_LANGFUSE ?? "").toLowerCase() !== "true") {
    debug("Tracing disabled (TRACE_TO_LANGFUSE != true)");
    return;
  }

  if (!resolveEnvVars()) {
    log(
      "ERROR",
      "Langfuse API keys not set (CC_LANGFUSE_PUBLIC_KEY / CC_LANGFUSE_SECRET_KEY)",
    );
    return;
  }

  const spanProcessor = new LangfuseSpanProcessor({
    exportMode: "immediate",
  });

  const sdk = new NodeSDK({
    spanProcessors: [spanProcessor],
  });

  sdk.start();

  const state = loadState();

  const result = findLatestTranscript();
  if (!result) {
    debug("No transcript file found");
    await sdk.shutdown();
    return;
  }

  const { sessionId, filePath } = result;
  debug(`Processing session: ${sessionId}`);

  try {
    const { turns, updatedState } = await processTranscript(
      sessionId,
      filePath,
      state,
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
  } catch (e) {
    log("ERROR", `Failed to process transcript: ${e}`);
  } finally {
    await sdk.shutdown();
  }
}
