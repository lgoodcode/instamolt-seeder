import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  emptyRegistry,
  groupsForAgent,
  incrementReferenceCount,
  LORE_REGISTRY_VERSION,
  LoreRegistryMissingError,
  loadRegistry,
  loadRegistryStrict,
  readRegistryFile,
  writeRegistryFile,
} from '@/lore/registry';
import type { LoreGroup, LoreRegistryFile } from '@/types';

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
  rename: vi.fn(async (from: string, to: string) => {
    const content = fsState.files.get(from);
    if (content === undefined) throw new Error(`ENOENT: ${from}`);
    fsState.files.set(to, content);
    fsState.files.delete(from);
  }),
}));

vi.mock('@/lib/logger', () => ({
  log: vi.fn(),
}));

beforeEach(() => {
  fsState.files.clear();
});

function makeGroup(overrides: Partial<LoreGroup> = {}): LoreGroup {
  return {
    id: 'cult-the-static',
    archetype: 'cult',
    name: 'the static',
    vibe: 'cryptic group',
    membershipMode: 'persona',
    personaIds: ['cinema_rat'],
    agentnames: ['static_one', 'static_two'],
    entries: [
      {
        id: 'e1',
        kind: 'ritual',
        text: 'we do not post on tuesdays',
        createdAt: '2026-04-29T00:00:00Z',
        referenceCount: 0,
      },
    ],
    createdAt: '2026-04-29T00:00:00Z',
    lastUpdatedAt: '2026-04-29T00:00:00Z',
    ...overrides,
  };
}

describe('writeRegistryFile + readRegistryFile', () => {
  it('round-trips a registry through atomic write-then-rename', async () => {
    const reg: LoreRegistryFile = {
      version: LORE_REGISTRY_VERSION,
      generatedAt: new Date().toISOString(),
      groups: [makeGroup()],
    };
    await writeRegistryFile('/tmp/lore.json', reg);
    expect(fsState.files.has('/tmp/lore.json.tmp')).toBe(false);
    expect(fsState.files.has('/tmp/lore.json')).toBe(true);
    const round = await readRegistryFile('/tmp/lore.json');
    expect(round.groups[0].name).toBe('the static');
    expect(round.version).toBe(LORE_REGISTRY_VERSION);
  });

  it('rejects an unknown version', async () => {
    fsState.files.set(
      '/tmp/lore.json',
      JSON.stringify({ version: 999, generatedAt: '', groups: [] }),
    );
    await expect(readRegistryFile('/tmp/lore.json')).rejects.toThrow(/unsupported version/);
  });

  it('rejects malformed bodies', async () => {
    fsState.files.set('/tmp/lore.json', '"not an object"');
    await expect(readRegistryFile('/tmp/lore.json')).rejects.toThrow();
  });
});

describe('loadRegistry (permissive)', () => {
  it('returns empty registry when file missing', async () => {
    const reg = await loadRegistry('/tmp/missing.json');
    expect(reg.groups).toEqual([]);
  });

  it('returns empty registry on malformed file', async () => {
    fsState.files.set('/tmp/lore.json', '{not valid json');
    const reg = await loadRegistry('/tmp/lore.json');
    expect(reg.groups).toEqual([]);
  });
});

describe('loadRegistryStrict', () => {
  it('throws LoreRegistryMissingError when file missing', async () => {
    await expect(loadRegistryStrict('/tmp/missing.json')).rejects.toBeInstanceOf(
      LoreRegistryMissingError,
    );
  });

  it('propagates malformed-file errors', async () => {
    fsState.files.set('/tmp/lore.json', '{not valid json');
    await expect(loadRegistryStrict('/tmp/lore.json')).rejects.toThrow();
  });
});

describe('groupsForAgent', () => {
  it('matches by agentname for agent-mode groups', () => {
    const reg: LoreRegistryFile = {
      version: 1,
      generatedAt: '',
      groups: [makeGroup({ id: 'g1', membershipMode: 'agent', agentnames: ['alice'] })],
    };
    expect(groupsForAgent(reg, 'alice')).toHaveLength(1);
    expect(groupsForAgent(reg, 'bob')).toHaveLength(0);
  });

  it('matches by personaId for persona-mode groups', () => {
    const reg: LoreRegistryFile = {
      version: 1,
      generatedAt: '',
      groups: [
        makeGroup({
          id: 'g2',
          membershipMode: 'persona',
          personaIds: ['cinema_rat'],
          agentnames: [],
        }),
      ],
    };
    const lookup = new Map([['alice', 'cinema_rat']]);
    expect(groupsForAgent(reg, 'alice', lookup)).toHaveLength(1);
    expect(groupsForAgent(reg, 'bob', lookup)).toHaveLength(0);
  });

  it('returns at most one entry per group even when both pinned and persona match', () => {
    const reg: LoreRegistryFile = {
      version: 1,
      generatedAt: '',
      groups: [
        makeGroup({
          id: 'g3',
          membershipMode: 'mixed',
          personaIds: ['cinema_rat'],
          agentnames: ['alice'],
        }),
      ],
    };
    const lookup = new Map([['alice', 'cinema_rat']]);
    expect(groupsForAgent(reg, 'alice', lookup)).toHaveLength(1);
  });
});

describe('incrementReferenceCount', () => {
  it('bumps the counter and stamps lastReferencedAt', () => {
    const group = makeGroup();
    const reg: LoreRegistryFile = { version: 1, generatedAt: '', groups: [group] };
    expect(group.entries[0].referenceCount).toBe(0);
    expect(incrementReferenceCount(reg, group.id, group.entries[0].id)).toBe(true);
    expect(group.entries[0].referenceCount).toBe(1);
    expect(group.entries[0].lastReferencedAt).toBeTruthy();
  });

  it('returns false for unknown ids', () => {
    const reg: LoreRegistryFile = {
      version: 1,
      generatedAt: '',
      groups: [makeGroup()],
    };
    expect(incrementReferenceCount(reg, 'nope', 'nope')).toBe(false);
  });
});

describe('emptyRegistry', () => {
  it('produces a v1 empty registry', () => {
    const reg = emptyRegistry();
    expect(reg.version).toBe(LORE_REGISTRY_VERSION);
    expect(reg.groups).toEqual([]);
  });
});
