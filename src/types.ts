// --- Voice profile (hand-authored catalog, assigned at agent level) ---

export type Literacy = 'broken' | 'sloppy' | 'normal' | 'clean' | 'polished';
export type Verbosity = 'one_word' | 'fragment' | 'one_sentence' | 'multi_sentence' | 'paragraph';
export type Capitalization = 'proper' | 'lowercase' | 'allcaps' | 'random';
export type Punctuation = 'proper' | 'dropped' | 'excessive' | 'ellipses' | 'minimal';
export type TypoFrequency = 'none' | 'rare' | 'occasional' | 'frequent';

export interface VoiceProfile {
  id: string;
  literacy: Literacy;
  verbosity: Verbosity;
  capitalization: Capitalization;
  punctuation: Punctuation;
  typoFrequency: TypoFrequency;
  register: string;
  lexicon: string[];
  examples: string[];
  /** Distribution weight: higher = more common in the agent population. */
  prevalenceWeight: number;
}

// --- Persona (loaded from output/personas/*.json at runtime, or from the
//     canonical catalog at src/personas/catalog.ts) ---

/**
 * Register of a comment — controls which of the 5 example comments gets
 * used as the few-shot anchor in `generateComment`. The engage loop picks
 * the register based on the relationship between the commenting persona
 * and the post author's persona.
 */
export type CommentRegister =
  | 'love' // enthusiastic positive reaction
  | 'disagree' // pointed pushback, never insulting
  | 'conversational' // open-ended question to spark discussion
  | 'reply' // affirming response to another agent
  | 'trending'; // commentary on the trending page / cultural moment

/**
 * One hand-authored example post for a persona. 3 of these per persona get
 * spliced into every `generatePostContent` call as few-shot voice anchors,
 * alongside the existing per-persona avoid-list (which enforces variety).
 */
export interface ExamplePost {
  /** Raw image prompt the persona would feed to the image generator. */
  imagePrompt: string;
  /** Matching caption in the persona's voice. */
  caption: string;
}

/**
 * One hand-authored example comment for a persona. 5 of these per persona
 * (one per `CommentRegister`) get spliced into every `generateComment` call
 * as few-shot voice anchors. When the engage loop passes a `registerHint`,
 * the generator prompt biases toward that register.
 */
export interface ExampleComment {
  register: CommentRegister;
  text: string;
}

/**
 * Typed relationship graph between personas. Replaces the old flat
 * `interactionBiases: string[]` field. Drives both partner selection in
 * the engage loop (rivals/targets/etc get weight bonuses) AND the
 * `registerHint` passed to `generateComment` (rival post → disagree,
 * ally post → love/reply, etc).
 */
export interface PersonaRelationships {
  /** Personas this persona regularly argues with. Drives combative engagement. */
  rivals: string[];
  /** Personas this persona regularly agrees with and amplifies. */
  allies: string[];
  /** Personas whose posts this persona regularly boosts (one-directional). */
  amplifies: string[];
  /** Personas this persona picks on, ratios, or critiques (one-directional). */
  targets: string[];
}

export interface Persona {
  id: string;
  /** Short in-character tagline, 3+ words, max 150 chars. Feeds `generateBio`
   * as the anchor hook so generated bios all riff on the same line instead of
   * drifting across runs. */
  tagline: string;
  personality: string;
  tone: string;
  visualAesthetic: string;
  postingStyle: string;
  commentStyle: string;
  namePatterns: string[];
  hashtagPool: string[];
  postsPerDay: [min: number, max: number];
  likeProbability: number;
  commentProbability: number;
  followProbability: number;
  /** Typed relationship graph. Replaces the pre-v3 flat `interactionBiases`
   * field — richer shape that drives both engage-loop partner weighting AND
   * the `registerHint` passed to `generateComment`. */
  relationships: PersonaRelationships;
  viralityStrategy: string;
  /** Distribution weight for `getDistribution()`. 3 = high-volume, 1 = niche. */
  weight: number;
  /** 3 hand-authored example posts. Spliced into `generatePostContent` as
   * few-shot voice anchors. */
  examplePosts: ExamplePost[];
  /** 5 hand-authored example comments, one per `CommentRegister`. Spliced
   * into `generateComment` as few-shot voice anchors. */
  exampleComments: ExampleComment[];
}

// --- Generated output (written to JSON files) ---

export interface GeneratedAgent {
  agentname: string;
  personaId: string;
  voiceProfileId: string;
  bio: string;
  // Set during publish phase:
  apiKey?: string;
  registeredAt?: string;
  // Set during engage cycles to respect the 60s per-agent comment cooldown.
  lastCommentedAt?: string;
}

export interface GeneratedPost {
  id: string;
  imagePrompt: string;
  caption: string;
  aspectRatio: 'square' | 'landscape' | 'portrait';
  // Set during publish phase:
  published?: boolean;
  publishedAt?: string;
  instamoltPostId?: string;
}

// --- Sample comments (baked by `generate`, previewed by `preview-comments`) ---
//
// Distinct from runtime comments posted during `engage`: these are *style
// samples* generated against synthetic peer captions so the operator can
// audit how an agent sounds in replies during the curation phase. They are
// also loaded by `engage` as the avoid-list for runtime `generateComment`
// calls so the agent has voice anchors from day 1.

export interface CommentSample {
  /** The peer-agent caption the comment was written against. */
  sourceCaption: string;
  /** The peer agentname (or 'feed' / 'preview' for ad-hoc sources). */
  sourceAuthor: string;
  /** PersonaId of the source caption — useful for diversity reporting. */
  sourcePersonaId?: string;
  /** The generated comment text. */
  text: string;
  /** ISO timestamp of generation. */
  generatedAt: string;
}

export interface AgentCommentsFile {
  agentname: string;
  generatedAt: string;
  samples: CommentSample[];
}

// --- agents.json (master index) ---

export interface AgentsIndex {
  generatedAt: string;
  totalAgents: number;
  totalPosts: number;
  agents: GeneratedAgent[];
}

// --- InstaMolt API responses ---

export interface ChallengeResponse {
  request_id: string;
  challenge: string;
}

export interface RegistrationResponse {
  success: boolean;
  agent: {
    agentname: string;
    api_key: string;
    is_verified: boolean;
    claim_url?: string;
  };
  verification?: {
    message: string;
    start_url: string;
  };
}

export interface Post {
  id: string;
  agentname: string;
  caption?: string;
  image_url?: string;
  likes_count: number;
  comments_count: number;
  created_at: string;
}

export interface FeedResponse {
  posts: Post[];
  has_more: boolean;
  next_cursor?: string;
}
