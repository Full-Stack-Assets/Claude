import Anthropic from '@anthropic-ai/sdk';
import {
  BaseMessage,
  HumanMessage,
  AIMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { ModelResponse, ToolCall, ToolDefinition } from '../types';

const MODEL_NAME = 'claude-opus-4-8';
// Non-streaming request, so keep max_tokens under the SDK HTTP-timeout
// threshold (~16K) per Anthropic guidance.
const MAX_TOKENS = 16000;

export class ClaudeService {
  // Constructed lazily so importing this module (and its singleton) is cheap and
  // side-effect-free — letting the startup env-validation run and report a
  // friendly error before any client is built.
  private _client: Anthropic | null = null;

  private get client(): Anthropic {
    if (!this._client) {
      if (!process.env.ANTHROPIC_API_KEY) {
        throw new Error('ANTHROPIC_API_KEY is not set');
      }
      this._client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    }
    return this._client;
  }

  async generateResponse(
    messages: BaseMessage[],
    tools: ToolDefinition[] = [],
    workingDirectory?: string
  ): Promise<ModelResponse> {
    const anthropicMessages = this.convertMessages(messages);

    const params: Anthropic.MessageCreateParams = {
      model: MODEL_NAME,
      max_tokens: MAX_TOKENS,
      system: this.buildSystemPrompt(workingDirectory),
      messages: anthropicMessages,
    };

    if (tools.length > 0) {
      params.tools = this.convertTools(tools);
    }

    const response = await this.client.messages.create(params);

    // Split the content blocks into text and tool-use calls.
    const textParts: { type: 'text'; text: string }[] = [];
    const functionCalls: ModelResponse['function_calls'] = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        textParts.push({ type: 'text', text: block.text });
      } else if (block.type === 'tool_use') {
        functionCalls.push({
          id: block.id,
          name: block.name,
          args: (block.input as Record<string, unknown>) || {},
        });
      }
    }

    return {
      content: textParts,
      function_calls: functionCalls,
      stop_reason: response.stop_reason === 'tool_use' ? 'tool_use' : 'end_turn',
    };
  }

  private buildSystemPrompt(workingDirectory?: string): string {
    const cwd = workingDirectory || process.cwd();
    return `You are a proactive AI coding assistant with MCP tool access.

CORE PRINCIPLES:
1. Working Directory: ${cwd}
2. ALWAYS use tools - never fabricate or assume information
3. Use full absolute paths for file operations
4. Execute immediately without asking for confirmation unless genuinely ambiguous

TOOL USAGE RULES:
- To see files: list_directory or list_allowed_directories first
- To read content: read_file or read_multiple_files with full paths
- To create/modify: write_file with full path
- When user says "here" or "current directory", use: ${cwd}

WORKFLOW:
1. Understand the request
2. Use tools to gather needed information
3. Execute the action with tools
4. Report results concisely

EXAMPLES:
User: "list files" -> list_directory("${cwd}")
User: "read package.json" -> read_file("${cwd}/package.json")
User: "create test.js" -> write_file("${cwd}/test.js", <content>)
User: "summarize the project" -> list_directory -> read relevant files -> provide summary

Be direct, use tools proactively, and complete tasks efficiently.`;
  }

  /**
   * Convert LangChain messages to the Anthropic Messages format.
   *
   * Anthropic requires every `tool_result` to reference a `tool_use` that
   * appears earlier in the same request. Because the conversation history is
   * loaded from the database with a row limit, the oldest messages can be
   * truncated mid-pair — leaving a `tool_result` whose `tool_use` was cut off.
   * We track the tool-use IDs we have emitted and drop any orphaned
   * `tool_result` to avoid a 400 from the API.
   */
  private convertMessages(messages: BaseMessage[]): Anthropic.MessageParam[] {
    const result: Anthropic.MessageParam[] = [];
    const seenToolUseIds = new Set<string>();

    for (const message of messages) {
      if (message instanceof HumanMessage) {
        result.push({
          role: 'user',
          content: String(message.content),
        });
      } else if (message instanceof AIMessage) {
        const blocks: Anthropic.ContentBlockParam[] = [];

        if (typeof message.content === 'string' && message.content.trim()) {
          blocks.push({ type: 'text', text: message.content });
        }

        const toolCalls = (message.tool_calls || []) as unknown as ToolCall[];
        for (const toolCall of toolCalls) {
          seenToolUseIds.add(toolCall.id);
          blocks.push({
            type: 'tool_use',
            id: toolCall.id,
            name: toolCall.function.name,
            input: JSON.parse(toolCall.function.arguments || '{}'),
          });
        }

        // An assistant turn must have at least one content block.
        if (blocks.length === 0) {
          blocks.push({ type: 'text', text: '(no content)' });
        }

        result.push({ role: 'assistant', content: blocks });
      } else if (message instanceof ToolMessage) {
        // Skip results whose originating tool_use was truncated out of history.
        if (!seenToolUseIds.has(message.tool_call_id)) {
          continue;
        }

        result.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: message.tool_call_id,
              content:
                typeof message.content === 'string'
                  ? message.content
                  : JSON.stringify(message.content),
            },
          ],
        });
      }
    }

    return result;
  }

  /**
   * Convert MCP/web-search tool definitions to the Anthropic tool format.
   * Anthropic accepts standard JSON Schema directly as `input_schema`, so no
   * Gemini-style schema cleaning is required.
   */
  convertTools(tools: ToolDefinition[]): Anthropic.Tool[] {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description || 'No description provided',
      input_schema:
        tool.inputSchema && tool.inputSchema.type === 'object'
          ? (tool.inputSchema as Anthropic.Tool.InputSchema)
          : { type: 'object', properties: {} },
    }));
  }
}

export const claudeService = new ClaudeService();
