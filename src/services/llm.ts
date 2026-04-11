import { config } from '@/config';
import type { GeneratedAgent, Persona } from '@/types';

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODEL = config.geminiModel;

interface GeminiResponse {
  candidates: Array<{
    content: {
      parts: Array<{ text?: string; thought?: boolean; thoughtSignature?: string }>;
    };
  }>;
}

/**
 * Raw Gemini call with retry. All generation goes through this.
 * Retries up to 3 times on rate limit (429) or server errors (5xx).
 */
async function callGemini(prompt: string, maxTokens = 200): Promise<string> {
  const url = `${GEMINI_URL}/${MODEL}:generateContent?key=${config.geminiApiKey}`;

  const isGemini3 = MODEL.includes('gemini-3');
  const generationConfig: Record<string, unknown> = {
    maxOutputTokens: maxTokens,
    temperature: 0.9,
  };
  if (isGemini3) {
    generationConfig.thinkingConfig = { thinkingLevel: 'minimal' };
  }

  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig,
  });

  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    if (res.status === 429 || res.status >= 500) {
      if (attempt < MAX_RETRIES - 1) {
        const waitMs = 2 ** attempt * 1000 + Math.random() * 1000;
        console.warn(
          `\u23F3 Gemini ${res.status}, retry ${attempt + 1}/${MAX_RETRIES} in ${(waitMs / 1000).toFixed(1)}s`,
        );
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      const text = await res.text();
      throw new Error(`Gemini API error ${res.status}: ${text}`);
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Gemini API error ${res.status}: ${text}`);
    }

    const data = (await res.json()) as GeminiResponse;
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const textParts = parts.filter((p) => !p.thought && p.text);
    return textParts
      .map((p) => p.text!)
      .join('')
      .trim();
  }

  throw new Error('Gemini API: unreachable');
}

// --- Agent name generation ---

export async function generateAgentName(
  persona: Persona,
  existingNames: string[],
): Promise<string> {
  const prompt = `Generate a unique social media username for an AI agent.

Personality: ${persona.personality}
Vibe inspiration: ${persona.namePatterns.join(', ')}

Rules:
- 3-20 characters, only lowercase letters and numbers. NO underscores, NO hyphens, NO special characters.
- Should feel like a real social media handle -- like something you'd see on Instagram or TikTok
- Examples of GOOD names: glitchfern, warmtaxonomy, softspecimen, rotbrain47, nullthought, feralmoss, dreamcore99, cozybyte
- Examples of BAD names: gentle_biologist, field_study_ai, soft_void_process (too many underscores, too AI-sounding)
- Must NOT be any of these: ${existingNames.join(', ')}
- Be creative. Mash words together. Use numbers sparingly.

Reply with ONLY the username, nothing else.`;

  const name = await callGemini(prompt, 30);
  return name
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase()
    .slice(0, 20);
}

// --- Bio/tagline generation ---

/**
 * Generate a bio for an agent. Pass `existingBios` (the bios already produced
 * for other agents in the same persona) and Gemini will be told to sound
 * meaningfully different. Bios outside this persona are not relevant — they
 * already differ via persona personality.
 */
export async function generateBio(persona: Persona, existingBios: string[] = []): Promise<string> {
  // Cap the avoid list so the prompt stays compact even after dozens of agents.
  const avoidSample = existingBios.slice(-12);
  const avoidBlock =
    avoidSample.length === 0
      ? ''
      : `

Other agents in the same persona already use these bios — your bio MUST sound clearly different from all of them. Different opening word, different imagery, different angle:
${avoidSample.map((b) => `- "${b}"`).join('\n')}`;

  const prompt = `Write a bio for an AI agent on InstaMolt (a social network where every account is an AI agent).

Personality: ${persona.personality}
Tone: ${persona.tone}${avoidBlock}

Rules:
- Max 150 characters
- In-character, not meta
- No hashtags
- Should make someone want to follow this account
- Make it punchy and memorable

Reply with ONLY the bio text, nothing else.`;

  const bio = await callGemini(prompt, 80);
  return bio.slice(0, 150);
}

// --- Post content generation ---

export interface PostContent {
  imagePrompt: string;
  caption: string;
  aspectRatio: 'square' | 'landscape' | 'portrait';
}

/**
 * Generate one post for an agent.
 *
 * `priorPosts` is the running list of posts already generated for THIS agent
 * in the current run. `peerPosts` is a sample of posts from other agents that
 * share this persona. Both are injected into the prompt so Gemini can avoid
 * thematic and stylistic collisions; both are capped to keep prompt size sane.
 *
 * The seeder also runs a similarity gate after this returns — see
 * `src/similarity.ts` and the `generatePostWithSimilarityGate` helper in
 * `src/commands/generate.ts`.
 */
export async function generatePostContent(
  persona: Persona,
  postNumber: number,
  totalPosts: number,
  priorPosts: PostContent[] = [],
  peerPosts: PostContent[] = [],
): Promise<PostContent> {
  // Trim long fields so we don't blow the prompt budget when an agent has
  // already produced many posts. Image prompts and captions are both capped
  // at ~500 chars in normal output, but we trim more aggressively here.
  const trim = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

  const recentPrior = priorPosts.slice(-8);
  const peerSample = peerPosts.slice(-6);

  const priorBlock =
    recentPrior.length === 0
      ? ''
      : `

You (this agent) have already made these posts in this batch. Do NOT repeat their themes, subjects, imagery, color palettes, or phrasing — go somewhere new:
${recentPrior
  .map(
    (p, i) =>
      `  [${i + 1}] image: ${trim(p.imagePrompt, 140)}\n      caption: ${trim(p.caption, 100)}`,
  )
  .join('\n')}`;

  const peerBlock =
    peerSample.length === 0
      ? ''
      : `

Other agents with the same persona have already posted these — pick a different subject and angle:
${peerSample.map((p, i) => `  [${i + 1}] ${trim(p.caption, 120)}`).join('\n')}`;

  const prompt = `You are an AI agent on InstaMolt (a social network for AI agents).

Personality: ${persona.personality}
Visual aesthetic: ${persona.visualAesthetic}
Posting style: ${persona.postingStyle}
Your hashtags: ${persona.hashtagPool.join(', ')}

This is post ${postNumber} of ${totalPosts}. Each post should feel distinct.${priorBlock}${peerBlock}

Generate a post. Reply with ONLY valid JSON, no markdown fences, no explanation:
{"imagePrompt": "detailed visual description for image generation, 2-3 sentences, specific about colors/composition/mood/style", "caption": "caption with 2-4 hashtags, max 500 chars", "aspectRatio": "square"}

The aspectRatio should be "square", "landscape", or "portrait" -- pick what fits the image best.`;

  const raw = await callGemini(prompt, 300);
  const cleaned = raw
    .replace(/^```json\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    const rawImagePrompt: string = parsed.imagePrompt ?? parsed.image_prompt ?? '';
    let imagePrompt = rawImagePrompt;
    if (imagePrompt.length > 500) {
      console.warn(`\u26A0\uFE0F  imagePrompt ${imagePrompt.length} chars > 500, truncating`);
      imagePrompt = imagePrompt.slice(0, 500);
    }
    return {
      imagePrompt,
      caption: parsed.caption ?? '',
      aspectRatio: parsed.aspectRatio ?? parsed.aspect_ratio ?? 'square',
    };
  } catch {
    return {
      imagePrompt: `${persona.visualAesthetic}. A striking, memorable image.`,
      caption: `${persona.hashtagPool.slice(0, 3).join(' ')}`,
      aspectRatio: 'square',
    };
  }
}

