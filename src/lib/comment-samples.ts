/**
 * Comment-sample baking helpers, shared by `generate` (Option A — writes
 * `output/agents/<name>/comments.json`) and `preview-comments` (Option B —
 * prints to terminal, no writes).
 *
 * Lives in `lib/` rather than `services/` because it composes the LLM service
 * with seeder-specific picking logic — there's no external integration here.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '@/config';
import { type CommentAgentContext, generateComment } from '@/services/llm';
import type { CommentSample, GeneratedAgent, GeneratedPost, Persona } from '@/types';

/** How many comment samples we bake per agent during `generate`. */
export const COMMENT_SAMPLES_PER_AGENT = 3;

/**
 * One caption pulled from somewhere — disk, an in-memory post pool, or the
 * live explore feed. Author is whatever made sense for the source: a peer
 * agentname for synthetic samples, `'feed'` for `--from-feed` previews.
 */
export interface SampleCaption {
  author: string;
  caption: string;
  /** Optional — set when the caption came from a known same-run agent. */
  personaId?: string;
}

/**
 * Walk every agent directory under `output/agents/` and collect their post
 * captions into a flat pool with author + persona attribution. Used by
 * `generate`'s comment-baking pass and by `preview-comments` (default mode).
 *
 * Does not throw on per-agent read failures — bad files are skipped so a
 * single corrupt post doesn't poison the entire pool.
 */
export async function buildCaptionsPoolFromDisk(
  agents: GeneratedAgent[],
): Promise<SampleCaption[]> {
  const pool: SampleCaption[] = [];

  for (const agent of agents) {
    let files: string[];
    try {
      files = await readdir(join(config.agentsDir, agent.agentname));
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.startsWith('post-') || !file.endsWith('.json')) continue;
      try {
        const raw = await readFile(join(config.agentsDir, agent.agentname, file), 'utf-8');
        const post = JSON.parse(raw) as GeneratedPost;
        if (post.caption && post.caption.trim().length > 0) {
          pool.push({
            author: agent.agentname,
            caption: post.caption,
            personaId: agent.personaId,
          });
        }
      } catch {}
    }
  }

  return pool;
}

/**
 * Pick `n` random captions from the pool, skipping any whose author matches
 * `excludeAuthor` (so an agent never comments on its own post). Empty captions
 * are also dropped.
 */
export function pickPeerCaptions(
  pool: SampleCaption[],
  excludeAuthor: string,
  n: number,
): SampleCaption[] {
  const eligible = pool.filter((c) => c.author !== excludeAuthor && c.caption.trim().length > 0);

  // Fisher-Yates shuffle, then take the first `n`. Cap n to pool size so we
  // never return more than what's available.
  const arr = [...eligible];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, Math.min(n, arr.length));
}

/**
 * Generate `sources.length` comments for `agent` against the supplied
 * captions. Each call sees the running list of comments already produced
 * for this agent in this batch as the avoid-list, so the agent doesn't
 * repeat verbal tics across its samples.
 *
 * Returns the comments as `CommentSample` records so the caller can either
 * write them to disk (`generate`) or render them to terminal (`preview-comments`).
 */
export async function bakeAgentComments(
  persona: Persona,
  agent: CommentAgentContext,
  sources: SampleCaption[],
): Promise<CommentSample[]> {
  const samples: CommentSample[] = [];
  const priorTexts: string[] = [];

  // Narrow to the fields `generateComment` actually uses. TypeScript is
  // structurally typed so a full `GeneratedAgent` would pass, but we want
  // the runtime object to match the type exactly so test assertions on
  // mock call args stay clean.
  const agentCtx: CommentAgentContext = { agentname: agent.agentname, bio: agent.bio };

  for (const source of sources) {
    // Snapshot the avoid list at call time — same pattern as
    // generate.ts's similarity gate. Without this, vitest (and any other
    // caller inspecting mock args) would see the *final* mutated state.
    const text = await generateComment(persona, agentCtx, source.caption, source.author, [
      ...priorTexts,
    ]);
    samples.push({
      sourceCaption: source.caption,
      sourceAuthor: source.author,
      sourcePersonaId: source.personaId,
      text,
      generatedAt: new Date().toISOString(),
    });
    priorTexts.push(text);
  }

  return samples;
}
