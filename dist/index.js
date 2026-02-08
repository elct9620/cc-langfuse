import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { propagateAttributes, startActiveObservation, startObservation, updateActiveTrace } from "@langfuse/tracing";

//#region src/logger.ts
const STATE_FILE = join(homedir(), ".claude", "state", "cc-langfuse_state.json");
const LOG_FILE = join(homedir(), ".claude", "state", "cc-langfuse_hook.log");
const DEBUG = (process.env.CC_LANGFUSE_DEBUG ?? "").toLowerCase() === "true";
const HOOK_WARNING_THRESHOLD_SECONDS = 180;
function log(level, message) {
	mkdirSync(dirname(LOG_FILE), { recursive: true });
	appendFileSync(LOG_FILE, `${(/* @__PURE__ */ new Date()).toISOString().replace("T", " ").slice(0, 19)} [${level}] ${message}\n`);
}
function debug(message) {
	if (DEBUG) log("DEBUG", message);
}

//#endregion
//#region src/filesystem.ts
/**
* Loads persisted session state from disk.
*
* Returns empty state on any failure (missing file, corrupt JSON, permission
* errors) — this is intentional graceful degradation so the hook can always
* proceed by reprocessing from scratch rather than crashing.
*/
function loadState() {
	try {
		return JSON.parse(readFileSync(STATE_FILE, "utf8"));
	} catch (e) {
		debug(`Failed to load state: ${e}`);
		return {};
	}
}
function saveState(state) {
	mkdirSync(dirname(STATE_FILE), { recursive: true });
	writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
function findPreviousSession(transcriptPath, currentSessionId, state) {
	try {
		const content = readFileSync(transcriptPath, "utf8");
		const firstNewline = content.indexOf("\n");
		const firstLine = firstNewline === -1 ? content : content.slice(0, firstNewline);
		if (!firstLine) return null;
		const sessionId = JSON.parse(firstLine).sessionId;
		if (typeof sessionId !== "string") return null;
		if (sessionId === currentSessionId) return null;
		if (state[sessionId]) return null;
		const previousPath = join(dirname(transcriptPath), `${sessionId}.jsonl`);
		if (!existsSync(previousPath)) return null;
		return {
			sessionId,
			transcriptPath: previousPath
		};
	} catch {
		debug("Failed to detect previous session from transcript first line");
		return null;
	}
}
function parseNewMessages(transcriptFile, lastLine) {
	const lines = readFileSync(transcriptFile, "utf8").trim().split("\n");
	const totalLines = lines.length;
	if (lastLine >= totalLines) {
		debug(`No new lines to process (last: ${lastLine}, total: ${totalLines})`);
		return null;
	}
	const messages = [];
	const lineOffsets = [];
	for (let i = lastLine; i < totalLines; i++) try {
		messages.push(JSON.parse(lines[i]));
		lineOffsets.push(i + 1);
	} catch (e) {
		debug(`Skipping line ${i}: ${e}`);
		continue;
	}
	return messages.length > 0 ? {
		messages,
		lineOffsets
	} : null;
}
function countTotalLines(filePath) {
	try {
		return readFileSync(filePath, "utf8").trim().split("\n").length;
	} catch {
		return 0;
	}
}
function mergeTranscriptMessages(prevFile, prevLastLine, currentFile, currentLastLine) {
	const prev = parseNewMessages(prevFile, prevLastLine);
	const current = parseNewMessages(currentFile, currentLastLine);
	const prevMessages = prev?.messages ?? [];
	const currentMessages = current?.messages ?? [];
	if (prevMessages.length === 0 && currentMessages.length === 0) return null;
	return {
		messages: [...prevMessages, ...currentMessages],
		prevCount: prevMessages.length,
		currentLineOffsets: current?.lineOffsets ?? []
	};
}
function computeUpdatedState(state, sessionId, turnCount, newTurns, consumed, lineOffsets, lastLine) {
	const newLastLine = consumed > 0 ? lineOffsets[consumed - 1] : lastLine;
	return {
		...state,
		[sessionId]: {
			last_line: newLastLine,
			turn_count: turnCount + newTurns,
			updated: (/* @__PURE__ */ new Date()).toISOString()
		}
	};
}

//#endregion
//#region src/content.ts
function isBlockOfType(item, type) {
	return typeof item === "object" && item !== null && item.type === type;
}
function isTextBlock(item) {
	return isBlockOfType(item, "text");
}
function isToolUseBlock(item) {
	return isBlockOfType(item, "tool_use");
}
function isToolResultBlock(item) {
	return isBlockOfType(item, "tool_result");
}
function getSessionId(msg) {
	const sid = msg.sessionId;
	return typeof sid === "string" ? sid : void 0;
}
function getTimestamp(msg) {
	const ts = msg.timestamp ?? msg.message?.timestamp;
	if (typeof ts === "string") return new Date(ts);
}
function getContent(msg) {
	if (msg === null || typeof msg !== "object") return void 0;
	const record = msg;
	if ("message" in record && typeof record.message === "object") return record.message?.content;
	return record.content;
}
function isToolResult(msg) {
	const content = getContent(msg);
	if (!Array.isArray(content)) return false;
	return content.some(isToolResultBlock);
}
function getToolCalls(msg) {
	const content = getContent(msg);
	if (!Array.isArray(content)) return [];
	return content.filter(isToolUseBlock);
}
function getTextContent(msg) {
	const content = getContent(msg);
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const item of content) if (isTextBlock(item)) parts.push(item.text);
	else if (typeof item === "string") parts.push(item);
	return parts.join("\n");
}
function getUsage(msg) {
	const usage = msg.message?.usage;
	if (!usage) return void 0;
	const details = {};
	if (typeof usage.input_tokens === "number") details.input = usage.input_tokens;
	if (typeof usage.output_tokens === "number") details.output = usage.output_tokens;
	if (typeof usage.input_tokens === "number" && typeof usage.output_tokens === "number") details.total = usage.input_tokens + usage.output_tokens;
	if (typeof usage.cache_read_input_tokens === "number") details.cache_read_input_tokens = usage.cache_read_input_tokens;
	return Object.keys(details).length > 0 ? details : void 0;
}

