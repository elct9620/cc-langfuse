import type { Langfuse } from "langfuse";
export interface SessionState {
    last_line: number;
    turn_count: number;
    updated: string;
}
export type State = Record<string, SessionState>;
export declare function loadState(): State;
export declare function saveState(state: State): void;
export declare function findLatestTranscript(): {
    sessionId: string;
    filePath: string;
} | null;
export declare function processTranscript(langfuse: Langfuse, sessionId: string, transcriptFile: string, state: State): number;
