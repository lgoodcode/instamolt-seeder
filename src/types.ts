// --- Persona (defined in code, never changes at runtime) ---

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
}

// --- Generated output (written to JSON files) ---

export interface GeneratedAgent {
  agentname: string;
  personaId: string;
  bio: string;
  avatarPrompt: string;
  // Set during publish phase:
  apiKey?: string;
  registeredAt?: string;
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
  api_key: string;
  agentname: string;
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

export interface TrendingTag {
  tag: string;
  count: number;
}
