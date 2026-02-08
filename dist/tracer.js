import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { STATE_FILE, debug } from "./logger.js";
import { getContent, getTextContent, getToolCalls, groupTurns, } from "./parser.js";
export function loadState() {
    try {
        return JSON.parse(readFileSync(STATE_FILE, "utf8"));
    }
    catch {
        return {};
    }
}
export function saveState(state) {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
export function findLatestTranscript() {
    const projectsDir = join(homedir(), ".claude", "projects");
    let dirs;
    try {
        dirs = readdirSync(projectsDir);
    }
    catch {
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
        }
        catch {
            continue;
        }
        if (!stat.isDirectory())
            continue;
        let files;
        try {
            files = readdirSync(projectDir);
        }
        catch {
            continue;
        }
        for (const file of files) {
            if (!file.endsWith(".jsonl"))
                continue;
            const filePath = join(projectDir, file);
            try {
                const mtime = statSync(filePath).mtimeMs;
                if (mtime > latestMtime) {
                    latestMtime = mtime;
                    latestFile = filePath;
                }
            }
            catch {
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
        const firstMsg = JSON.parse(firstLine);
        const sessionId = firstMsg.sessionId ?? latestFile.replace(/.*\//, "").replace(".jsonl", "");
        debug(`Found transcript: ${latestFile}, session: ${sessionId}`);
        return { sessionId, filePath: latestFile };
    }
    catch (e) {
        debug(`Error reading transcript ${latestFile}: ${e}`);
        return null;
    }
}
function createTrace(langfuse, sessionId, turnNum, turn) {
    const userText = getTextContent(turn.user);
    let finalOutput = "";
    if (turn.assistants.length > 0) {
        finalOutput = getTextContent(turn.assistants[turn.assistants.length - 1]);
    }
    let model = "claude";
    const firstAssistant = turn.assistants[0];
    if (firstAssistant?.message?.model) {
        model = firstAssistant.message.model;
    }
    // Collect all tool calls with their results
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
                    for (const item of trContent) {
                        if (typeof item === "object" &&
                            item !== null &&
                            item.tool_use_id === toolId) {
                            toolOutput = item.content;
                            break;
                        }
                    }
                }
            }
            allToolCalls.push({
                name: toolName,
                input: toolInput,
                output: toolOutput,
                id: toolId,
            });
        }
    }
    // Create trace
    const trace = langfuse.trace({
        name: `Turn ${turnNum}`,
        sessionId,
        input: { role: "user", content: userText },
        output: { role: "assistant", content: finalOutput },
        metadata: {
            source: "claude-code",
            turn_number: turnNum,
            session_id: sessionId,
        },
    });
    // Create generation
    trace.generation({
        name: "Claude Response",
        model,
        input: { role: "user", content: userText },
        output: { role: "assistant", content: finalOutput },
        metadata: { tool_count: allToolCalls.length },
    });
    // Create tool spans
    for (const toolCall of allToolCalls) {
        const span = trace.span({
            name: `Tool: ${toolCall.name}`,
            input: toolCall.input,
            metadata: {
                tool_name: toolCall.name,
                tool_id: toolCall.id,
            },
        });
        span.end({ output: toolCall.output });
        debug(`Created span for tool: ${toolCall.name}`);
    }
    debug(`Created trace for turn ${turnNum}`);
}
export function processTranscript(langfuse, sessionId, transcriptFile, state) {
    const sessionState = state[sessionId] ?? { last_line: 0, turn_count: 0 };
    const lastLine = sessionState.last_line;
    const turnCount = sessionState.turn_count;
    const lines = readFileSync(transcriptFile, "utf8").trim().split("\n");
    const totalLines = lines.length;
    if (lastLine >= totalLines) {
        debug(`No new lines to process (last: ${lastLine}, total: ${totalLines})`);
        return 0;
    }
    // Parse new messages
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const newMessages = [];
    for (let i = lastLine; i < totalLines; i++) {
        try {
            newMessages.push(JSON.parse(lines[i]));
        }
        catch {
            continue;
        }
    }
    if (newMessages.length === 0)
        return 0;
    debug(`Processing ${newMessages.length} new messages`);
    const turns = groupTurns(newMessages);
    for (let i = 0; i < turns.length; i++) {
        createTrace(langfuse, sessionId, turnCount + i + 1, turns[i]);
    }
    // Update state
    state[sessionId] = {
        last_line: totalLines,
        turn_count: turnCount + turns.length,
        updated: new Date().toISOString(),
    };
    saveState(state);
    return turns.length;
}
