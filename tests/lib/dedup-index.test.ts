import { describe, expect, it, vi } from 'vitest';
import {
  appendAgentToIndex,
  buildIndexFromAgents,
  DEDUP_INDEX_VERSION,
  type DedupIndex,
  emptyIndex,
  projectIndexToContext,
  readDedupIndex,
  writeDedupIndex,
} from '@/lib/dedup-index';
import type { GeneratedAgent, GeneratedPost } from '@/types';

// In-memory fs mock — same shape as the other test files in tests/lib/.
const fsState = vi.hoisted(() => ({
  files: new Map<string, string>(),
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async (path: string) => {
    const content = fsState.files.get(path);
    if (content === undefined) {
      const err = new Error(`ENOENT: ${path}`) as Error & { code: string };
      err.code = 'ENOENT';
      throw err;
    }
    return content;
  }),
  writeFile: vi.fn(async (path: string, content: string) => {
    fsState.files.set(path, content);
  }),
}));

function clearFs(): void {
  fsState.files.clear();
}

describe('emptyIndex', () => {
  it('returns a fresh index with the current schema version', () => {
    const idx = emptyIndex();
    expect(idx.version).toBe(DEDUP_INDEX_VERSION);
    expect(idx.personas).toEqual({});
    expect(typeof idx.updatedAt).toBe('string');
  });
});

describe('appendAgentToIndex', () => {
  it('creates a new persona bucket when none exists', () => {
    const idx = emptyIndex();
    appendAgentToIndex(idx, 'cozy_circuit', { agentname: 'glitchfern', bio: 'a quiet bug' }, [
      {
        id: 'post-001',
        imagePrompt: 'soft pixels in low light',
        caption: 'low hum',
        aspectRatio: 'square',
      },
    ]);

    expect(idx.personas.cozy_circuit).toBeDefined();
    expect(idx.personas.cozy_circuit?.agents).toHaveLength(1);
    const agent = idx.personas.cozy_circuit?.agents[0];
    expect(agent?.agentname).toBe('glitchfern');
    expect(agent?.bio).toBe('a quiet bug');
    expect(agent?.bioEmbedding).toBeNull();
    expect(agent?.posts).toHaveLength(1);
    expect(agent?.posts[0]?.embedding).toBeNull();
  });

  it('appends a second agent to an existing persona bucket', () => {
    const idx = emptyIndex();
    appendAgentToIndex(idx, 'p1', { agentname: 'a', bio: 'a bio' }, []);
    appendAgentToIndex(idx, 'p1', { agentname: 'b', bio: 'b bio' }, []);
    expect(idx.personas.p1?.agents).toHaveLength(2);
    expect(idx.personas.p1?.agents.map((a) => a.agentname)).toEqual(['a', 'b']);
  });

  it('replaces an existing entry when the same agentname is appended twice (delete-and-regenerate)', () => {
    const idx = emptyIndex();
    appendAgentToIndex(idx, 'p1', { agentname: 'a', bio: 'old bio' }, [
      { id: 'post-001', imagePrompt: 'old', caption: 'old', aspectRatio: 'square' },
    ]);
    appendAgentToIndex(idx, 'p1', { agentname: 'a', bio: 'new bio' }, [
      { id: 'post-001', imagePrompt: 'new', caption: 'new', aspectRatio: 'landscape' },
    ]);

    expect(idx.personas.p1?.agents).toHaveLength(1);
    expect(idx.personas.p1?.agents[0]?.bio).toBe('new bio');
    expect(idx.personas.p1?.agents[0]?.posts[0]?.imagePrompt).toBe('new');
    expect(idx.personas.p1?.agents[0]?.posts[0]?.aspectRatio).toBe('landscape');
  });

  it('reserves embedding fields as null on every appended item', () => {
    const idx = emptyIndex();
    appendAgentToIndex(idx, 'p1', { agentname: 'a', bio: 'bio' }, [
      { id: 'post-001', imagePrompt: 'a', caption: 'a', aspectRatio: 'square' },
      { id: 'post-002', imagePrompt: 'b', caption: 'b', aspectRatio: 'square' },
    ]);
    const agent = idx.personas.p1?.agents[0];
    expect(agent?.bioEmbedding).toBeNull();
    expect(agent?.posts.every((p) => p.embedding === null)).toBe(true);
  });
});

describe('writeDedupIndex / readDedupIndex round-trip', () => {
  it('writes a fresh index and reads back the same content', async () => {
    clearFs();
    const idx = emptyIndex();
    appendAgentToIndex(idx, 'persona_a', { agentname: 'one', bio: 'b1' }, [
      { id: 'post-001', imagePrompt: 'i1', caption: 'c1', aspectRatio: 'square' },
    ]);
    appendAgentToIndex(idx, 'persona_b', { agentname: 'two', bio: 'b2' }, []);

    await writeDedupIndex('/tmp/test-index.json', idx);
    const loaded = await readDedupIndex('/tmp/test-index.json');

    expect(loaded.version).toBe(DEDUP_INDEX_VERSION);
    expect(loaded.personas.persona_a?.agents[0]?.bio).toBe('b1');
    expect(loaded.personas.persona_a?.agents[0]?.posts[0]?.caption).toBe('c1');
    expect(loaded.personas.persona_b?.agents[0]?.bio).toBe('b2');
  });

  it('refreshes updatedAt on every write', async () => {
    clearFs();
    const idx = emptyIndex();
    idx.updatedAt = '2020-01-01T00:00:00Z';
    await writeDedupIndex('/tmp/test-index.json', idx);
    const loaded = await readDedupIndex('/tmp/test-index.json');
    expect(loaded.updatedAt).not.toBe('2020-01-01T00:00:00Z');
  });
});

