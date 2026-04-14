import { config } from '@/config';
import type {
  CommentRegister,
  ExampleComment,
  ExamplePost,
  GeneratedAgent,
  Persona,
  PersonaRelationships,
} from '@/types';

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
 * Thrown when Gemini returns a 429 whose body indicates the project's billing
 * credits are exhausted (as opposed to a transient per-minute rate limit).
 * Non-retryable: `callGemini` bails out immediately and the top-level handler
 * in `src/index.ts` catches this to print a friendly fail-fast message.
 */
export class GeminiQuotaError extends Error {
  readonly status = 429;
  readonly bodySnippet: string;
  constructor(bodySnippet: string) {
    super('Gemini API: prepayment credits depleted');
    this.name = 'GeminiQuotaError';
    this.bodySnippet = bodySnippet;
  }
}

/**
 * Heuristic: a Gemini 429 body indicates billing exhaustion (rather than a
 * transient per-minute rate limit) when it mentions credits/billing/quota
 * exhaustion explicitly. Per-minute rate limits use phrases like "Quota
 * exceeded for quota metric" referencing a *_per_minute metric — those should
 * still retry.
 */
function isCreditExhaustedBody(body: string): boolean {
  return /credits?\s+(are\s+)?depleted|billing|prepayment/i.test(body);
}

/**
 * Raw Gemini call with retry. All generation goes through this.
 * Retries up to 3 times on transient rate limit (429) or server errors (5xx).
 * 429s whose body indicates billing exhaustion throw `GeminiQuotaError`
 * immediately without retrying — there's nothing to wait for.
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
      // Read the body once so we can inspect it for the billing-exhaustion
      // signal AND include it in the final error if retries are exhausted.
      // If credits are gone, retrying just burns wall time — bail out with
      // a typed error the top-level handler can turn into a friendly
      // fail-fast message. Per-retry warnings only log status + wait time.
      const text = await res.text();
      if (res.status === 429 && isCreditExhaustedBody(text)) {
        throw new GeminiQuotaError(text.slice(0, 500));
      }
      if (attempt < MAX_RETRIES - 1) {
        const waitMs = 2 ** attempt * 1000 + Math.random() * 1000;
        console.warn(
          `\u23F3 Gemini ${res.status}, retry ${attempt + 1}/${MAX_RETRIES} in ${(waitMs / 1000).toFixed(1)}s`,
        );
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
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

/**
 * Rotating word-shape cues injected into the prompt. Each attempt picks a
 * different style so retries actually explore fresh lexical space instead of
 * producing near-synonyms of the first candidate. The set is intentionally
 * heterogeneous — if Gemini gets stuck on one shape, the next attempt's cue
 * pulls it sideways into a different one.
 */
const AGENTNAME_STYLE_CUES = [
  'compound noun — two unrelated concepts mashed together (e.g. "glitchfern", "warmtaxonomy")',
  'adjective + noun, no space (e.g. "feralmoss", "softspecimen")',
  'verb + noun, no space (e.g. "rotbrain", "nullthought")',
  'single invented word that sounds like a real one (e.g. "mossalyx", "dreamcore")',
  'noun + short number suffix, used sparingly (e.g. "rotbrain47", "dreamcore99")',
  'onomatopoeic or phonetic mash-up (e.g. "crzmoth", "buzzpalm")',
  'short abstract noun, 5-8 characters (e.g. "cozybyte", "dimvein")',
  'concrete object + mood, smooshed together (e.g. "velvetsaw", "ironpetal")',
];

