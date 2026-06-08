import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { conversationService } from '../services/conversation.service';
import { claudeService } from '../services/claude.service';
import { mcpService } from '../services/mcp.service';
import { webSearchService } from '../services/web-search.service';
import { AgentState } from './state';
import { ToolCall, ToolDefinition } from '../types';
import chalk from 'chalk';

// Lightweight, consistent warning logger so failures surface instead of being
// silently swallowed.
function logNodeError(node: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(chalk.yellow(`[${node}] ${message}`));
}

// User Input Node - Processes user input and saves to database
export async function userInputNode(
  state: AgentState
): Promise<Partial<AgentState>> {
  try {
    // Extract the latest user message from state
    const latestMessage = state.messages[state.messages.length - 1];

    if (latestMessage && latestMessage instanceof HumanMessage) {
      // Save the message to database
      await conversationService.saveMessages(state.conversationId, [
        latestMessage,
      ]);
    }

    return {};
  } catch (error) {
    logNodeError('userInputNode', error);
    return {};
  }
}

// Model Node - Calls Claude API to generate response and decide on tool usage
export async function modelNode(
  state: AgentState
): Promise<Partial<AgentState>> {
  const nextIteration = (state.iterations || 0) + 1;

  try {
    // Get available tools from MCP servers
    const availableTools: ToolDefinition[] = await mcpService.getAllTools();

    // Add web search tool if configured
    if (webSearchService.isAvailable()) {
      availableTools.push(webSearchService.getToolDefinition());
    }

    // Get working directory from metadata
    const workingDirectory = state.metadata?.workingDirectory || process.cwd();

    // Generate response from Claude
    const response = await claudeService.generateResponse(
      state.messages,
      availableTools,
      workingDirectory
    );

    let newMessage: AIMessage;
    let shouldContinue = false;

    if (
      response.stop_reason === 'tool_use' &&
      response.function_calls.length > 0
    ) {
      // Extract tool calls from the model response. Prefer the provider-issued
      // tool-use ID so it round-trips correctly on the matching tool result.
      const toolCalls: ToolCall[] = response.function_calls.map(
        (call, index) => ({
          id: call.id || `call_${Date.now()}_${index}`,
          type: 'function' as const,
          function: {
            name: call.name,
            arguments: JSON.stringify(call.args || {}),
          },
        })
      );

      // Create AI message with tool calls
      newMessage = new AIMessage({
        content: response.content.length > 0 ? response.content[0].text : '',
        tool_calls: toolCalls as any,
      });

      shouldContinue = true;
    } else {
      // Create regular AI message
      const textContent =
        response.content.length > 0 ? response.content[0].text : '';

      newMessage = new AIMessage({ content: textContent });
      shouldContinue = false;
    }

    // Save the AI message to database
    await conversationService.saveMessages(state.conversationId, [newMessage]);

    return {
      messages: [newMessage],
      shouldContinue,
      iterations: nextIteration,
    };
  } catch (error) {
    logNodeError('modelNode', error);

    // Return error message
    const errorMessage = new AIMessage({
      content: 'Sorry, I encountered an error while processing your request.',
    });

    await conversationService
      .saveMessages(state.conversationId, [errorMessage])
      .catch((e) => logNodeError('modelNode.save', e));

    return {
      messages: [errorMessage],
      shouldContinue: false,
      iterations: nextIteration,
    };
  }
}

// Tool Use Node - Executes tools called by the model
export async function toolUseNode(
  state: AgentState
): Promise<Partial<AgentState>> {
  try {
    const toolMessages: ToolMessage[] = [];
    const toolResults: Record<string, any> = {};

    // Get the last message (should be AI message with tool calls)
    const lastMessage = state.messages[state.messages.length - 1];

    if (lastMessage instanceof AIMessage && lastMessage.tool_calls) {
      const toolCalls = lastMessage.tool_calls as unknown as ToolCall[];

      // Process each tool call
      for (const toolCall of toolCalls) {
        const toolName = toolCall.function?.name || '';
        let args: Record<string, unknown> = {};
        try {
          args = toolCall.function?.arguments
            ? JSON.parse(toolCall.function.arguments)
            : {};

          let result: any;

          // Check if it's web search tool
          if (toolName === 'web_search') {
            result = await webSearchService.executeTool(args as any);
            // executeTool returns formatted string, don't stringify again
          } else {
            // Determine which MCP server to use based on tool name
            const serverName = mcpService.getServerForTool(toolName);

            if (!serverName) {
              throw new Error(`No server found for tool: ${toolName}`);
            }

            // Execute the tool
            result = await mcpService.callTool(serverName, toolName, args);
          }

          // Create tool message
          const toolMessage = new ToolMessage({
            content:
              typeof result === 'string' ? result : JSON.stringify(result),
            tool_call_id: toolCall.id || '',
            name: toolName,
          });

          toolMessages.push(toolMessage);
          if (toolCall.id) {
            toolResults[toolCall.id] = result;
          }

          // Save tool execution to database
          await conversationService.saveToolExecution(
            state.conversationId,
            toolName,
            args,
            result,
            'COMPLETED'
          );
        } catch (error) {
          logNodeError(`toolUseNode.${toolName || 'unknown'}`, error);
          const errorObj = error as Error;

          // Create error tool message
          const toolMessage = new ToolMessage({
            content: JSON.stringify({ error: errorObj.message }),
            tool_call_id: toolCall.id || '',
            name: toolName,
          });

          toolMessages.push(toolMessage);
          if (toolCall.id) {
            toolResults[toolCall.id] = { error: errorObj.message };
          }

          // Save failed tool execution to database
          await conversationService
            .saveToolExecution(
              state.conversationId,
              toolName,
              args,
              { error: errorObj.message },
              'FAILED'
            )
            .catch((e) => logNodeError('toolUseNode.save', e));
        }
      }
    }

    // Save tool messages to database
    if (toolMessages.length > 0) {
      await conversationService.saveMessages(
        state.conversationId,
        toolMessages
      );
    }

    return {
      messages: toolMessages,
      toolResults,
    };
  } catch (error) {
    logNodeError('toolUseNode', error);
    return {};
  }
}
