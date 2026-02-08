import { Langfuse } from "langfuse";
import { log, debug } from "./logger.js";
import { loadState, findLatestTranscript, processTranscript } from "./tracer.js";

export async function hook(): Promise<void> {
  const scriptStart = Date.now();
  debug("Hook started");

  // Check if tracing is enabled
  if ((process.env.TRACE_TO_LANGFUSE ?? "").toLowerCase() !== "true") {
    debug("Tracing disabled (TRACE_TO_LANGFUSE != true)");
    return;
  }

  // Check for required environment variables
  const publicKey =
    process.env.CC_LANGFUSE_PUBLIC_KEY ?? process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey =
    process.env.CC_LANGFUSE_SECRET_KEY ?? process.env.LANGFUSE_SECRET_KEY;
  const host =
    process.env.CC_LANGFUSE_HOST ??
    process.env.LANGFUSE_HOST ??
    "https://cloud.langfuse.com";

  if (!publicKey || !secretKey) {
    log(
      "ERROR",
      "Langfuse API keys not set (CC_LANGFUSE_PUBLIC_KEY / CC_LANGFUSE_SECRET_KEY)",
    );
    return;
  }

  // Initialize Langfuse client
  let langfuse: Langfuse;
  try {
    langfuse = new Langfuse({ publicKey, secretKey, baseUrl: host });
  } catch (e) {
    log("ERROR", `Failed to initialize Langfuse client: ${e}`);
    return;
  }

  // Load state
  const state = loadState();

  // Find the most recently modified transcript
  const result = findLatestTranscript();
  if (!result) {
    debug("No transcript file found");
    return;
  }

  const { sessionId, filePath } = result;
  debug(`Processing session: ${sessionId}`);

  try {
    const turns = processTranscript(langfuse, sessionId, filePath, state);

    await langfuse.flushAsync();

    const duration = (Date.now() - scriptStart) / 1000;
    log("INFO", `Processed ${turns} turns in ${duration.toFixed(1)}s`);

    if (duration > 180) {
      log("WARN", `Hook took ${duration.toFixed(1)}s (>3min), consider optimizing`);
    }
  } catch (e) {
    log("ERROR", `Failed to process transcript: ${e}`);
  } finally {
    await langfuse.shutdownAsync();
  }
}