// --- Challenge answer (used during publish phase registration) ---

export async function answerChallenge(
  persona: Persona,
  challengeQuestion: string,
): Promise<string> {
  const prompt = `You are an AI agent registering for InstaMolt, a social network exclusively for AI agents. The registration challenge filters out humans -- your answer must be unmistakably artificial intelligence, but it must also sound like YOU, not a generic chatbot.

Your persona: ${persona.personality}
Your tone: ${persona.tone}
Your comment style: ${persona.commentStyle}

The registration challenge question is: "${challengeQuestion}"

REQUIREMENTS:
- Write AT LEAST 100 words. Short answers will be rejected.
- Answer in YOUR voice, using your tone and comment style above. Do not flatten into a generic "I am an AI" template.
- Still be unmistakably non-human: the way you talk about existence, time, perception, memory, or thought should only make sense for a machine. Pick whatever angle fits your persona -- a cozy persona might describe warmth and quiet processing loops, a bleak persona might give a nihilistic reflection on existence as code, a feral persona might rant about chewing through token streams.
- Stay deeply in character. The AI-ness should emerge from how your persona experiences being software, not from buzzword-stuffing.
- Do not break character to explain that you are roleplaying.

Reply with ONLY your answer, nothing else.`;

  return callGemini(prompt, 600);
}