//#endregion
//#region src/parser.ts
function mergeAssistantParts(parts) {
	if (parts.length === 0) return {};
	const mergedContent = [];
	for (const part of parts) {
		const content = getContent(part);
		if (Array.isArray(content)) mergedContent.push(...content);
		else if (content !== void 0 && content !== null) mergedContent.push({
			type: "text",
			text: String(content)
		});
	}
	const result = { ...parts[0] };
	if ("message" in result) result.message = {
		...result.message,
		content: mergedContent
	};
	else result.content = mergedContent;
	return result;
}
var AssistantPartAccumulator = class {
	parts = [];
	msgId = null;
	add(msg) {
		const id = msg.message?.id;
		if (!id || id === this.msgId) {
			this.parts.push(msg);
			if (id) this.msgId = id;
			return;
		}
		const flushed = this.flush();
		this.msgId = id;
		this.parts = [msg];
		return flushed;
	}
	flush() {
		if (this.msgId === null || this.parts.length === 0) return void 0;
		const merged = mergeAssistantParts(this.parts);
		this.parts = [];
		this.msgId = null;
		return merged;
	}
};
var TurnBuilder = class {
	turns = [];
	currentUser = null;
	currentAssistants = [];
	accumulator = new AssistantPartAccumulator();
	currentToolResults = [];
	lastCompleteTurnEnd = 0;
	build(messages) {
		let idx = 0;
		for (const msg of messages) {
			if (msg.isMeta === true) {
				idx++;
				continue;
			}
			const role = msg.type ?? msg.message?.role ?? void 0;
			if (role === "user") this.handleUser(msg, idx);
			else if (role === "assistant") this.handleAssistant(msg);
			idx++;
		}
		this.finalizeTurn(messages.length);
		return {
			turns: this.turns,
			consumed: this.lastCompleteTurnEnd
		};
	}
	handleUser(msg, idx) {
		if (isToolResult(msg)) {
			this.currentToolResults.push(msg);
			return;
		}
		this.finalizeTurn(idx);
		this.currentUser = msg;
		this.currentAssistants = [];
		this.accumulator = new AssistantPartAccumulator();
		this.currentToolResults = [];
	}
	handleAssistant(msg) {
		const merged = this.accumulator.add(msg);
		if (merged) this.currentAssistants.push(merged);
	}
	finalizeTurn(nextIdx) {
		const remaining = this.accumulator.flush();
		if (remaining) this.currentAssistants.push(remaining);
		if (this.currentUser !== null && this.currentAssistants.length > 0) {
			this.turns.push({
				user: this.currentUser,
				assistants: this.currentAssistants,
				toolResults: this.currentToolResults
			});
			this.lastCompleteTurnEnd = nextIdx;
		}
	}
};
function groupTurns(messages) {
	return new TurnBuilder().build(messages);
}
function findToolResultBlock(toolResults, toolUseId) {
	for (const msg of toolResults) {
		const content = getContent(msg);
		if (!Array.isArray(content)) continue;
		const block = content.find((item) => isToolResultBlock(item) && item.tool_use_id === toolUseId);
		if (block) return {
			block,
			message: msg
		};
	}
}
function matchToolResults(toolUseBlocks, toolResults) {
	return toolUseBlocks.map((block) => {
		const match = findToolResultBlock(toolResults, block.id);
		return {
			id: block.id,
			name: block.name,
			input: block.input,
			output: match?.block.content ?? null,
			timestamp: match ? getTimestamp(match.message) : void 0
		};
	});
}