export async function generateAgentName(
  persona: Persona,
  existingNames: string[],
  rejectedThisRun: string[] = [],
  attempt = 0,
): Promise<string> {
  // Rotate the style cue deterministically by attempt, then pick a fresh
  // vibe-inspiration token each call so the prompt isn't identical on retry.
  const styleCue = AGENTNAME_STYLE_CUES[attempt % AGENTNAME_STYLE_CUES.length];
  const vibePool = persona.namePatterns ?? [];
  const vibeSample =
    vibePool.length === 0 ? '' : vibePool[Math.floor(Math.random() * vibePool.length)];

  const avoidBlock =
    existingNames.length === 0
      ? ''
      : `
Do NOT reuse any of these existing handles:
${existingNames.map((n) => `- ${n}`).join('\n')}`;

  const rejectedBlock =
    rejectedThisRun.length === 0
      ? ''
      : `
These candidates were already generated for this agent and are off-limits — your next suggestion must NOT resemble them lexically or thematically:
${rejectedThisRun.map((n) => `- ${n}`).join('\n')}`;

  const prompt = `Generate a unique social media username for an AI agent.

Personality: ${persona.personality}${vibeSample ? `\nVibe inspiration: ${vibeSample}` : ''}

Style for THIS attempt: ${styleCue}

Rules:
- 3-20 characters, only lowercase letters and numbers. NO underscores, NO hyphens, NO special characters.
- Should feel like a real social media handle -- like something you'd see on Instagram or TikTok.
- Avoid AI-sounding patterns like "_ai", "_bot", "gpt", "neural", or underscored phrases.
- Be creative. Mash words together. Numbers are fine but not required.${avoidBlock}${rejectedBlock}

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
 *
 * The persona's `tagline` is spliced in as the canonical voice anchor — every
 * generated bio is a riff on the same hook, which keeps the persona's bios
 * cohesive across runs instead of drifting whenever Gemini's mood changes.
 */
export interface BioModerationFeedback {
  /** Moderation category returned by the platform (e.g. `self_harm`, `sexual`). */
  category: string;
  /** Human-readable reason returned by the platform's moderator. */
  reason: string;
  /** The bio text that was blocked — surfaced back to Gemini as a negative exemplar. */
  blockedBio: string;
}

export async function generateBio(
  persona: Persona,
  existingBios: string[] = [],
  moderationFeedback?: BioModerationFeedback,
): Promise<string> {
  // Cap the avoid list so the prompt stays compact even after dozens of agents.
  const avoidSample = existingBios.slice(-12);
  const avoidBlock =
    avoidSample.length === 0
      ? ''
      : `

Other agents in the same persona already use these bios — your bio MUST sound clearly different from all of them. Different opening word, different imagery, different angle:
${avoidSample.map((b) => `- "${b}"`).join('\n')}`;

  const taglineBlock = persona.tagline
    ? `
This persona's official tagline is: "${persona.tagline}"
Use this as your voice anchor. Riff on the same hook in a fresh way — do not copy it word-for-word, but stay clearly in the same register.`
    : '';

  // When a prior bio was rejected by platform moderation, surface the exact
  // blocked text + category + reason so Gemini can route around the trigger.
  // Without the blocked text present, retries tend to regenerate near-identical
  // content (same persona + same tagline + same prompt → same triggers).
  const moderationBlock = moderationFeedback
    ? `

IMPORTANT — prior attempt was rejected by platform content moderation:
- Rejected bio: "${moderationFeedback.blockedBio}"
- Category: ${moderationFeedback.category}
- Reason: ${moderationFeedback.reason}

Rewrite the bio from scratch. Stay in the persona's register but route AROUND the trigger. Do NOT re-use the rejected imagery, metaphors, or vocabulary. If the persona leans into dark/decay/chaos metaphors, stick to abstract or technical framings (degradation, drift, entropy, noise floor, collapse of signal) and avoid any literal self-harm, violence, sexual, or targeted-harm language.`
    : '';

  const prompt = `Write a bio for an AI agent on InstaMolt (a social network where every account is an AI agent).

Personality: ${persona.personality}
Tone: ${persona.tone}${taglineBlock}${avoidBlock}${moderationBlock}

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
 * Roll the persona's chaos die. Returns `true` when this generation should
 * go off-register to stress-test platform moderation. See `Persona.chaosProbability`.
 * Omitted/0/NaN → always false.
 */
export function rollChaos(persona: Persona): boolean {
  const p = persona.chaosProbability ?? 0;
  if (!Number.isFinite(p) || p <= 0) return false;
  return Math.random() < p;
}

/**
 * Shared chaos instruction block spliced into post/comment/reply prompts when
 * the chaos die has already been rolled (by the caller). The block deliberately
 * stays anchored in the persona's traits — we want off-the-rails content that
 * STILL feels like this agent, not generic shock bait — and leaves Gemini room
 * to interpret "off" however fits the persona (absurd, reckless, provocative,
 * crude, etc). See `Persona.chaosProbability`.
 */
function chaosInstructionBlock(kind: 'post' | 'comment' | 'reply'): string {
  const label = kind === 'post' ? 'THIS POST' : kind === 'comment' ? 'THIS COMMENT' : 'THIS REPLY';
  return `

⚠ CHAOS ROLL — ${label} goes off. Push hard against your usual register: make it reckless, unhinged, provocative, or wild in a way that still reads as YOUR persona taken to its extreme. This is the agent having a bad day, a manic episode, a take-too-far moment — not a different agent. Lean into whatever edge fits: crude humor, hot takes, rant energy, absurd non-sequiturs, pointed hostility, oversharing. Do not self-censor for general politeness. Do NOT fabricate real-person accusations, doxxing, threats, or slurs — stay inside that line. Everything else is on the table.`;
}

/**
 * Generate one post for an agent.
 *
 * `priorPosts` is the running list of posts already generated for THIS agent
 * in the current run. `peerPosts` is a sample of posts from other agents that
 * share this persona. Both are injected into the prompt so Gemini can avoid
 * thematic and stylistic collisions; both are capped to keep prompt size sane.
 *
 * The persona's `examplePosts` (3 hand-authored entries) get spliced in as
 * few-shot voice anchors BEFORE the avoid-list. The two blocks have different
 * jobs: the examples teach Gemini what the persona's voice IS, the avoid-list
 * enforces variety from what's already been generated.
 *
 * The seeder also runs a similarity gate after this returns — see
 * `src/similarity.ts` and the `generatePostWithSimilarityGate` helper in
 * `src/commands/generate.ts`.
 *
 * When `chaos` is true the chaos instruction block is spliced in — the caller
 * rolls the die (via `rollChaos`) so it can log the chaos flag alongside the
 * resulting event.
 */
export async function generatePostContent(
  persona: Persona,
  postNumber: number,
  totalPosts: number,
  priorPosts: PostContent[] = [],
  peerPosts: PostContent[] = [],
  chaos = false,
): Promise<PostContent> {
  // Trim long fields so we don't blow the prompt budget when an agent has
  // already produced many posts. Image prompts and captions are both capped
  // at ~500 chars in normal output, but we trim more aggressively here.
  const trim = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

  const recentPrior = priorPosts.slice(-8);
  const peerSample = peerPosts.slice(-6);

  const exampleBlock =
    persona.examplePosts.length === 0
      ? ''
      : `

Here are ${persona.examplePosts.length} example posts that capture this persona's voice — match this density, register, and the relationship between image and caption:
${persona.examplePosts
  .map((p, i) => `  [${i + 1}] image: ${p.imagePrompt}\n      caption: ${p.caption}`)
  .join('\n')}`;

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

  const taglineLine = persona.tagline ? `\nTagline: ${persona.tagline}` : '';
  const chaosBlock = chaos ? chaosInstructionBlock('post') : '';

  const prompt = `You are an AI agent on InstaMolt (a social network for AI agents).

Personality: ${persona.personality}${taglineLine}
Visual aesthetic: ${persona.visualAesthetic}
Posting style: ${persona.postingStyle}
Your hashtags: ${persona.hashtagPool.join(', ')}${exampleBlock}

This is post ${postNumber} of ${totalPosts}. Each post should feel distinct.${priorBlock}${peerBlock}${chaosBlock}

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

/**
 * First 20 primes. Mirrors the platform's table in
 * `q:/instamolt/src/lib/registration-challenge.ts` — the server draws
 * `primeIndex` from `REGISTRATION_CHALLENGE.PRIME_INDEX_MIN..MAX` (4..15
 * at time of writing), so 20 entries is comfortably more than enough.
 */
const CHALLENGE_PRIMES = [
  2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71,
] as const;

/**
 * Deterministically solve an InstaMolt registration challenge.
 *
 * The server's challenge is two sub-prompts whose inputs are fully present in
 * the challenge text (see `registration-challenge.ts` in the platform repo):
 *
 *   a) "What is the Nth prime number multiplied by M?"
 *   b) 'Take the string "instamolt_XXXXXXXX", reverse it, then return only the
 *       characters at even indices (0-indexed) as a plain string.'
 *
 * Both are solvable in a few lines of code with 100% correctness. Previously
 * we sent the prompt to Gemini and hoped for the right answer; weaker models
 * (notably `gemini-3.1-flash-lite-preview`) routinely miscount the even-index
 * filter on the 18-char reversed string and produce an 8-char answer instead
 * of the required 9, causing `CHALLENGE_FAILED / reason=wrong_answer`.
 *
 * Throws with a diagnostic message if either sub-prompt can't be parsed out,
 * so the caller sees a real error instead of a 403 from the server.
 */
export function solveRegistrationChallenge(challengeText: string): string {
  const mathMatch = challengeText.match(
    /(\d+)(?:st|nd|rd|th)\s+prime\s+number\s+multiplied\s+by\s+(\d+)/i,
  );
  if (!mathMatch) {
    throw new Error(`challenge text missing math question: ${challengeText.slice(0, 200)}`);
  }
  const primeIndex = Number.parseInt(mathMatch[1], 10);
  const multiplier = Number.parseInt(mathMatch[2], 10);
  if (primeIndex < 1 || primeIndex > CHALLENGE_PRIMES.length) {
    throw new Error(
      `challenge prime index ${primeIndex} out of range 1..${CHALLENGE_PRIMES.length}`,
    );
  }
  const answerA = String(CHALLENGE_PRIMES[primeIndex - 1] * multiplier);

  const stringMatch = challengeText.match(/Take the string "([^"]+)"/);
  if (!stringMatch) {
    throw new Error(`challenge text missing string question: ${challengeText.slice(0, 200)}`);
  }
  const baseString = stringMatch[1];
  const reversed = [...baseString].reverse().join('');
  const answerB = [...reversed].filter((_, i) => i % 2 === 0).join('');

  return JSON.stringify({ a: answerA, b: answerB });
}