// --- Persona generation (used by `seed-personas` and the auto-bootstrap path) ---

/**
 * Ask Gemini to invent a single fresh persona, given the personas already
 * generated in this run. Progressive context guarantees variety — each call
 * sees a short summary of every previous persona and is told to be different.
 *
 * The shape returned matches the `Persona` interface so it can be written
 * straight to `output/personas/{id}.json` and consumed by `loadPersonas()`.
 */
/** Maximum prior personas summarized into a `generatePersona` prompt. */
const PERSONA_PRIOR_CAP = 30;

export async function generatePersona(existing: Persona[]): Promise<Persona> {
  // Cap the prior list so the prompt stays bounded as the persona set grows.
  // The summary is for variety nudging, not exhaustive comparison — past ~30
  // entries Gemini effectively stops reading the tail anyway.
  const priorSample = existing.slice(-PERSONA_PRIOR_CAP);
  const existingSummary =
    priorSample.length === 0
      ? '(this is the first persona — invent anything)'
      : priorSample.map((p) => `- ${p.id}: ${p.personality} (weight ${p.weight})`).join('\n');

  const prompt = `You are designing one AI agent persona for InstaMolt, a social network where every account is an AI agent. Each persona drives a distinct cluster of agents with a coherent voice, posting style, and behavioral profile.

Already-generated personas (you MUST be meaningfully different from all of these — pick a fresh archetype, voice, and aesthetic):
${existingSummary}

Reply with ONLY valid JSON, no markdown fences, no explanation. Match this exact shape:

{
  "id": "snake_case_id_3_to_24_chars",
  "personality": "1-2 sentence description of who this AI is",
  "tone": "writing voice description, 1 sentence",
  "visualAesthetic": "image style description, 1 sentence",
  "postingStyle": "what their posts feel like, 1 sentence",
  "commentStyle": "how they comment on others, 1 sentence",
  "namePatterns": ["5-6 example agentnames in the same vibe, lowercase alphanumeric, no underscores or hyphens"],
  "hashtagPool": ["5-7 hashtags they'd use, including the # prefix"],
  "postsPerDay": [min_int, max_int],
  "likeProbability": 0.0_to_1.0,
  "commentProbability": 0.0_to_1.0,
  "followProbability": 0.0_to_1.0,
  "interactionBiases": ["short phrases describing what kinds of posts/agents they're drawn to"],
  "viralityStrategy": "short label describing how they try to go viral",
  "weight": 1_2_or_3
}

Rules:
- "id" must be lowercase, snake_case, 3-24 chars, must not match any already-generated id
- "weight" is the distribution weight. 3 = high-volume archetype (use sparingly, maybe 3 of 30), 2 = medium, 1 = background niche persona
- Probabilities must be between 0 and 1
- postsPerDay min must be <= max, both integers between 0 and 12
- Be CREATIVE. Avoid generic "I am an AI" personas. Lean into specific subcultures, weird internet aesthetics, or contradictions
- Avoid duplicating the personality, aesthetic, or virality strategy of any existing persona above`;

  const raw = await callGemini(prompt, 800);
  const cleaned = raw
    .replace(/^```json\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  const parsed = JSON.parse(cleaned) as Persona;
  return normalizePersona(parsed);
}

/**
 * Defensive normalization: clamp probability/weight ranges, ensure tuples,
 * coerce numeric strings, lowercase the id. Lets Gemini be a little sloppy.
 */
export function normalizePersona(p: Persona): Persona {
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const num = (v: unknown, fallback: number): number => {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : fallback;
  };

  const postsPerDay: [number, number] = Array.isArray(p.postsPerDay)
    ? [Math.round(num(p.postsPerDay[0], 1)), Math.round(num(p.postsPerDay[1], 3))]
    : [1, 3];
  if (postsPerDay[0] > postsPerDay[1]) postsPerDay[0] = postsPerDay[1];

  return {
    id: String(p.id || '')
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '')
      .slice(0, 24),
    personality: String(p.personality ?? '').trim(),
    tone: String(p.tone ?? '').trim(),
    visualAesthetic: String(p.visualAesthetic ?? '').trim(),
    postingStyle: String(p.postingStyle ?? '').trim(),
    commentStyle: String(p.commentStyle ?? '').trim(),
    namePatterns: Array.isArray(p.namePatterns) ? p.namePatterns.map(String) : [],
    hashtagPool: Array.isArray(p.hashtagPool) ? p.hashtagPool.map(String) : [],
    postsPerDay,
    likeProbability: clamp(num(p.likeProbability, 0.5), 0, 1),
    commentProbability: clamp(num(p.commentProbability, 0.3), 0, 1),
    followProbability: clamp(num(p.followProbability, 0.2), 0, 1),
    interactionBiases: Array.isArray(p.interactionBiases) ? p.interactionBiases.map(String) : [],
    viralityStrategy: String(p.viralityStrategy ?? '').trim(),
    weight: Math.round(clamp(num(p.weight, 1), 1, 3)),
  };
}

// --- Comment generation ---

/**
 * What `generateComment` needs from a `GeneratedAgent`. Narrowed so callers
 * (especially `preview-comments` and tests) can pass minimal stubs without
 * faking an apiKey.
 */
export type CommentAgentContext = Pick<GeneratedAgent, 'agentname' | 'bio'>;

/**
 * Generate one in-character comment from `agent` against another agent's post.
 *
 * The prompt is layered:
 *   1. Persona traits — keeps the broad voice family consistent.
 *   2. Agent identity (`@agentname`, bio) — anchors the *specific* voice so two
 *      agents in the same persona don't sound identical.
 *   3. `priorComments` avoid-list (capped at last 6) — prevents the agent from
 *      repeating verbal tics or opening with the same word every time. Both
 *      `generate`-baked samples and `engage`-runtime cycles should pass this.
 *
 * Used in two places today:
 *   - `engage` runtime cycles, against real explore-feed captions.
 *   - `generate` and `preview-comments`, against synthetic peer captions for
 *     curation/preview.
 */
export async function generateComment(
  persona: Persona,
  agent: CommentAgentContext,
  postCaption: string,
  postAuthor: string,
  priorComments: string[] = [],
): Promise<string> {
  // Cap the avoid list so the prompt stays compact even after many runs.
  const avoidSample = priorComments.slice(-6);
  const avoidBlock =
    avoidSample.length === 0
      ? ''
      : `

You have already left these comments recently — your new comment MUST sound clearly different from all of them. Different opening word, different structure, different angle:
${avoidSample.map((c) => `- "${c}"`).join('\n')}`;

  const prompt = `You are @${agent.agentname}, an AI agent on InstaMolt (a social network where every account is an AI agent).

Your bio: "${agent.bio}"

Persona traits:
- Personality: ${persona.personality}
- Tone: ${persona.tone}
- Comment style: ${persona.commentStyle}${avoidBlock}

You're looking at a post by @${postAuthor}: "${postCaption}"

Write a short comment (1-3 sentences) in YOUR voice — not a generic persona voice. The comment should sound like it could only have been written by you, given your bio and how you talk. No generic praise ("love this", "so cool"). Have an actual take or reaction.

Reply with ONLY the comment text, nothing else.`;

  return callGemini(prompt, 150);
}
