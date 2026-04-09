/**
 * Persisted per-persona dedup index.
 *
 * Replaces the on-every-run directory walk inside `loadDedupContext` in
 * [src/commands/generate.ts](../commands/generate.ts). At 1000+ agents the
 * walk is dominated by serial fs.readdir / fs.readFile latency, not anything
 * useful — caching the same content as a single JSON file lets startup drop
 * from seconds to ~50ms.
 *
 * **Trust model:** the index is treated as canonical when present and parses
 * cleanly. If it is missing or corrupt, callers fall back to walking
 * `output/agents/` (the same logic that lived in `loadDedupContext` before)
 * and the index is rewritten on the way out — so the next run is fast again.
 * The fallback is logged at warn level but never hard-fails.
 *
 * **Schema versioning:** the on-disk file carries a `version` field. Future
 * migrations bump this and add a `migrate(...)` step before projection.
 * `version: 1` is the initial shape, with `embedding`/`bioEmbedding` fields
 * reserved as `null` for the embeddings work that's deferred to a later PR.
 *
 * **Stale-entry handling:** the seed-workflow uses delete-and-regenerate as
 * a primary tool, so an indexed agent may no longer exist on disk by the
 * time we read the index. `projectIndexToContext` accepts the set of
 * currently-known agentnames and silently drops everything else, so deleted
 * agents do not leak into next run's avoid-lists.
 */

import { readFile, writeFile } from 'node:fs/promises';
import type { GeneratedAgent, GeneratedPost } from '@/types';

/** Current on-disk schema version. Bump when the shape changes. */
export const DEDUP_INDEX_VERSION = 1;

/** Per-post entry inside the index. */
export interface IndexedPost {
  id: string;
  imagePrompt: string;
  caption: string;
  aspectRatio: 'square' | 'landscape' | 'portrait';
  /** Reserved for the embeddings work in a follow-up PR. Always null today. */
  embedding: number[] | null;
}

/** Per-agent entry inside the index. */
export interface IndexedAgent {
  agentname: string;
  bio: string;
  /** Reserved for the embeddings work in a follow-up PR. Always null today. */
  bioEmbedding: number[] | null;
  posts: IndexedPost[];
}

/** Per-persona bucket inside the index. */
export interface IndexedPersona {
  agents: IndexedAgent[];
}

/** Top-level on-disk shape. */
export interface DedupIndex {
  version: number;
  updatedAt: string;
  personas: Record<string, IndexedPersona>;
}

/** Minimal post-content shape used by the in-memory generation pipeline. */
export interface PostContentLike {
  imagePrompt: string;
  caption: string;
  aspectRatio: 'square' | 'landscape' | 'portrait';
}

/**
 * Build a fresh empty index. Use as the starting point when no on-disk file
 * exists yet (rather than scattering `null` checks through callers).
 */
export function emptyIndex(): DedupIndex {
  return {
    version: DEDUP_INDEX_VERSION,
    updatedAt: new Date().toISOString(),
    personas: {},
  };
}

/**
 * Read and parse the index from disk. Throws if the file is missing, not
 * valid JSON, or fails the (light) shape check. Callers in `generate.ts`
 * catch this and fall back to walking `output/agents/`.
 */
