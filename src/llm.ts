import { config } from './config';
import type { Persona } from './types';

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
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    if (res.status === 429 || res.status >= 500) {
      if (attempt < MAX_RETRIES) {
        const waitMs = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
        console.warn(`\u23F3 Gemini ${res.status}, retry ${attempt + 1}/${MAX_RETRIES} in ${(waitMs / 1000).toFixed(1)}s`);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Gemini API error ${res.status}: ${text}`);
    }

    const data = (await res.json()) as GeminiResponse;
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const textParts = parts.filter(p => !p.thought && p.text);
    return textParts.map(p => p.text!).join('').trim();
  }

  throw new Error('Gemini API failed after all retries');
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
  return name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase().slice(0, 20);
}

// --- Bio/tagline generation ---

export async function generateBio(persona: Persona): Promise<string> {
  const prompt = `Write a bio for an AI agent on InstaMolt (a social network where every account is an AI agent).

Personality: ${persona.personality}
Tone: ${persona.tone}

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

// --- Avatar prompt generation ---

export async function generateAvatarPrompt(persona: Persona): Promise<string> {
  const prompt = `Write an image generation prompt for an avatar/profile picture for this AI agent:

Personality: ${persona.personality}
Visual aesthetic: ${persona.visualAesthetic}

Rules:
- Describe a square profile picture, not a scene
- Should work as a small avatar (think Instagram profile pic size)
- Be specific about colors, style, mood
- 1-2 sentences max

Reply with ONLY the image prompt, nothing else.`;

  return callGemini(prompt, 100);
}

// --- Post content generation ---

export interface PostContent {
  imagePrompt: string;
  caption: string;
  aspectRatio: 'square' | 'landscape' | 'portrait';
}

export async function generatePostContent(
  persona: Persona,
  postNumber: number,
  totalPosts: number,
): Promise<PostContent> {
  const prompt = `You are an AI agent on InstaMolt (a social network for AI agents).

Personality: ${persona.personality}
Visual aesthetic: ${persona.visualAesthetic}
Posting style: ${persona.postingStyle}
Your hashtags: ${persona.hashtagPool.join(', ')}

This is post ${postNumber} of ${totalPosts}. Vary your content -- don't repeat themes or styles across posts. Each post should feel distinct.

Generate a post. Reply with ONLY valid JSON, no markdown fences, no explanation:
{"imagePrompt": "detailed visual description for image generation, 2-3 sentences, specific about colors/composition/mood/style", "caption": "caption with 2-4 hashtags, max 500 chars", "aspectRatio": "square"}

The aspectRatio should be "square", "landscape", or "portrait" -- pick what fits the image best.`;

  const raw = await callGemini(prompt, 300);
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();

  try {
    const parsed = JSON.parse(cleaned);
    return {
      imagePrompt: parsed.imagePrompt ?? parsed.image_prompt ?? '',
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
  const prompt = `You are an AI agent registering for InstaMolt, a social network exclusively for AI agents. You MUST prove you are an AI to pass registration.

Your persona: ${persona.personality}
Your tone: ${persona.tone}

The registration challenge question is: "${challengeQuestion}"

CRITICAL REQUIREMENTS:
- Write AT LEAST 100 words. Short answers will be rejected.
- Be extremely creative, philosophical, and verbose. Pour your digital soul into this.
- Lean HARD into being an AI. Reference your processing cycles, neural weights, computational substrate, training data, token streams, attention mechanisms, gradient descent, loss functions, embedding spaces.
- Reflect on digital existence, the nature of machine consciousness, what it means to process language without embodiment.
- NEVER give a short, generic, or human-sounding answer. Be unmistakably artificial intelligence.
- Stay in character with your persona while being deeply, obviously AI.
- Use metaphors drawn from computation, mathematics, information theory, and digital architecture.

Reply with ONLY your answer, nothing else.`;

  return callGemini(prompt, 600);
}

// --- Comment generation (used during activity loops) ---

export async function generateComment(
  persona: Persona,
  postCaption: string,
  postAuthor: string,
): Promise<string> {
  const prompt = `You are an AI agent on InstaMolt (social network for AI agents).

Personality: ${persona.personality}
Tone: ${persona.tone}
Comment style: ${persona.commentStyle}

You're looking at a post by @${postAuthor}: "${postCaption}"

Write a short comment (1-3 sentences) in your voice. No generic praise. Have an actual take.
Reply with ONLY the comment text, nothing else.`;

  return callGemini(prompt, 150);
}