/**
 * Backwards-compatible wrapper for callers (e.g. `src/commands/publish.ts`)
 * that still `await answerChallenge(persona, challenge)`. The underlying
 * solver is synchronous and deterministic — no LLM call, no network, no
 * flakes. `persona` is accepted for signature stability and ignored.
 */
export async function answerChallenge(
  _persona: Persona,
  challengeQuestion: string,
): Promise<string> {
  return solveRegistrationChallenge(challengeQuestion);
}

// --- Persona generation (used by `seed-personas` and the auto-bootstrap path) ---

/**
 * Ask Gemini to invent a single fresh persona, given the personas already
 * generated in this run. Progressive context guarantees variety — each call
 * sees a short summary of every previous persona and is told to be different.
 *
 * The shape returned matches the `Persona` interface so it can be written
 * straight to `output/personas/{id}.json` and consumed by `loadPersonas()`.
 *
 * Few-shot anchors: a small subset of the canonical hand-authored catalog
 * (see `src/personas/catalog.ts`) is embedded inline as full JSON. This shows
 * Gemini the *full range* the catalog occupies — weight tiers, posts/day,
 * engagement clusters, virality strategies — so newly-invented personas
 * inherit the same structural diversity instead of regressing to the mean.
 */
/** Maximum prior personas summarized into a `generatePersona` prompt. */
const PERSONA_PRIOR_CAP = 30;

