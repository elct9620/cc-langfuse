import { Langfuse } from "langfuse";
import { log, debug, HOOK_WARNING_THRESHOLD_SECONDS } from "./logger.js";
import { loadState, findLatestTranscript, saveState } from "./filesystem.js";
import { processTranscript } from "./tracer.js";

function getLangfuseConfig(): {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
} | null {
  const publicKey =
    process.env.CC_LANGFUSE_PUBLIC_KEY ?? process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey =
    process.env.CC_LANGFUSE_SECRET_KEY ?? process.env.LANGFUSE_SECRET_KEY;
  const baseUrl =
    process.env.CC_LANGFUSE_HOST ??
    process.env.LANGFUSE_HOST ??
    "https://cloud.langfuse.com";

  if (!publicKey || !secretKey) return null;
  return { publicKey, secretKey, baseUrl };
}

export async function hook(): Promise<void> {
  const scriptStart = Date.now();
  debug("Hook started");

  if ((process.env.TRACE_TO_LANGFUSE ?? "").toLowerCase() !== "true") {
    debug("Tracing disabled (TRACE_TO_LANGFUSE != true)");
    return;
  }

  const config = getLangfuseConfig();
  if (!config) {
    log(
      "ERROR",
      "Langfuse API keys not set (CC_LANGFUSE_PUBLIC_KEY / CC_LANGFUSE_SECRET_KEY)",
    );
    return;
  }

  let langfuse: Langfuse;
  try {
    langfuse = new Langfuse(config);
  } catch (e) {
    log("ERROR", `Failed to initialize Langfuse client: ${e}`);
    return;
  }

  const state = loadState();

  const result = findLatestTranscript();
  if (!result) {
    debug("No transcript file found");
    return;
  }

  const { sessionId, filePath } = result;
  debug(`Processing session: ${sessionId}`);

  try {
    const { turns, updatedState } = processTranscript(
      langfuse,
      sessionId,
      filePath,
      state,
    );
    saveState(updatedState);

    await langfuse.flushAsync();

    const duration = (Date.now() - scriptStart) / 1000;
    log("INFO", `Processed ${turns} turns in ${duration.toFixed(1)}s`);

    if (duration > HOOK_WARNING_THRESHOLD_SECONDS) {
      log("WARN", `Hook took ${duration.toFixed(1)}s (>3min), consider optimizing`);
    }
  } catch (e) {
    log("ERROR", `Failed to process transcript: ${e}`);
  } finally {
    await langfuse.shutdownAsync();
  }
}
