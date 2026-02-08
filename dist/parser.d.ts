type Message = Record<string, any>;
export interface Turn {
    user: Message;
    assistants: Message[];
    toolResults: Message[];
}
export declare function getContent(msg: unknown): unknown;
export declare function isToolResult(msg: Message): boolean;
export declare function getToolCalls(msg: Message): Message[];
export declare function getTextContent(msg: Message): string;
export declare function mergeAssistantParts(parts: Message[]): Message;
export declare function groupTurns(messages: Message[]): Turn[];
export {};
