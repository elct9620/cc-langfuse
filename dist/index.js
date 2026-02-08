import { Langfuse } from "langfuse";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

//#region src/logger.ts
const STATE_FILE = join(homedir(), ".claude", "state", "cc-langfuse_state.json");
const LOG_FILE = join(homedir(), ".claude", "state", "langfuse_hook.log");
const DEBUG = (process.env.CC_LANGFUSE_DEBUG ?? "").toLowerCase() === "true";
function log(level, message) {
	mkdirSync(dirname(LOG_FILE), { recursive: true });
	appendFileSync(LOG_FILE, `${(/* @__PURE__ */ new Date()).toISOString().replace("T", " ").slice(0, 19)} [${level}] ${message}\n`);
}
function debug(message) {
	if (DEBUG) log("DEBUG", message);
}

//#endregion
//#region src/parser.ts
function getContent(msg) {
	if (msg === null || typeof msg !== "object") return void 0;
	const record = msg;
	if ("message" in record && typeof record.message === "object") return record.message?.content;
	return record.content;
}
function isToolResult(msg) {
	const content = getContent(msg);
	if (!Array.isArray(content)) return false;
	return content.some((item) => typeof item === "object" && item !== null && item.type === "tool_result");
}
function getToolCalls(msg) {
	const content = getContent(msg);
	if (!Array.isArray(content)) return [];
	return content.filter((item) => typeof item === "object" && item !== null && item.type === "tool_use");
}
function getTextContent(msg) {
	const content = getContent(msg);
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const item of content) if (typeof item === "object" && item !== null && item.type === "text") parts.push(item.text ?? "");
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

//#endregion
//#region src/tracer.ts
function loadState() {
	try {
		return JSON.parse(readFileSync(STATE_FILE, "utf8"));
	} catch {
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
function createTrace(langfuse, sessionId, turnNum, turn) {
	const userText = getTextContent(turn.user);
	let finalOutput = "";
	if (turn.assistants.length > 0) finalOutput = getTextContent(turn.assistants[turn.assistants.length - 1]);
	let model = "claude";
	const firstAssistant = turn.assistants[0];
	if (firstAssistant?.message?.model) model = firstAssistant.message.model;
	const allToolCalls = [];
	for (const assistantMsg of turn.assistants) {
		const toolCalls = getToolCalls(assistantMsg);
		for (const toolCall of toolCalls) {
			const tc = toolCall;
			const toolName = tc.name ?? "unknown";
			const toolInput = tc.input ?? {};
			const toolId = tc.id ?? "";
			let toolOutput = null;
			for (const tr of turn.toolResults) {
				const trContent = getContent(tr);
				if (Array.isArray(trContent)) {
					for (const item of trContent) if (typeof item === "object" && item !== null && item.tool_use_id === toolId) {
						toolOutput = item.content;
						break;
					}
				}
			}
			allToolCalls.push({
				name: toolName,
				input: toolInput,
				output: toolOutput,
				id: toolId
			});
		}
	}
	const trace = langfuse.trace({
		name: `Turn ${turnNum}`,
		sessionId,
		input: {
			role: "user",
			content: userText
		},
		output: {
			role: "assistant",
			content: finalOutput
		},
		metadata: {
			source: "claude-code",
			turn_number: turnNum,
			session_id: sessionId
		}
	});
	trace.generation({
		name: "Claude Response",
		model,
		input: {
			role: "user",
			content: userText
		},
		output: {
			role: "assistant",
			content: finalOutput
		},
		metadata: { tool_count: allToolCalls.length }
	});
	for (const toolCall of allToolCalls) {
		trace.span({
			name: `Tool: ${toolCall.name}`,
			input: toolCall.input,
			metadata: {
				tool_name: toolCall.name,
				tool_id: toolCall.id
			}
		}).end({ output: toolCall.output });
		debug(`Created span for tool: ${toolCall.name}`);
	}
	debug(`Created trace for turn ${turnNum}`);
}
function processTranscript(langfuse, sessionId, transcriptFile, state) {
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
		return 0;
	}
	const newMessages = [];
	for (let i = lastLine; i < totalLines; i++) try {
		newMessages.push(JSON.parse(lines[i]));
	} catch {
		continue;
	}
	if (newMessages.length === 0) return 0;
	debug(`Processing ${newMessages.length} new messages`);
	const turns = groupTurns(newMessages);
	for (let i = 0; i < turns.length; i++) createTrace(langfuse, sessionId, turnCount + i + 1, turns[i]);
	state[sessionId] = {
		last_line: totalLines,
		turn_count: turnCount + turns.length,
		updated: (/* @__PURE__ */ new Date()).toISOString()
	};
	saveState(state);
	return turns.length;
}

//#endregion
//#region src/index.ts
async function hook() {
	const scriptStart = Date.now();
	debug("Hook started");
	if ((process.env.TRACE_TO_LANGFUSE ?? "").toLowerCase() !== "true") {
		debug("Tracing disabled (TRACE_TO_LANGFUSE != true)");
		return;
	}
	const publicKey = process.env.CC_LANGFUSE_PUBLIC_KEY ?? process.env.LANGFUSE_PUBLIC_KEY;
	const secretKey = process.env.CC_LANGFUSE_SECRET_KEY ?? process.env.LANGFUSE_SECRET_KEY;
	const host = process.env.CC_LANGFUSE_HOST ?? process.env.LANGFUSE_HOST ?? "https://cloud.langfuse.com";
	if (!publicKey || !secretKey) {
		log("ERROR", "Langfuse API keys not set (CC_LANGFUSE_PUBLIC_KEY / CC_LANGFUSE_SECRET_KEY)");
		return;
	}
	let langfuse;
	try {
		langfuse = new Langfuse({
			publicKey,
			secretKey,
			baseUrl: host
		});
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
		const turns = processTranscript(langfuse, sessionId, filePath, state);
		await langfuse.flushAsync();
		const duration = (Date.now() - scriptStart) / 1e3;
		log("INFO", `Processed ${turns} turns in ${duration.toFixed(1)}s`);
		if (duration > 180) log("WARN", `Hook took ${duration.toFixed(1)}s (>3min), consider optimizing`);
	} catch (e) {
		log("ERROR", `Failed to process transcript: ${e}`);
	} finally {
		await langfuse.shutdownAsync();
	}
}

//#endregion
export { hook };