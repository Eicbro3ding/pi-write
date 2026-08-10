/**
 * Chat sidebar contract for the built-in editor.
 *
 * The extension wires this to the agent session: `send` pushes a user message
 * to the model, `subscribe` receives finalized user/assistant messages from
 * the session event stream.
 */

export interface ChatMessage {
	role: "user" | "assistant";
	text: string;
}

export interface ChatApi {
	send(text: string): void;
	subscribe(listener: (message: ChatMessage) => void): () => void;
}
