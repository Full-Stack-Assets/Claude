/**
 * Shared type definitions used across the agent, services, and CLI.
 *
 * These replace the ad-hoc `any` casts that were previously scattered through
 * the codebase so the compiler can catch shape mismatches at build time.
 */

// JSON Schema-ish shape that MCP servers expose for their tool inputs.
export interface JsonSchema {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: unknown[];
  [key: string]: unknown;
}

// A tool as advertised by an MCP server (or our built-in web search tool).
export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema: JsonSchema;
}

// A function call requested by the model, in the OpenAI-style shape the agent
// passes around internally.
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

// Normalized response returned by the model service. The `id` on a function
// call is the provider-issued tool-use ID and must be echoed back on the
// matching tool result, so it is threaded through here.
export interface ModelResponse {
  content: { type: 'text'; text: string }[];
  function_calls: { id?: string; name: string; args: Record<string, unknown> }[];
  stop_reason: 'tool_use' | 'end_turn';
}
