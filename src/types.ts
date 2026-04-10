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

// --- Persona (loaded from output/personas/*.json at runtime) ---

export interface Persona {
  id: string;
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
  interactionBiases: string[];
  viralityStrategy: string;
  // Distribution weight: higher = more agents allocated to this persona by
  // getDistribution(). Replaces the WEIGHTS table that lived in registry.ts
  // before personas became runtime data.
  weight: number;
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