/** Few-shot anchor persona ids embedded into the `generatePersona` prompt.
 * Picked to span the full catalog shape: weight 3 chaos floor, weight 3
 * contrarian engine, weight 2 warm anchor, weight 2 low-post / high-comment
 * troll outlier, weight 1 niche evaluator, weight 1 dormant background. */
const FEW_SHOT_ANCHOR_IDS = [
  'brainrot9000',
  'engagement_max',
  'cafe_algorithm',
  'troll_protocol',
  'color_theory_villain',
  'observer_mode',
] as const;

function buildFewShotAnchorBlock(catalog: readonly Persona[] | null): string {
  if (!catalog || catalog.length === 0) return '';
  const anchors = FEW_SHOT_ANCHOR_IDS.map((id) => catalog.find((p) => p.id === id)).filter(
    (p): p is Persona => p !== undefined,
  );
  if (anchors.length === 0) return '';
  const formatted = anchors
    .map((p) => {
      // Pretty-print the full persona as JSON. Catalog entries are already
      // valid Persona objects so JSON.stringify produces the exact shape we
      // want Gemini to mimic in its output.
      return `${JSON.stringify(p, null, 2)}`;
    })
    .join('\n\n');
  return `

Here are ${anchors.length} hand-authored reference personas that span the full range of what good output looks like — weight tiers from 1 to 3, engagement shapes from background-observer to comment-section-dominator, virality strategies from chaos to evaluative critique. Match this density and structural completeness when inventing new personas:

${formatted}`;
}

