import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolDefinition } from '../types';

interface MCPServer {
  name: string;
  command: string;
  args: string[];
  client?: Client;
  tools?: ToolDefinition[];
}

export class MCPService {
  private servers: Map<string, MCPServer> = new Map();
  private connectedServers: Set<string> = new Set();
  // Explicit tool-name -> server-name index, kept in sync as tools are listed.
  // Gives getServerForTool() an O(1) lookup instead of scanning every server.
  private toolToServer: Map<string, string> = new Map();

  // Connect to an MCP server using stdio
  async connectServer(
    name: string,
    command: string,
    args: string[]
  ): Promise<void> {
    try {
      const client = new Client(
        {
          name: `claude-assistant-${name}`,
          version: '1.0.0',
        },
        {
          // A client that consumes tools does not declare a `tools` capability;
          // that is advertised by the server side.
          capabilities: {},
        }
      );

      // Create stdio transport to communicate with the MCP server
      const transport = new StdioClientTransport({
        command,
        args,
        stderr: 'pipe', // Capture stderr instead of inheriting
      });

      transport.onerror = (error) => {};

      transport.onclose = () => {
        this.connectedServers.delete(name);
      };

      await client.connect(transport);

      // Store server info
      this.servers.set(name, {
        name,
        command,
        args,
        client,
      });

      this.connectedServers.add(name);
    } catch (error) {
      throw error;
    }
  }

  async disconnectServer(name: string): Promise<void> {
    try {
      const server = this.servers.get(name);
      if (server?.client) {
        // Wrap close in try-catch to handle EPIPE errors
        try {
          await Promise.race([
            server.client.close(),
            new Promise((resolve) => setTimeout(resolve, 1000)), // 1s timeout
          ]);
        } catch (closeError: any) {}
        this.servers.delete(name);
        this.connectedServers.delete(name);
        // Drop this server's entries from the tool index
        for (const [toolName, owner] of this.toolToServer) {
          if (owner === name) {
            this.toolToServer.delete(toolName);
          }
        }
      }
    } catch (error) {}
  }

  async listTools(serverName: string): Promise<ToolDefinition[]> {
    try {
      const server = this.servers.get(serverName);
      if (!server?.client) {
        throw new Error(`Server ${serverName} not connected`);
      }

      const response = await server.client.listTools();
      const tools = (response.tools || []) as ToolDefinition[];

      // Cache tools and update the tool -> server index
      server.tools = tools;
      for (const tool of tools) {
        this.toolToServer.set(tool.name, serverName);
      }

      return tools;
    } catch (error) {
      return [];
    }
  }

  async getAllTools(): Promise<ToolDefinition[]> {
    const allTools: ToolDefinition[] = [];

    for (const serverName of this.connectedServers) {
      const tools = await this.listTools(serverName);
      allTools.push(...tools);
    }

    return allTools;
  }

  async callTool(
    serverName: string,
    toolName: string,
    args: any
  ): Promise<any> {
    try {
      const server = this.servers.get(serverName);
      if (!server?.client) {
        throw new Error(`Server ${serverName} not connected`);
      }

      const response = await server.client.callTool({
        name: toolName,
        arguments: args,
      });

      return response;
    } catch (error) {
      throw error;
    }
  }

  /**
   * Get the server that provides a given tool. Backed by an index that is
   * populated whenever a server's tools are listed.
   */
  getServerForTool(toolName: string): string | null {
    return this.toolToServer.get(toolName) ?? null;
  }

  // check if a server is connected
  isConnected(serverName: string): boolean {
    return this.connectedServers.has(serverName);
  }

  // get all connected server names
  getConnectedServers(): string[] {
    return Array.from(this.connectedServers);
  }
  // Disconnect all servers
  async disconnectAll(): Promise<void> {
    const promises = Array.from(this.connectedServers).map((serverName) =>
      this.disconnectServer(serverName).catch(() => {
      })
    );

    await Promise.all(promises);
  }
}

export const mcpService = new MCPService();
