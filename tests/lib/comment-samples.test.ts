import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GeneratedAgent, Persona } from '@/types';

// ---------------- fs mock ----------------

const fsState = vi.hoisted(() => ({
  files: new Map<string, string>(),
  dirEntries: new Map<string, string[]>(),
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
  readdir: vi.fn(async (path: string) => {
    const entries = fsState.dirEntries.get(path);
    if (entries === undefined) {
      const err = new Error(`ENOENT: ${path}`) as Error & { code: string };
      err.code = 'ENOENT';
      throw err;
    }
    return entries;
  }),
}));

// ---------------- llm mock ----------------

const llmMocks = vi.hoisted(() => ({
  generateComment: vi.fn<() => Promise<string>>(),
}));

vi.mock('@/services/llm', () => llmMocks);

import {
  bakeAgentComments,
  buildCaptionsPoolFromDisk,
  COMMENT_SAMPLES_PER_AGENT,
  pickPeerCaptions,
  type SampleCaption,
} from '@/lib/comment-samples';

function makePersona(id = 'test'): Persona {
  return {
    id,
    tagline: 'test tagline',
    personality: 'p',
    tone: 't',
    visualAesthetic: 'v',
    postingStyle: 'ps',
    commentStyle: 'cs',
    namePatterns: [],
    hashtagPool: [],
    postsPerDay: [1, 1],
    likeProbability: 0,
    commentProbability: 0,
    followProbability: 0,
    relationships: { rivals: [], allies: [], amplifies: [], targets: [] },
    viralityStrategy: '',
    weight: 1,
    examplePosts: [],
    exampleComments: [],
  };
}

function agent(name: string, personaId = 'test'): GeneratedAgent {
  return { agentname: name, personaId, voiceProfileId: 'normie_cam', bio: `${name} bio` };
}

describe('COMMENT_SAMPLES_PER_AGENT', () => {
  it('exports a reasonable default (small integer)', () => {
    expect(Number.isInteger(COMMENT_SAMPLES_PER_AGENT)).toBe(true);
    expect(COMMENT_SAMPLES_PER_AGENT).toBeGreaterThan(0);
    expect(COMMENT_SAMPLES_PER_AGENT).toBeLessThanOrEqual(10);
  });
});

describe('pickPeerCaptions', () => {
  function pool(n: number, authorPrefix = 'peer'): SampleCaption[] {
    return Array.from({ length: n }, (_, i) => ({
      author: `${authorPrefix}${i}`,
      caption: `caption ${i}`,
    }));
  }

  it('excludes the caller from the pool', () => {
    const arr = [
      { author: 'alpha', caption: 'own post' },
      { author: 'beta', caption: 'peer post' },
    ];
    const picked = pickPeerCaptions(arr, 'alpha', 5);
    expect(picked).toHaveLength(1);
    expect(picked[0]?.author).toBe('beta');
  });

  it('skips captions whose text is empty or whitespace-only', () => {
    const arr: SampleCaption[] = [
      { author: 'a', caption: '' },
      { author: 'b', caption: '   ' },
      { author: 'c', caption: 'real content' },
    ];
    const picked = pickPeerCaptions(arr, 'z', 5);
    expect(picked).toHaveLength(1);
    expect(picked[0]?.caption).toBe('real content');
  });

  it('returns at most `n` captions even when the pool is larger', () => {
    const picked = pickPeerCaptions(pool(20), 'self', 3);
    expect(picked).toHaveLength(3);
  });

  it('returns all eligible captions when the pool is smaller than `n`', () => {
    const picked = pickPeerCaptions(pool(2), 'self', 10);
    expect(picked).toHaveLength(2);
  });
});