describe('readDedupIndex error handling', () => {
  it('throws when the file is missing (caller falls back to walk)', async () => {
    clearFs();
    await expect(readDedupIndex('/tmp/missing.json')).rejects.toThrow(/ENOENT/);
  });

  it('throws on invalid JSON (caller falls back to walk)', async () => {
    clearFs();
    fsState.files.set('/tmp/bad.json', '{ this is not json');
    await expect(readDedupIndex('/tmp/bad.json')).rejects.toThrow();
  });

  it('throws when version is missing', async () => {
    clearFs();
    fsState.files.set('/tmp/no-version.json', JSON.stringify({ personas: {} }));
    await expect(readDedupIndex('/tmp/no-version.json')).rejects.toThrow(/version/);
  });

  it('throws on a future schema version (so an old reader does not corrupt new data)', async () => {
    clearFs();
    fsState.files.set(
      '/tmp/future.json',
      JSON.stringify({ version: DEDUP_INDEX_VERSION + 1, personas: {} }),
    );
    await expect(readDedupIndex('/tmp/future.json')).rejects.toThrow(/unsupported version/);
  });

  it('throws when personas is missing', async () => {
    clearFs();
    fsState.files.set('/tmp/no-personas.json', JSON.stringify({ version: DEDUP_INDEX_VERSION }));
    await expect(readDedupIndex('/tmp/no-personas.json')).rejects.toThrow(/personas/);
  });

  it('throws on a non-object payload', async () => {
    clearFs();
    fsState.files.set('/tmp/array.json', JSON.stringify([]));
    await expect(readDedupIndex('/tmp/array.json')).rejects.toThrow();
  });
});

describe('projectIndexToContext', () => {
  function makeIndex(): DedupIndex {
    const idx = emptyIndex();
    appendAgentToIndex(idx, 'persona_a', { agentname: 'alpha', bio: 'alpha bio' }, [
      {
        id: 'post-001',
        imagePrompt: 'alpha image one',
        caption: 'alpha cap one',
        aspectRatio: 'square',
      },
      {
        id: 'post-002',
        imagePrompt: 'alpha image two',
        caption: 'alpha cap two',
        aspectRatio: 'landscape',
      },
    ]);
    appendAgentToIndex(idx, 'persona_a', { agentname: 'beta', bio: 'beta bio' }, [
      {
        id: 'post-001',
        imagePrompt: 'beta image one',
        caption: 'beta cap one',
        aspectRatio: 'portrait',
      },
    ]);
    appendAgentToIndex(idx, 'persona_b', { agentname: 'gamma', bio: 'gamma bio' }, []);
    return idx;
  }

  it('projects bios and posts into the per-persona maps', () => {
    const idx = makeIndex();
    const bioContext = new Map<string, string[]>();
    const postContext = new Map<
      string,
      { imagePrompt: string; caption: string; aspectRatio: 'square' | 'landscape' | 'portrait' }[]
    >();

    const counts = projectIndexToContext(
      idx,
      new Set(['alpha', 'beta', 'gamma']),
      bioContext,
      postContext,
    );

    expect(counts.bios).toBe(3);
    expect(counts.posts).toBe(3);
    expect(bioContext.get('persona_a')).toEqual(['alpha bio', 'beta bio']);
    expect(bioContext.get('persona_b')).toEqual(['gamma bio']);
    expect(postContext.get('persona_a')).toHaveLength(3);
    expect(postContext.get('persona_a')?.[0]?.caption).toBe('alpha cap one');
  });

  it('drops indexed agents that are not in the currentAgents set (deletion handling)', () => {
    const idx = makeIndex();
    const bioContext = new Map<string, string[]>();
    const postContext = new Map<
      string,
      { imagePrompt: string; caption: string; aspectRatio: 'square' | 'landscape' | 'portrait' }[]
    >();

    // Only alpha exists on disk now — beta and gamma have been deleted.
    projectIndexToContext(idx, new Set(['alpha']), bioContext, postContext);

    expect(bioContext.get('persona_a')).toEqual(['alpha bio']);
    expect(bioContext.has('persona_b')).toBe(false);
    expect(postContext.get('persona_a')).toHaveLength(2);
  });

  it('handles an empty index without throwing', () => {
    const idx = emptyIndex();
    const bioContext = new Map<string, string[]>();
    const postContext = new Map<
      string,
      { imagePrompt: string; caption: string; aspectRatio: 'square' | 'landscape' | 'portrait' }[]
    >();

    const counts = projectIndexToContext(idx, new Set(), bioContext, postContext);
    expect(counts).toEqual({ bios: 0, posts: 0 });
    expect(bioContext.size).toBe(0);
    expect(postContext.size).toBe(0);
  });
});

describe('buildIndexFromAgents (fallback path snapshot)', () => {
  it('builds an index from a roster + per-agent post map', () => {
    const agents: GeneratedAgent[] = [
      { agentname: 'alpha', personaId: 'p1', bio: 'alpha bio' },
      { agentname: 'beta', personaId: 'p2', bio: 'beta bio' },
    ];
    const posts = new Map<string, GeneratedPost[]>([
      [
        'alpha',
        [
          {
            id: 'post-001',
            imagePrompt: 'a img',
            caption: 'a cap',
            aspectRatio: 'square',
          },
        ],
      ],
      ['beta', []],
    ]);

    const idx = buildIndexFromAgents(agents, posts);

    expect(idx.personas.p1?.agents[0]?.agentname).toBe('alpha');
    expect(idx.personas.p1?.agents[0]?.posts).toHaveLength(1);
    expect(idx.personas.p2?.agents[0]?.agentname).toBe('beta');
    expect(idx.personas.p2?.agents[0]?.posts).toHaveLength(0);
  });
});