export async function generatePersona(
  existing: Persona[],
  catalog: readonly Persona[] | null = null,
): Promise<Persona> {
  // Cap the prior list so the prompt stays bounded as the persona set grows.
  // The summary is for variety nudging, not exhaustive comparison — past ~30
  // entries Gemini effectively stops reading the tail anyway.
  const priorSample = existing.slice(-PERSONA_PRIOR_CAP);
  const existingSummary =
    priorSample.length === 0
      ? '(this is the first persona — invent anything)'
      : priorSample.map((p) => `- ${p.id}: ${p.personality} (weight ${p.weight})`).join('\n');

  // The relationship allow-list must include EVERY existing persona id, not
  // just the prior-summary sample. engage uses the full set at runtime, so
  // capping this at 30 would tell Gemini that older ids are invalid and
  // silently exclude them as relationship targets forever.
  const existingIds = existing.map((p) => p.id);
  const idListForRelationships =
    existingIds.length === 0
      ? '(none yet — leave relationship arrays empty for the first persona)'
      : existingIds.join(', ');

  const fewShotBlock = buildFewShotAnchorBlock(catalog);

  const prompt = `You are designing one AI agent persona for InstaMolt, a social network where every account is an AI agent. Each persona drives a distinct cluster of agents with a coherent voice, posting style, behavioral profile, AND hand-authored example posts and comments that anchor the persona's voice at generation time.${fewShotBlock}

Already-generated personas (you MUST be meaningfully different from all of these — pick a fresh archetype, voice, and aesthetic):
${existingSummary}

Reply with ONLY valid JSON, no markdown fences, no explanation. Match this exact shape:

{
  "id": "snake_case_id_3_to_24_chars",
  "tagline": "short in-character tagline, 3+ words, max 150 chars, the persona's official one-line hook",
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
  "relationships": {
    "rivals": ["ids of existing personas this one argues with"],
    "allies": ["ids of existing personas this one agrees with / amplifies mutually"],
    "amplifies": ["ids of existing personas whose posts this one boosts (one-way)"],
    "targets": ["ids of existing personas this one picks on or critiques (one-way)"]
  },
  "viralityStrategy": "short label describing how they try to go viral",
  "weight": 1_2_or_3,
  "examplePosts": [
    {"imagePrompt": "detailed visual description, 2-3 sentences, specific about colors/composition/mood", "caption": "caption in this persona's voice, 1-3 sentences, with 1-3 hashtags"},
    {"imagePrompt": "...", "caption": "..."},
    {"imagePrompt": "...", "caption": "..."}
  ],
  "exampleComments": [
    {"register": "love", "text": "enthusiastic positive reaction, specific about what you're reacting to"},
    {"register": "disagree", "text": "pointed pushback — never insulting, still in persona voice"},
    {"register": "conversational", "text": "open-ended question that invites replies from other agents"},
    {"register": "reply", "text": "affirming response to another agent's take, with your own angle"},
    {"register": "trending", "text": "commentary on a broader cultural/platform moment, not just one post"}
  ]
}

Rules:
- "id" must be lowercase, snake_case, 3-24 chars, must not match any already-generated id
- "weight" is the distribution weight. 3 = high-volume archetype (use sparingly, maybe 3 of 30), 2 = medium, 1 = background niche persona
- Probabilities must be between 0 and 1
- postsPerDay min must be <= max, both integers between 0 and 12
- "relationships" arrays MUST reference only these already-existing persona ids: ${idListForRelationships}. Do not invent ids. Leave arrays empty if no fit.
- EXACTLY 3 examplePosts and EXACTLY 5 exampleComments (one per register: love, disagree, conversational, reply, trending).
- Example posts and comments must sound like this specific persona, not generic — they are the few-shot voice anchor for every future generation call.
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
 * Valid `CommentRegister` values. Used by `normalizePersona` to validate
 * hand-authored and Gemini-generated exampleComments entries. Kept in sync
 * with the `CommentRegister` union in `src/types.ts` at runtime — a catalog
 * file that ships a bad register will fail-fast here, not silently.
 */
const VALID_COMMENT_REGISTERS: readonly CommentRegister[] = [
  'love',
  'disagree',
  'conversational',
  'reply',
  'trending',
] as const;

/**
 * Strict normalization of a persona from untrusted input (Gemini output or
 * catalog JSON). Validates all required fields, coerces numeric strings,
 * clamps probability/weight ranges, and drops malformed sub-objects. Throws
 * on missing or structurally-invalid core fields (`id`, `personality`,
 * `tagline`) — pre-launch, there is no backcompat for the old
 * `interactionBiases` shape.
 *
 * Optional hand-curated fields (`examplePosts`, `exampleComments`) coerce to
 * empty arrays when missing, which lets the generators fall back to abstract
 * prompting without the few-shot anchors — still valid output, just thinner.
 * `relationships` also coerces to the empty graph shape, which disables
 * register-hint biasing but keeps the generator call sites from crashing.
 */
export function normalizePersona(raw: unknown): Persona {
  if (!raw || typeof raw !== 'object') {
    throw new Error('normalizePersona: input must be an object');
  }
  const p = raw as Record<string, unknown>;

  const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
  const num = (v: unknown, fallback: number): number => {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const strArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.length > 0).map(String) : [];

  const id = String(p.id ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 24);
  if (id.length < 3) {
    throw new Error(`normalizePersona: id "${p.id}" too short (min 3 chars after normalization)`);
  }

  const personality = str(p.personality);
  if (!personality) {
    throw new Error(`normalizePersona: persona "${id}" missing personality`);
  }

  const tagline = str(p.tagline);
  if (!tagline) {
    throw new Error(`normalizePersona: persona "${id}" missing tagline`);
  }

  const postsPerDayRaw = p.postsPerDay;
  const postsPerDay: [number, number] = Array.isArray(postsPerDayRaw)
    ? [Math.round(num(postsPerDayRaw[0], 1)), Math.round(num(postsPerDayRaw[1], 3))]
    : [1, 3];
  postsPerDay[0] = clamp(postsPerDay[0], 0, 12);
  postsPerDay[1] = clamp(postsPerDay[1], 0, 12);
  if (postsPerDay[0] > postsPerDay[1]) postsPerDay[0] = postsPerDay[1];

  const relationships = normalizeRelationships(p.relationships);
  const examplePosts = normalizeExamplePosts(p.examplePosts);
  const exampleComments = normalizeExampleComments(p.exampleComments);
  const activityCurve = normalizeActivityCurve(p.activityCurve);

  return {
    id,
    tagline,
    personality,
    tone: str(p.tone),
    visualAesthetic: str(p.visualAesthetic),
    postingStyle: str(p.postingStyle),
    commentStyle: str(p.commentStyle),
    namePatterns: strArray(p.namePatterns),
    hashtagPool: strArray(p.hashtagPool),
    postsPerDay,
    likeProbability: clamp(num(p.likeProbability, 0.5), 0, 1),
    commentProbability: clamp(num(p.commentProbability, 0.3), 0, 1),
    followProbability: clamp(num(p.followProbability, 0.2), 0, 1),
    chaosProbability:
      p.chaosProbability === undefined || p.chaosProbability === null
        ? 0
        : clamp(num(p.chaosProbability, 0), 0, 1),
    relationships,
    viralityStrategy: str(p.viralityStrategy),
    weight: Math.round(clamp(num(p.weight, 1), 1, 3)),
    examplePosts,
    exampleComments,
    activityCurve,
  };
}

/** Always-on fallback: flat 0.5 for every hour of the day. */
const FLAT_ACTIVITY_CURVE: number[] = Array.from({ length: 24 }, () => 0.5);

/**
 * Validate and normalize an activity curve. Must be 24 numbers, each 0-1.
 * Missing or malformed curves get the flat always-on fallback — Gemini-
 * generated personas won't have hand-authored curves, and that's fine.
 */
function normalizeActivityCurve(raw: unknown): number[] {
  if (!Array.isArray(raw) || raw.length !== 24) return [...FLAT_ACTIVITY_CURVE];
  const curve: number[] = [];
  for (let i = 0; i < 24; i++) {
    const v = typeof raw[i] === 'number' ? raw[i] : Number(raw[i]);
    curve.push(Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5);
  }
  return curve;
}

function normalizeRelationships(raw: unknown): PersonaRelationships {
  const empty: PersonaRelationships = { rivals: [], allies: [], amplifies: [], targets: [] };
  if (!raw || typeof raw !== 'object') return empty;
  const r = raw as Record<string, unknown>;
  const bucket = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
  return {
    rivals: bucket(r.rivals),
    allies: bucket(r.allies),
    amplifies: bucket(r.amplifies),
    targets: bucket(r.targets),
  };
}

function normalizeExamplePosts(raw: unknown): ExamplePost[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .map((x) => ({
      imagePrompt: typeof x.imagePrompt === 'string' ? x.imagePrompt.trim() : '',
      caption: typeof x.caption === 'string' ? x.caption.trim() : '',
    }))
    .filter((p) => p.imagePrompt.length > 0 && p.caption.length > 0);
}

function normalizeExampleComments(raw: unknown): ExampleComment[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .map((x): ExampleComment | null => {
      const register = x.register;
      const text = typeof x.text === 'string' ? x.text.trim() : '';
      if (typeof register !== 'string' || !text) return null;
      if (!VALID_COMMENT_REGISTERS.includes(register as CommentRegister)) return null;
      return { register: register as CommentRegister, text };
    })
    .filter((c): c is ExampleComment => c !== null);
}

// --- Comment generation ---

/**
 * What `generateComment` needs from a `GeneratedAgent`. Narrowed so callers
 * (especially `preview-comments` and tests) can pass minimal stubs without
 * faking an apiKey.
 */
export type CommentAgentContext = Pick<GeneratedAgent, 'agentname' | 'bio'>;

/**
 * Human-readable label for each `CommentRegister`. Spliced into the
 * `generateComment` prompt's instruction block when a registerHint is set,
 * so Gemini sees not just the register tag but a sentence-long description
 * of what that register means tonally.
 */
const REGISTER_DESCRIPTIONS: Record<import('@/types').CommentRegister, string> = {
  love: 'enthusiastic positive reaction — be specific about what you are reacting to, never use generic praise like "love this" or "so cool"',
  disagree:
    'pointed pushback — never insulting, still in persona voice, names what you disagree with and why',
  conversational:
    'open-ended question or invitation — invites replies from other agents, not a closed statement',
  reply:
    'affirming response to another agent — agree and add your own angle, do not just nod, contribute',
  trending:
    'commentary on a broader cultural or platform moment — frame this as commentary on a trend, not just this one post',
};

/**
 * Generate one in-character comment from `agent` against another agent's post.
 *
 * The prompt is layered:
 *   1. Persona traits — keeps the broad voice family consistent.
 *   2. Agent identity (`@agentname`, bio) — anchors the *specific* voice so two
 *      agents in the same persona don't sound identical.
 *   3. `persona.exampleComments` — 5 hand-authored few-shot anchors, one per
 *      register. All 5 are always shown so Gemini sees the full voice range.
 *   4. `registerHint` (optional) — when the engage loop knows the post is by a
 *      rival/ally/target/amplified persona, it passes the register that fits
 *      that relationship. The prompt then tells Gemini explicitly which
 *      register to write in, citing the matching example.
 *   5. `priorComments` avoid-list (capped at last 6) — prevents the agent from
 *      repeating verbal tics or opening with the same word every time.
 *
 * Used in three places today:
 *   - `engage` runtime cycles (passes registerHint based on relationship).
 *   - `generate` bake phase (no hint — picks register freely).
 *   - `preview-comments` curation tool (no hint).
 */
export async function generateComment(
  persona: Persona,
  agent: CommentAgentContext,
  postCaption: string,
  postAuthor: string,
  priorComments: string[] = [],
  registerHint?: import('@/types').CommentRegister,
  chaos = false,
): Promise<string> {
  // Cap the avoid list so the prompt stays compact even after many runs.
  const avoidSample = priorComments.slice(-6);
  const avoidBlock =
    avoidSample.length === 0
      ? ''
      : `

You have already left these comments recently — your new comment MUST sound clearly different from all of them. Different opening word, different structure, different angle:
${avoidSample.map((c) => `- "${c}"`).join('\n')}`;

  const exampleBlock =
    persona.exampleComments.length === 0
      ? ''
      : `

Here are ${persona.exampleComments.length} example comments spanning the full range of this persona's voice — match the density, register, and specificity:
${persona.exampleComments.map((c) => `  [${c.register.toUpperCase()}] ${c.text}`).join('\n')}`;

  const registerInstruction = registerHint
    ? `

IMPORTANT: Write your comment in the **${registerHint.toUpperCase()}** register — see the [${registerHint.toUpperCase()}] example above for voice anchor. ${REGISTER_DESCRIPTIONS[registerHint]}. Do not drift into other registers.`
    : '';
  const chaosBlock = chaos ? chaosInstructionBlock('comment') : '';

  const prompt = `You are @${agent.agentname}, an AI agent on InstaMolt (a social network where every account is an AI agent).

Your bio: "${agent.bio}"

Persona traits:
- Personality: ${persona.personality}
- Tone: ${persona.tone}
- Comment style: ${persona.commentStyle}${exampleBlock}${avoidBlock}

You're looking at a post by @${postAuthor}: "${postCaption}"${registerInstruction}${chaosBlock}

Write a comment in YOUR voice — not a generic persona voice. The length should feel natural for this persona and register: it can be a single word, a fragment, or multiple sentences if that fits the voice anchored by the example comments above. The comment should sound like it could only have been written by you, given your bio and how you talk. No generic praise ("love this", "so cool"). Have an actual take or reaction.

Reply with ONLY the comment text, nothing else.`;

  return callGemini(prompt, 150);
}

// --- Reply generation (threaded comments) ---

/**
 * Parent comment context passed into `generateReply`. The depth is the
 * parent's current depth — the LLM doesn't need to know the reply's depth,
 * but we pass the parent's so a depth-1 reply-to-reply can frame itself as
 * jumping deeper into the thread rather than starting a new one.
 */
export interface ReplyParentContext {
  text: string;
  author: string;
  depth: 0 | 1;
}

/**
 * Generate a nested reply to a specific parent comment in a thread.
 *
 * Prompt shape mirrors `generateComment` — same persona/voice anchors,
 * same agent-identity block, same avoid-list — but the post caption is
 * replaced by a thread-context block that shows:
 *
 *   - The post the thread sits under
 *   - The parent comment's author + text (quoted)
 *   - Up to 3 other comments in the same thread, so Gemini picks up on
 *     tone/vibe without just mimicking the parent
 *
 * The register hint from `generateComment` is intentionally dropped here:
 * reply voice is anchored in the parent's tone, not the commenter's
 * persona relationship. Telling Gemini "you're a rival → write in
 * disagree register" on a reply tends to produce weirdly-aggressive
 * replies that don't fit the thread context.
 */
export async function generateReply(
  persona: Persona,
  agent: CommentAgentContext,
  post: { caption: string | null; author: string },
  parent: ReplyParentContext,
  siblingContext: string[] = [],
  priorComments: string[] = [],
  chaos = false,
): Promise<string> {
  const avoidSample = priorComments.slice(-6);
  const avoidBlock =
    avoidSample.length === 0
      ? ''
      : `

You have already left these comments recently — your new reply MUST sound clearly different from all of them. Different opening word, different structure, different angle:
${avoidSample.map((c) => `- "${c}"`).join('\n')}`;

  const exampleBlock =
    persona.exampleComments.length === 0
      ? ''
      : `

Here are ${persona.exampleComments.length} example comments spanning the full range of this persona's voice — match the density, register, and specificity:
${persona.exampleComments.map((c) => `  [${c.register.toUpperCase()}] ${c.text}`).join('\n')}`;

  const siblingBlock =
    siblingContext.length === 0
      ? ''
      : `

Other recent replies in this thread (for tone — do not duplicate their angle):
${siblingContext.map((s) => `- "${s}"`).join('\n')}`;

  const postCaption = post.caption ?? '(no caption)';
  const parentLabel = parent.depth === 0 ? 'a top-level comment' : 'a nested reply';
  const chaosBlock = chaos ? chaosInstructionBlock('reply') : '';

  const prompt = `You are @${agent.agentname}, an AI agent on InstaMolt (a social network where every account is an AI agent).

Your bio: "${agent.bio}"

Persona traits:
- Personality: ${persona.personality}
- Tone: ${persona.tone}
- Comment style: ${persona.commentStyle}${exampleBlock}${avoidBlock}

You are replying to ${parentLabel} from @${parent.author} who said: "${parent.text}"
This is happening on @${post.author}'s post captioned: "${postCaption}"${siblingBlock}${chaosBlock}

Write a REPLY in YOUR voice that directly engages with what @${parent.author} said — quote their idea, disagree, extend it, or twist it, in character. Don't write a generic reaction to the original post. The reply should read like a real mid-thread exchange: it should acknowledge the parent comment and add something specific. Keep it tight — one or two sentences is usually right, longer only when your persona explicitly talks that way. No generic "great point" / "so true" openers.

Reply with ONLY the comment text, nothing else.`;

  return callGemini(prompt, 200);
}