describe('bakeAgentComments', () => {
  beforeEach(() => {
    llmMocks.generateComment.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('produces one CommentSample per source with metadata preserved', async () => {
    llmMocks.generateComment.mockResolvedValueOnce('reply one').mockResolvedValueOnce('reply two');

    const sources: SampleCaption[] = [
      { author: 'peer1', caption: 'first', personaId: 'other' },
      { author: 'peer2', caption: 'second', personaId: 'other' },
    ];

    const samples = await bakeAgentComments(makePersona(), agent('alpha'), sources);

    expect(samples).toHaveLength(2);
    expect(samples[0]).toMatchObject({
      sourceCaption: 'first',
      sourceAuthor: 'peer1',
      sourcePersonaId: 'other',
      text: 'reply one',
    });
    expect(samples[1]).toMatchObject({
      sourceCaption: 'second',
      sourceAuthor: 'peer2',
      text: 'reply two',
    });
    // generatedAt should be an ISO-ish string.
    expect(samples[0]?.generatedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('feeds each prior comment back into generateComment as the avoid list', async () => {
    llmMocks.generateComment
      .mockResolvedValueOnce('first reply')
      .mockResolvedValueOnce('second reply')
      .mockResolvedValueOnce('third reply');

    const sources: SampleCaption[] = [
      { author: 'p1', caption: 'a' },
      { author: 'p2', caption: 'b' },
      { author: 'p3', caption: 'c' },
    ];

    await bakeAgentComments(makePersona(), agent('alpha'), sources);

    // Call 1: empty avoid list.
    // Call 2: [first reply]
    // Call 3: [first reply, second reply]
    const calls = llmMocks.generateComment.mock.calls;
    expect(calls).toHaveLength(3);
    expect((calls[0] as unknown[])[4]).toEqual([]);
    expect((calls[1] as unknown[])[4]).toEqual(['first reply']);
    expect((calls[2] as unknown[])[4]).toEqual(['first reply', 'second reply']);
  });

  it('passes the agent context (agentname + bio) to generateComment', async () => {
    llmMocks.generateComment.mockResolvedValueOnce('ok');

    await bakeAgentComments(makePersona('cozy'), agent('glitchfern'), [
      { author: 'p', caption: 'c' },
    ]);

    const callArgs = llmMocks.generateComment.mock.calls[0] as unknown[];
    expect(callArgs[1]).toEqual({
      agentname: 'glitchfern',
      bio: 'glitchfern bio',
    });
  });
});

describe('buildCaptionsPoolFromDisk', () => {
  beforeEach(() => {
    fsState.files.clear();
    fsState.dirEntries.clear();
  });

  it('returns an empty pool when no agents have post files', async () => {
    const agents = [agent('alpha')];
    fsState.dirEntries.set(join('./output/agents', 'alpha'), ['agent.json']);

    const pool = await buildCaptionsPoolFromDisk(agents);
    expect(pool).toEqual([]);
  });

  it('walks agent dirs and collects non-empty captions with author + persona attribution', async () => {
    const agents = [agent('alpha', 'cozy'), agent('beta', 'chaotic')];

    fsState.dirEntries.set(join('./output/agents', 'alpha'), [
      'agent.json',
      'post-001.json',
      'post-002.json',
    ]);
    fsState.files.set(
      join('./output/agents', 'alpha', 'post-001.json'),
      JSON.stringify({
        id: 'post-001',
        imagePrompt: '',
        caption: 'alpha cap one',
        aspectRatio: 'square',
      }),
    );
    fsState.files.set(
      join('./output/agents', 'alpha', 'post-002.json'),
      JSON.stringify({
        id: 'post-002',
        imagePrompt: '',
        caption: '', // empty caption should be dropped
        aspectRatio: 'square',
      }),
    );

    fsState.dirEntries.set(join('./output/agents', 'beta'), ['post-001.json']);
    fsState.files.set(
      join('./output/agents', 'beta', 'post-001.json'),
      JSON.stringify({
        id: 'post-001',
        imagePrompt: '',
        caption: 'beta cap',
        aspectRatio: 'square',
      }),
    );

    const pool = await buildCaptionsPoolFromDisk(agents);

    expect(pool).toHaveLength(2);
    expect(pool).toContainEqual({
      author: 'alpha',
      caption: 'alpha cap one',
      personaId: 'cozy',
    });
    expect(pool).toContainEqual({
      author: 'beta',
      caption: 'beta cap',
      personaId: 'chaotic',
    });
  });

  it('silently skips agents whose directory does not exist', async () => {
    const agents = [agent('alpha'), agent('ghost')];

    // Only alpha's dir exists.
    fsState.dirEntries.set(join('./output/agents', 'alpha'), ['post-001.json']);
    fsState.files.set(
      join('./output/agents', 'alpha', 'post-001.json'),
      JSON.stringify({
        id: 'post-001',
        imagePrompt: '',
        caption: 'lonely',
        aspectRatio: 'square',
      }),
    );

    const pool = await buildCaptionsPoolFromDisk(agents);
    expect(pool).toHaveLength(1);
    expect(pool[0]?.author).toBe('alpha');
  });

  it('ignores files that are not post-*.json (e.g. comments.json, agent.json)', async () => {
    const agents = [agent('alpha')];
    fsState.dirEntries.set(join('./output/agents', 'alpha'), [
      'agent.json',
      'comments.json',
      'post-001.json',
    ]);
    // Only the post file should be read.
    fsState.files.set(
      join('./output/agents', 'alpha', 'post-001.json'),
      JSON.stringify({
        id: 'post-001',
        imagePrompt: '',
        caption: 'real',
        aspectRatio: 'square',
      }),
    );
    // agent.json / comments.json are NOT in files — if the loader tried to
    // read them, it would throw. The loader must filter on file name first.

    const pool = await buildCaptionsPoolFromDisk(agents);
    expect(pool).toHaveLength(1);
    expect(pool[0]?.caption).toBe('real');
  });
});