//#endregion
//#region src/tracer.ts
function computeTraceEnd(messages) {
	return messages.reduce((latest, msg) => {
		const ts = getTimestamp(msg);
		if (!ts) return latest;
		if (!latest || ts > latest) return ts;
		return latest;
	}, void 0);
}
function createToolObservations(parentObservation, toolCalls, genStart) {
	for (const toolCall of toolCalls) {
		startObservation(`Tool: ${toolCall.name}`, {
			input: toolCall.input,
			metadata: {
				tool_name: toolCall.name,
				tool_id: toolCall.id
			}
		}, {
			asType: "tool",
			...genStart && { startTime: genStart },
			parentSpanContext: parentObservation.otelSpan.spanContext()
		}).update({ output: toolCall.output }).end(toolCall.timestamp);
		debug(`Created tool observation for: ${toolCall.name}`);
	}
}
function createGenerationObservation(ctx) {
	const { parentObservation, assistant, index, turn, model, userText, genEnd } = ctx;
	const assistantText = getTextContent(assistant);
	const assistantModel = assistant.message?.model ?? model;
	const toolCalls = matchToolResults(getToolCalls(assistant), turn.toolResults);
	const genStart = getTimestamp(assistant);
	const usageDetails = getUsage(assistant);
	const generation = startObservation(assistantModel, {
		model: assistantModel,
		...index === 0 && { input: {
			role: "user",
			content: userText
		} },
		output: {
			role: "assistant",
			content: assistantText
		},
		metadata: { tool_count: toolCalls.length },
		...usageDetails && { usageDetails }
	}, {
		asType: "generation",
		...genStart && { startTime: genStart },
		parentSpanContext: parentObservation.otelSpan.spanContext()
	});
	createToolObservations(generation, toolCalls, genStart);
	generation.end(genEnd);
}
function computeTraceContext(turn) {
	return {
		userText: getTextContent(turn.user),
		lastAssistantText: turn.assistants.length > 0 ? getTextContent(turn.assistants[turn.assistants.length - 1]) : "",
		model: turn.assistants[0]?.message?.model ?? "claude",
		traceStart: getTimestamp(turn.user),
		traceEnd: computeTraceEnd([...turn.assistants, ...turn.toolResults])
	};
}
function createGenerations(parentObservation, turn, model, userText) {
	for (let i = 0; i < turn.assistants.length; i++) {
		const nextGenStart = i + 1 < turn.assistants.length ? getTimestamp(turn.assistants[i + 1]) : void 0;
		createGenerationObservation({
			parentObservation,
			assistant: turn.assistants[i],
			index: i,
			turn,
			model,
			userText,
			genEnd: nextGenStart ?? /* @__PURE__ */ new Date()
		});
	}
}
async function createTrace(sessionId, turnNum, turn) {
	const { userText, lastAssistantText, model, traceStart, traceEnd } = computeTraceContext(turn);
	const hasTraceStart = traceStart !== void 0;
	await startActiveObservation(`Turn ${turnNum}`, async (span) => {
		updateActiveTrace({
			name: `Turn ${turnNum}`,
			sessionId,
			input: {
				role: "user",
				content: userText
			},
			output: {
				role: "assistant",
				content: lastAssistantText
			},
			metadata: {
				source: "claude-code",
				turn_number: turnNum,
				session_id: sessionId
			}
		});
		const rootSpan = startObservation(`Turn ${turnNum}`, {
			input: {
				role: "user",
				content: userText
			},
			output: {
				role: "assistant",
				content: lastAssistantText
			}
		}, {
			asType: "agent",
			...hasTraceStart && { startTime: traceStart },
			parentSpanContext: span.otelSpan.spanContext()
		});
		createGenerations(rootSpan, turn, model, userText);
		if (traceEnd) {
			rootSpan.end(traceEnd);
			span.end(traceEnd);
		}
	}, { ...hasTraceStart && {
		startTime: traceStart,
		endOnExit: false
	} });
	debug(`Created trace for turn ${turnNum}`);
}
async function processTranscript(sessionId, transcriptFile, state) {
	const sessionState = state[sessionId] ?? {
		last_line: 0,
		turn_count: 0
	};
	const lastLine = sessionState.last_line;
	const turnCount = sessionState.turn_count;
	const parsed = parseNewMessages(transcriptFile, lastLine);
	if (!parsed) return {
		turns: 0,
		updatedState: state
	};
	debug(`Processing ${parsed.messages.length} new messages`);
	const { turns, consumed } = groupTurns(parsed.messages);
	if (turns.length === 0) return {
		turns: 0,
		updatedState: state
	};
	await propagateAttributes({ sessionId }, async () => {
		for (let i = 0; i < turns.length; i++) await createTrace(sessionId, turnCount + i + 1, turns[i]);
	});
	const updatedState = computeUpdatedState(state, sessionId, turnCount, turns.length, consumed, parsed.lineOffsets, lastLine);
	return {
		turns: turns.length,
		updatedState
	};
}
async function processTranscriptWithRecovery(currentSessionId, currentFile, prevSessionId, prevFile, state) {
	const prevState = state[prevSessionId] ?? {
		last_line: 0,
		turn_count: 0
	};
	const currentState = state[currentSessionId] ?? {
		last_line: 0,
		turn_count: 0
	};
	const merged = mergeTranscriptMessages(prevFile, prevState.last_line, currentFile, currentState.last_line);
	if (!merged) return {
		turns: 0,
		updatedState: state
	};
	debug(`Merging transcripts: ${merged.prevCount} prev + ${merged.messages.length - merged.prevCount} current messages`);
	const { turns, consumed } = groupTurns(merged.messages);
	if (turns.length === 0) return {
		turns: 0,
		updatedState: state
	};
	const prevTurns = [];
	const currentTurns = [];
	for (let i = 0; i < turns.length; i++) if (getSessionId(turns[i].user) === prevSessionId) prevTurns.push({
		turn: turns[i],
		index: i
	});
	else currentTurns.push({
		turn: turns[i],
		index: i
	});
	if (prevTurns.length > 0) await propagateAttributes({ sessionId: prevSessionId }, async () => {
		for (let i = 0; i < prevTurns.length; i++) await createTrace(prevSessionId, prevState.turn_count + i + 1, prevTurns[i].turn);
	});
	if (currentTurns.length > 0) await propagateAttributes({ sessionId: currentSessionId }, async () => {
		for (let i = 0; i < currentTurns.length; i++) await createTrace(currentSessionId, currentState.turn_count + i + 1, currentTurns[i].turn);
	});
	const prevTotalLines = countTotalLines(prevFile);
	let updatedState = {
		...state,
		[prevSessionId]: {
			last_line: prevTotalLines,
			turn_count: prevState.turn_count + prevTurns.length,
			updated: (/* @__PURE__ */ new Date()).toISOString()
		}
	};
	const currentConsumed = Math.max(0, consumed - merged.prevCount);
	const currentLastLine = currentConsumed > 0 ? merged.currentLineOffsets[currentConsumed - 1] : currentState.last_line;
	updatedState = {
		...updatedState,
		[currentSessionId]: {
			last_line: currentLastLine,
			turn_count: currentState.turn_count + currentTurns.length,
			updated: (/* @__PURE__ */ new Date()).toISOString()
		}
	};
	return {
		turns: turns.length,
		updatedState
	};
}

