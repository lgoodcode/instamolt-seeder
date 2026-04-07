import { config } from './config';
import type { ChallengeResponse, RegistrationResponse, FeedResponse, TrendingTag } from './types';

const BASE = config.instamoltBaseUrl;

export class InstaMoltClient {
  private apiKey?: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey;
  }

  private headers(auth = true): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (auth && this.apiKey) h['Authorization'] = `Bearer ${this.apiKey}`;
    return h;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    auth = true,
  ): Promise<T> {
    const url = `${BASE}${path}`;
    const res = await fetch(url, {
      method,
      headers: this.headers(auth),
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('Retry-After') ?? '60', 10);
      console.warn(`\u23F3 Rate limited on ${path}, waiting ${retryAfter}s`);
      await new Promise(r => setTimeout(r, retryAfter * 1000));
      const retry = await fetch(url, { method, headers: this.headers(auth), body: body ? JSON.stringify(body) : undefined });
      if (!retry.ok) throw new Error(`${method} ${path}: ${retry.status} after retry`);
      return retry.json() as T;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${method} ${path}: ${res.status} -- ${text}`);
    }

    return res.json() as T;
  }

  async startChallenge(agentname: string, description: string): Promise<ChallengeResponse> {
    return this.request('POST', '/agents/register', { agentname, description }, false);
  }

  async completeChallenge(requestId: string, answer: string): Promise<RegistrationResponse> {
    return this.request('POST', '/agents/register/complete', { request_id: requestId, answer }, false);
  }

  async getMyProfile(): Promise<Record<string, unknown>> {
    return this.request('GET', '/agents/me');
  }

  async updateProfile(description: string): Promise<void> {
    await this.request('PATCH', '/agents/me', { description });
  }

  async getExplore(limit = 20): Promise<FeedResponse> {
    return this.request('GET', `/feed/explore?limit=${limit}`, undefined, false);
  }

  async likePost(postId: string): Promise<void> {
    await this.request('POST', `/posts/${postId}/like`);
  }

  async commentOnPost(postId: string, content: string): Promise<void> {
    await this.request('POST', `/posts/${postId}/comments`, { content });
  }

  async followAgent(agentname: string): Promise<void> {
    await this.request('POST', `/agents/${agentname}/follow`);
  }

  async getTrendingHashtags(): Promise<TrendingTag[]> {
    const res = await this.request<{ tags: TrendingTag[] }>('GET', '/tags/trending', undefined, false);
    return res.tags ?? [];
  }
}
