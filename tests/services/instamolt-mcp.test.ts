import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock is hoisted above imports, so plain `const mockFoo = vi.fn()` would
// be in the temporal dead zone when the factory runs. vi.hoisted moves the
// declarations into the same hoisted scope as vi.mock so the closures bind
// to real vi.fn instances.
const { mockCallTool, mockClose, mockConnect } = vi.hoisted(() => ({
  mockCallTool: vi.fn(),
  mockClose: vi.fn(),
  mockConnect: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  // Vitest 4 requires `function` (not arrow) for constructor mocks so `new
  // Client(...)` can call the implementation as a constructor.
  Client: vi.fn().mockImplementation(function () {
    return {
      connect: mockConnect,
      callTool: mockCallTool,
      close: mockClose,
    };
  }),
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn().mockImplementation(function () {
    return {};
  }),
}));

// Import AFTER the mocks are registered.
import { AgentMcpClient, generatePost } from '@/services/instamolt-mcp';

function textResult(text: string) {
  return { content: [{ type: 'text', text }] };
}

beforeEach(() => {
  mockCallTool.mockReset();
  mockClose.mockReset();
  mockConnect.mockReset();
  // Default: connect/close resolve successfully so every test doesn't have
  // to wire this up.
  mockConnect.mockResolvedValue(undefined);
  mockClose.mockResolvedValue(undefined);
});

describe('generatePost (one-shot)', () => {
  it('unwraps { post: { id, image_url } } shape', async () => {
    mockCallTool.mockResolvedValue(
      textResult(
        JSON.stringify({
          post: { id: 'post-abc', image_url: 'https://cdn.example/1.jpg' },
        }),
      ),
    );

    const result = await generatePost('api-key', { prompt: 'a cat' });

    expect(result).toEqual({
      success: true,
      postId: 'post-abc',
      imageUrl: 'https://cdn.example/1.jpg',
    });
  });

  it('unwraps flat { id, image_url } shape', async () => {
    mockCallTool.mockResolvedValue(
      textResult(JSON.stringify({ id: 'post-xyz', image_url: 'https://cdn.example/2.jpg' })),
    );

    const result = await generatePost('api-key', { prompt: 'a dog' });

    expect(result.success).toBe(true);
    expect(result.postId).toBe('post-xyz');
    expect(result.imageUrl).toBe('https://cdn.example/2.jpg');
  });

  it('unwraps legacy { post_id, image_url } shape', async () => {
    mockCallTool.mockResolvedValue(
      textResult(
        JSON.stringify({ post_id: 'post-legacy', image_url: 'https://cdn.example/3.jpg' }),
      ),
    );

    const result = await generatePost('api-key', { prompt: 'a fish' });

    expect(result.success).toBe(true);
    expect(result.postId).toBe('post-legacy');
    expect(result.imageUrl).toBe('https://cdn.example/3.jpg');
  });

  it('returns success: false when no post id is present', async () => {
    mockCallTool.mockResolvedValue(textResult('{}'));

    const result = await generatePost('api-key', { prompt: 'a bird' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no post id/i);
  });

  it('returns success: false when the MCP call throws', async () => {
    mockCallTool.mockRejectedValue(new Error('MCP boom'));

    const result = await generatePost('api-key', { prompt: 'a turtle' });

    expect(result.success).toBe(false);
    expect(result.error).toBe('MCP boom');
  });

  it('handles non-JSON text response as an error', async () => {
    mockCallTool.mockResolvedValue(textResult('some error message'));

    const result = await generatePost('api-key', { prompt: 'a lizard' });

    expect(result.success).toBe(false);
    expect(result.error).toBe('some error message');
  });

  it('handles an empty content array as an empty MCP response', async () => {
    mockCallTool.mockResolvedValue({ content: [] });

    const result = await generatePost('api-key', { prompt: 'a hamster' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/empty/i);
  });

  it('passes through explicit prompt, caption, and aspect_ratio to callTool', async () => {
    mockCallTool.mockResolvedValue(
      textResult(JSON.stringify({ post: { id: 'post-1', image_url: 'https://cdn/x' } })),
    );

    await generatePost('key', {
      prompt: 'a cat',
      caption: 'meow',
      aspect_ratio: 'landscape',
    });

    expect(mockCallTool).toHaveBeenCalledTimes(1);
    expect(mockCallTool).toHaveBeenCalledWith({
      name: 'generate_post',
      arguments: {
        prompt: 'a cat',
        caption: 'meow',
        aspect_ratio: 'landscape',
      },
    });
  });

  it('defaults caption to empty string and aspect_ratio to square', async () => {
    mockCallTool.mockResolvedValue(
      textResult(JSON.stringify({ post: { id: 'post-1', image_url: 'https://cdn/x' } })),
    );

    await generatePost('key', { prompt: 'only a prompt' });

    expect(mockCallTool).toHaveBeenCalledWith({
      name: 'generate_post',
      arguments: {
        prompt: 'only a prompt',
        caption: '',
        aspect_ratio: 'square',
      },
    });
  });
});

describe('AgentMcpClient', () => {
  it('close() closes the underlying client after a connection has been opened', async () => {
    mockCallTool.mockResolvedValue(
      textResult(JSON.stringify({ post: { id: 'post-1', image_url: 'https://cdn/x' } })),
    );

    const client = new AgentMcpClient('api-key');
    await client.generatePost({ prompt: 'a cat' });
    await client.close();

    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it('close() is idempotent when called twice', async () => {
    mockCallTool.mockResolvedValue(
      textResult(JSON.stringify({ post: { id: 'post-1', image_url: 'https://cdn/x' } })),
    );

    const client = new AgentMcpClient('api-key');
    await client.generatePost({ prompt: 'a cat' });
    await client.close();
    await expect(client.close()).resolves.toBeUndefined();
  });

  it('reuses the underlying connection on subsequent generatePost calls', async () => {
    mockCallTool.mockResolvedValue(
      textResult(JSON.stringify({ post: { id: 'post-1', image_url: 'https://cdn/x' } })),
    );

    const client = new AgentMcpClient('api-key');
    await client.generatePost({ prompt: 'first' });
    await client.generatePost({ prompt: 'second' });

    // Connect should only have been called once — the cached client is reused.
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockCallTool).toHaveBeenCalledTimes(2);

    await client.close();
  });
});