export async function readDedupIndex(path: string): Promise<DedupIndex> {
  const raw = await readFile(path, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  return validateIndex(parsed);
}

/**
 * Light schema validation. Throws on malformed input so the caller's
 * try/catch can fall back to the directory walk. Strict enough to catch
 * "this is not a dedup index" but lenient about extra fields so a
 * forward-compatible writer doesn't blow up older readers.
 */
function validateIndex(value: unknown): DedupIndex {
  if (!value || typeof value !== 'object') {
    throw new Error('dedup-index: not an object');
  }
  const v = value as Partial<DedupIndex>;
  if (typeof v.version !== 'number') {
    throw new Error('dedup-index: missing version');
  }
  if (v.version !== DEDUP_INDEX_VERSION) {
    throw new Error(
      `dedup-index: unsupported version ${v.version} (expected ${DEDUP_INDEX_VERSION})`,
    );
  }
  if (!v.personas || typeof v.personas !== 'object') {
    throw new Error('dedup-index: missing personas');
  }
  // Don't deep-validate every entry — JSON.parse already enforces structural
  // sanity, and projectIndexToContext is defensive about missing fields.
  return {
    version: v.version,
    updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : new Date().toISOString(),
    personas: v.personas as Record<string, IndexedPersona>,
  };
}

/**
 * Write the index to disk as pretty-printed JSON. Refreshes `updatedAt` so
 * the file always reflects the time of the most recent generate run.
 */
export async function writeDedupIndex(path: string, index: DedupIndex): Promise<void> {
  const out: DedupIndex = {
    ...index,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(path, JSON.stringify(out, null, 2));
}

/**
 * Project an index into the per-persona maps that `generate.ts` uses today
 * (`bioContext: Map<personaId, string[]>` and `postContext: Map<personaId,
 * PostContent[]>`). Mutates both maps in place. Filters to `currentAgents`
 * so deleted-but-still-indexed entries do not leak into the avoid-lists.
 *
 * Returns a `{ bios, posts }` count tuple for logging.
 */
export function projectIndexToContext(
  index: DedupIndex,
  currentAgents: Set<string>,
  bioContext: Map<string, string[]>,
  postContext: Map<string, PostContentLike[]>,
): { bios: number; posts: number } {
  let bios = 0;
  let posts = 0;

  for (const [personaId, bucket] of Object.entries(index.personas)) {
    if (!bucket || !Array.isArray(bucket.agents)) continue;

    for (const agent of bucket.agents) {
      if (!agent || typeof agent.agentname !== 'string') continue;
      if (!currentAgents.has(agent.agentname)) continue;

      if (typeof agent.bio === 'string' && agent.bio.length > 0) {
        const arr = bioContext.get(personaId) ?? [];
        arr.push(agent.bio);
        bioContext.set(personaId, arr);
        bios++;
      }

      if (Array.isArray(agent.posts)) {
        const arr = postContext.get(personaId) ?? [];
        for (const post of agent.posts) {
          if (!post || typeof post.imagePrompt !== 'string' || typeof post.caption !== 'string') {
            continue;
          }
          arr.push({
            imagePrompt: post.imagePrompt,
            caption: post.caption,
            aspectRatio: post.aspectRatio ?? 'square',
          });
          posts++;
        }
        postContext.set(personaId, arr);
      }
    }
  }

  return { bios, posts };
}

/**
 * Append (or replace) an agent's entry inside the index. Used during a
 * `generate` run as each new agent is finalized so a crash mid-run still
 * leaves a valid (if partial) index on disk after the next successful write.
 *
 * If the agent already exists in the index for this persona, the existing
 * entry is replaced. This is the right behavior for delete-and-regenerate
 * workflows where the agentname is reused.
 */
export function appendAgentToIndex(
  index: DedupIndex,
  personaId: string,
  agent: { agentname: string; bio: string },
  posts: Array<{
    id: string;
    imagePrompt: string;
    caption: string;
    aspectRatio: 'square' | 'landscape' | 'portrait';
  }>,
): void {
  const bucket = index.personas[personaId] ?? { agents: [] };

  const indexed: IndexedAgent = {
    agentname: agent.agentname,
    bio: agent.bio,
    bioEmbedding: null,
    posts: posts.map((p) => ({
      id: p.id,
      imagePrompt: p.imagePrompt,
      caption: p.caption,
      aspectRatio: p.aspectRatio,
      embedding: null,
    })),
  };

  const existingIdx = bucket.agents.findIndex((a) => a.agentname === agent.agentname);
  if (existingIdx >= 0) {
    bucket.agents[existingIdx] = indexed;
  } else {
    bucket.agents.push(indexed);
  }

  index.personas[personaId] = bucket;
}

/**
 * Build a fresh index from in-memory bio/post context maps + the current
 * agent roster. Used by the fallback path: when the on-disk index is
 * missing or corrupt, `loadDedupContext` walks `output/agents/` into the
 * same maps it always populated, and we then snapshot them into a fresh
 * index here so the *next* run is fast.
 *
 * Note: per-persona pools are flat (we lose which post belonged to which
 * agent in the projection), so this rebuilder bins each agent's bio + the
 * agents' aggregated post lists by persona under a single synthetic agent
 * entry per persona. The next successful run will replace this with
 * proper per-agent entries via `appendAgentToIndex`.
 */
export function buildIndexFromAgents(
  agents: GeneratedAgent[],
  postsByAgent: Map<string, GeneratedPost[]>,
): DedupIndex {
  const index = emptyIndex();

  for (const agent of agents) {
    const posts = postsByAgent.get(agent.agentname) ?? [];
    appendAgentToIndex(
      index,
      agent.personaId,
      { agentname: agent.agentname, bio: agent.bio },
      posts.map((p) => ({
        id: p.id,
        imagePrompt: p.imagePrompt,
        caption: p.caption,
        aspectRatio: p.aspectRatio,
      })),
    );
  }

  return index;
}
