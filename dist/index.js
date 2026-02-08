import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
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
function findLatestTranscript() {
	const projectsDir = join(homedir(), ".claude", "projects");
	let dirs;
	try {
		dirs = readdirSync(projectsDir);
	} catch {
		debug(`Projects directory not found: ${projectsDir}`);
		return null;
	}
	let latestFile = null;
	let latestMtime = 0;
	for (const dir of dirs) {
		const projectDir = join(projectsDir, dir);
		let stat;
		try {
			stat = statSync(projectDir);
		} catch {
			continue;
		}
		if (!stat.isDirectory()) continue;
		let files;
		try {
			files = readdirSync(projectDir);
		} catch {
			continue;
		}
		for (const file of files) {
			if (!file.endsWith(".jsonl")) continue;
			const filePath = join(projectDir, file);
			try {
				const mtime = statSync(filePath).mtimeMs;
				if (mtime > latestMtime) {
					latestMtime = mtime;
					latestFile = filePath;
				}
			} catch {
				continue;
			}
		}
	}
	if (!latestFile) {
		debug("No transcript files found");
		return null;
	}
	try {
		const firstLine = readFileSync(latestFile, "utf8").split("\n")[0];
		const sessionId = JSON.parse(firstLine).sessionId ?? latestFile.replace(/.*\//, "").replace(".jsonl", "");
		debug(`Found transcript: ${latestFile}, session: ${sessionId}`);
		return {
			sessionId,
			filePath: latestFile
		};
	} catch (e) {
		debug(`Error reading transcript ${latestFile}: ${e}`);
		return null;
	}
}

//#endregion
//#region src/parser.ts
function isTextBlock(item) {
	return typeof item === "object" && item !== null && item.type === "text";
}
function isToolUseBlock(item) {
	return typeof item === "object" && item !== null && item.type === "tool_use";
}
function isToolResultBlock(item) {
	return typeof item === "object" && item !== null && item.type === "tool_result";
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
function groupTurns(messages) {
	const turns = [];
	let currentUser = null;
	let currentAssistants = [];
	let currentParts = [];
	let currentMsgId = null;
	let currentToolResults = [];
	function finalizeParts() {
		if (currentMsgId !== null && currentParts.length > 0) {
			currentAssistants.push(mergeAssistantParts(currentParts));
			currentParts = [];
			currentMsgId = null;
		}
	}
	function finalizeTurn() {
		finalizeParts();
		if (currentUser !== null && currentAssistants.length > 0) turns.push({
			user: currentUser,
			assistants: currentAssistants,
			toolResults: currentToolResults
		});
	}
	for (const msg of messages) {
		const role = msg.type ?? msg.message?.role ?? void 0;
		if (role === "user") {
			if (isToolResult(msg)) {
				currentToolResults.push(msg);
				continue;
			}
			finalizeTurn();
			currentUser = msg;
			currentAssistants = [];
			currentParts = [];
			currentMsgId = null;
			currentToolResults = [];
		} else if (role === "assistant") {
			const msgId = msg.message?.id;
			if (!msgId) currentParts.push(msg);
			else if (msgId === currentMsgId) currentParts.push(msg);
			else {
				finalizeParts();
				currentMsgId = msgId;
				currentParts = [msg];
			}
		}
	}
	finalizeTurn();
	return turns;
}
function matchToolResults(toolUseBlocks, toolResults) {
	return toolUseBlocks.map((block) => {
		let output = null;
		for (const tr of toolResults) {
			const trContent = getContent(tr);
			if (!Array.isArray(trContent)) continue;
			for (const item of trContent) if (isToolResultBlock(item) && item.tool_use_id === block.id) {
				output = item.content;
				break;
			}
			if (output !== null) break;
		}
		return {
			id: block.id,
			name: block.name,
			input: block.input,
			output
		};
	});
}

//#endregion
//#region src/tracer.ts
async function createTrace(sessionId, turnNum, turn) {
	const userText = getTextContent(turn.user);
	const lastAssistantText = turn.assistants.length > 0 ? getTextContent(turn.assistants[turn.assistants.length - 1]) : "";
	const model = turn.assistants[0]?.message?.model ?? "claude";
	await startActiveObservation(`Turn ${turnNum}`, async () => {
		updateActiveTrace({
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
		for (let i = 0; i < turn.assistants.length; i++) {
			const assistant = turn.assistants[i];
			const assistantText = getTextContent(assistant);
			const assistantModel = assistant.message?.model ?? model;
			const toolCalls = matchToolResults(getToolCalls(assistant), turn.toolResults);
			const generation = startObservation(assistantModel, {
				model: assistantModel,
				...i === 0 && { input: {
					role: "user",
					content: userText
				} },
				output: {
					role: "assistant",
					content: assistantText
				},
				metadata: { tool_count: toolCalls.length }
			}, { asType: "generation" });
			for (const toolCall of toolCalls) {
				generation.startObservation(`Tool: ${toolCall.name}`, {
					input: toolCall.input,
					metadata: {
						tool_name: toolCall.name,
						tool_id: toolCall.id
					}
				}, { asType: "tool" }).update({ output: toolCall.output }).end();
				debug(`Created tool observation for: ${toolCall.name}`);
			}
			generation.end();
		}
	});
	debug(`Created trace for turn ${turnNum}`);
}
async function processTranscript(sessionId, transcriptFile, state) {
	const sessionState = state[sessionId] ?? {
		last_line: 0,
		turn_count: 0
	};
	const lastLine = sessionState.last_line;
	const turnCount = sessionState.turn_count;
	const lines = readFileSync(transcriptFile, "utf8").trim().split("\n");
	const totalLines = lines.length;
	if (lastLine >= totalLines) {
		debug(`No new lines to process (last: ${lastLine}, total: ${totalLines})`);
		return {
			turns: 0,
			updatedState: state
		};
	}
	const newMessages = [];
	for (let i = lastLine; i < totalLines; i++) try {
		newMessages.push(JSON.parse(lines[i]));
	} catch (e) {
		debug(`Skipping line ${i}: ${e}`);
		continue;
	}
	if (newMessages.length === 0) return {
		turns: 0,
		updatedState: state
	};
	debug(`Processing ${newMessages.length} new messages`);
	const turns = groupTurns(newMessages);
	await propagateAttributes({ sessionId }, async () => {
		for (let i = 0; i < turns.length; i++) await createTrace(sessionId, turnCount + i + 1, turns[i]);
	});
	const updatedState = {
		...state,
		[sessionId]: {
			last_line: totalLines,
			turn_count: turnCount + turns.length,
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
	const spanProcessor = new LangfuseSpanProcessor({
		exportMode: "immediate",
		publicKey: config.publicKey,
		secretKey: config.secretKey,
		baseUrl: config.baseUrl
	});
	const sdk = new NodeSDK({ spanProcessors: [spanProcessor] });
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
		const { turns, updatedState } = await processTranscript(sessionId, filePath, state);
		saveState(updatedState);
		await spanProcessor.forceFlush();
		const duration = (Date.now() - scriptStart) / 1e3;
		log("INFO", `Processed ${turns} turns in ${duration.toFixed(1)}s`);
		if (duration > HOOK_WARNING_THRESHOLD_SECONDS) log("WARN", `Hook took ${duration.toFixed(1)}s (>3min), consider optimizing`);
	} catch (e) {
		log("ERROR", `Failed to process transcript: ${e}`);
	} finally {
		await sdk.shutdown();
	}
}

//#endregion
export { hook };