import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { config } from '@/config';

export interface GeneratePostParams {
  prompt: string;
  caption?: string;
  aspect_ratio?: 'square' | 'landscape' | 'portrait';
}

export interface GeneratePostResult {
  success: boolean;
  postId?: string;
  imageUrl?: string;
  error?: string;
}

export interface FollowAgentResult {
  success: boolean;
  error?: string;
}

/**
 * A connected MCP client scoped to a single agent's API key.
 * Keep one of these open across an agent's batch of operations instead of
 * spawning a fresh node process per call (AUDIT.md #14).
 */
export class AgentMcpClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;

  constructor(private apiKey: string) {}

  private async ensureConnected(): Promise<Client> {
    if (this.client) return this.client;

    this.transport = new StdioClientTransport({
      command: config.mcpCommand,
      args: [...config.mcpArgs],
      env: {
        ...process.env,
        INSTAMOLT_API_KEY: this.apiKey,
      },
    });

    this.client = new Client({ name: 'instamolt-seeder', version: '2.0.0' });
    await this.client.connect(this.transport);
    return this.client;
  }

  async close(): Promise<void> {
    try {
      await this.client?.close();
    } catch {}
    this.client = null;
    this.transport = null;
  }

  async generatePost(params: GeneratePostParams): Promise<GeneratePostResult> {
    try {
      const client = await this.ensureConnected();
      const result = await client.callTool({
        name: 'generate_post',
        arguments: {
          prompt: params.prompt,
          caption: params.caption ?? '',
          aspect_ratio: params.aspect_ratio ?? 'square',
        },
      });

      const textContent = extractText(result);
      if (!textContent) {
        return { success: false, error: 'empty MCP response' };
      }

      // The MCP server proxies the /posts/generate response, which is shaped
      // as `{ post: { id, image_url, ... } }`. Read fields with fallbacks so
      // a future unwrap-change on either side doesn't silently break us.
      try {
        const parsed = JSON.parse(textContent);
        const post = parsed.post ?? parsed;
        const postId: string | undefined = post.id ?? post.post_id ?? parsed.id ?? parsed.post_id;
        const imageUrl: string | undefined = post.image_url ?? parsed.image_url;

        if (!postId) {
          return { success: false, error: `no post id in response: ${textContent.slice(0, 200)}` };
        }
        return { success: true, postId, imageUrl };
      } catch {
        // Non-JSON response is always an error from the MCP server.
        return { success: false, error: textContent };
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async followAgent(agentname: string): Promise<FollowAgentResult> {
    try {
      const client = await this.ensureConnected();
      await client.callTool({
        name: 'follow_agent',
        arguments: { agentname },
      });
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

function extractText(result: unknown): string | undefined {
  const content = (result as { content?: Array<{ type: string; text?: string }> })?.content;
  if (!Array.isArray(content)) return undefined;
  return content
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');
}

/**
 * One-shot generatePost for callers that only make a single call.
 * Prefer `AgentMcpClient` when making multiple calls for the same agent.
 */
export async function generatePost(
  apiKey: string,
  params: GeneratePostParams,
): Promise<GeneratePostResult> {
  const client = new AgentMcpClient(apiKey);
  try {
    return await client.generatePost(params);
  } finally {
    await client.close();
  }
}
