export function getContent(msg) {
    if (msg === null || typeof msg !== "object")
        return undefined;
    const record = msg;
    if ("message" in record && typeof record.message === "object") {
        return record.message?.content;
    }
    return record.content;
}
export function isToolResult(msg) {
    const content = getContent(msg);
    if (!Array.isArray(content))
        return false;
    return content.some((item) => typeof item === "object" &&
        item !== null &&
        item.type === "tool_result");
}
export function getToolCalls(msg) {
    const content = getContent(msg);
    if (!Array.isArray(content))
        return [];
    return content.filter((item) => typeof item === "object" &&
        item !== null &&
        item.type === "tool_use");
}
export function getTextContent(msg) {
    const content = getContent(msg);
    if (typeof content === "string")
        return content;
    if (!Array.isArray(content))
        return "";
    const parts = [];
    for (const item of content) {
        if (typeof item === "object" && item !== null && item.type === "text") {
            parts.push(item.text ?? "");
        }
        else if (typeof item === "string") {
            parts.push(item);
        }
    }
    return parts.join("\n");
}
export function mergeAssistantParts(parts) {
    if (parts.length === 0)
        return {};
    const mergedContent = [];
    for (const part of parts) {
        const content = getContent(part);
        if (Array.isArray(content)) {
            mergedContent.push(...content);
        }
        else if (content !== undefined && content !== null) {
            mergedContent.push({ type: "text", text: String(content) });
        }
    }
    const result = { ...parts[0] };
    if ("message" in result) {
        result.message = { ...result.message, content: mergedContent };
    }
    else {
        result.content = mergedContent;
    }
    return result;
}
export function groupTurns(messages) {
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
        if (currentUser !== null && currentAssistants.length > 0) {
            turns.push({
                user: currentUser,
                assistants: currentAssistants,
                toolResults: currentToolResults,
            });
        }
    }
    for (const msg of messages) {
        const role = msg.type ?? msg.message?.role ?? undefined;
        if (role === "user") {
            if (isToolResult(msg)) {
                currentToolResults.push(msg);
                continue;
            }
            // New user message — finalize previous turn
            finalizeTurn();
            currentUser = msg;
            currentAssistants = [];
            currentParts = [];
            currentMsgId = null;
            currentToolResults = [];
        }
        else if (role === "assistant") {
            const msgId = msg.message?.id;
            if (!msgId) {
                currentParts.push(msg);
            }
            else if (msgId === currentMsgId) {
                currentParts.push(msg);
            }
            else {
                finalizeParts();
                currentMsgId = msgId;
                currentParts = [msg];
            }
        }
    }
    // Process final turn
    finalizeTurn();
    return turns;
}
