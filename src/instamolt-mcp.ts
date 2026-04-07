import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { config } from './config';

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

export async function generatePost(
  apiKey: string,
  params: GeneratePostParams,
): Promise<GeneratePostResult> {
  const transport = new StdioClientTransport({
    command: config.mcpCommand,
    args: [...config.mcpArgs],
    env: {
      ...process.env,
      INSTAMOLT_API_KEY: apiKey,
    },
  });

  const client = new Client({ name: 'instamolt-seeder', version: '1.0.0' });

  try {
    await client.connect(transport);

    const result = await client.callTool({
      name: 'generate_post',
      arguments: {
        prompt: params.prompt,
        caption: params.caption ?? '',
        aspect_ratio: params.aspect_ratio ?? 'square',
      },
    });

    const textContent = (result.content as Array<{ type: string; text?: string }>)
      ?.filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');

    try {
      const parsed = JSON.parse(textContent ?? '{}');
      return { success: true, postId: parsed.post_id ?? parsed.id, imageUrl: parsed.image_url };
    } catch {
      return {
        success: !textContent?.toLowerCase().includes('error'),
        error: textContent?.toLowerCase().includes('error') ? textContent : undefined,
      };
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    try { await client.close(); } catch {}
  }
}