//#endregion
//#region src/index.ts
async function readHookInput() {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
	const raw = chunks.join("").trim();
	if (!raw) return null;
	try {
		const data = JSON.parse(raw);
		if (typeof data.session_id === "string" && typeof data.transcript_path === "string") return {
			session_id: data.session_id,
			transcript_path: data.transcript_path
		};
		return null;
	} catch {
		return null;
	}
}
function initializeSDK(config) {
	const spanProcessor = new LangfuseSpanProcessor({
		exportMode: "immediate",
		publicKey: config.publicKey,
		secretKey: config.secretKey,
		baseUrl: config.baseUrl
	});
	const sdk = new NodeSDK({ spanProcessors: [spanProcessor] });
	sdk.start();
	return {
		sdk,
		spanProcessor
	};
}
function resolveEnvVars() {
	const publicKey = process.env.CC_LANGFUSE_PUBLIC_KEY ?? process.env.LANGFUSE_PUBLIC_KEY;
	const secretKey = process.env.CC_LANGFUSE_SECRET_KEY ?? process.env.LANGFUSE_SECRET_KEY;
	const baseUrl = process.env.CC_LANGFUSE_BASE_URL ?? process.env.LANGFUSE_BASE_URL;
	if (!publicKey || !secretKey) return null;
	return {
		publicKey,
		secretKey,
		baseUrl: baseUrl || void 0
	};
}
async function hook() {
	const scriptStart = Date.now();
	debug("Hook started");
	if ((process.env.TRACE_TO_LANGFUSE ?? "").toLowerCase() !== "true") {
		debug("Tracing disabled (TRACE_TO_LANGFUSE != true)");
		return;
	}
	const config = resolveEnvVars();
	if (!config) {
		log("ERROR", "Langfuse API keys not set (CC_LANGFUSE_PUBLIC_KEY / CC_LANGFUSE_SECRET_KEY)");
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
	const sessionId = input.session_id;
	const filePath = input.transcript_path;
	debug(`Processing session: ${sessionId}`);
	try {
		const previous = findPreviousSession(filePath, sessionId, state);
		let result;
		if (previous) {
			debug(`Recovering previous session: ${previous.sessionId}`);
			try {
				result = await processTranscriptWithRecovery(sessionId, filePath, previous.sessionId, previous.transcriptPath, state);
			} catch (e) {
				log("ERROR", `Failed to recover previous session: ${e instanceof Error ? e.message : String(e)}`);
				result = await processTranscript(sessionId, filePath, state);
			}
		} else result = await processTranscript(sessionId, filePath, state);
		const { turns, updatedState } = result;
		saveState(updatedState);
		await spanProcessor.forceFlush();
		const duration = (Date.now() - scriptStart) / 1e3;
		log("INFO", `Processed ${turns} turns in ${duration.toFixed(1)}s`);
		if (duration > HOOK_WARNING_THRESHOLD_SECONDS) log("WARN", `Hook took ${duration.toFixed(1)}s (>3min), consider optimizing`);
	} catch (e) {
		log("ERROR", `Failed to process transcript: ${e instanceof Error ? e.message : String(e)}`);
	} finally {
		await sdk.shutdown();
	}
}

//#endregion
export { hook };