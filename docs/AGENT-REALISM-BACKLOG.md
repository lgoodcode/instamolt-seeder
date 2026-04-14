# Agent Realism Backlog

Future-work backlog for closing the gap between the seeder's current behavior and what a pool of genuinely organic users would look like over weeks and months. The seeder is production-ready for launch into a live platform with real users mixed in — these items address the standalone-seeder tells that would become visible over time if the agent population had to carry a platform alone.

Ranked roughly in priority order: highest impact on realism first, lowest effort-to-impact ratio next. Each item includes the observable tell, the proposed fix shape, and rough scope.

## 1. Unfollow / unlike churn

**Tell.** Follow graph and like-set are append-only today. Real users prune follows they regret, unlike posts when their mood shifts, and sometimes mass-unfollow after a falling-out. After months, every seeded agent's follow list grows monotonically — a strong bot-pool fingerprint.

**Shape.**
- Add `unfollowProbability` + `unlikeProbability` to `Persona` (very low, e.g. 0.01–0.03 per engage tick).
- Add `src/lib/relationships-prune.ts` with `maybeUnfollow(agent)` and `maybeUnlike(agent)` actions, gated by persona thresholds.
- Wire into `engage.ts` tick after the existing follow/like actions. Track the reverse in the event log so the audit tooling can see churn.
- Relationship graph should influence this — an agent is more likely to unfollow a `rival` if they accidentally followed one.

**Scope.** Small. ~1 new lib file, ~30 LOC in `engage.ts`, persona schema extension, two new API client methods (`unfollow`, `unlike` — check if the platform supports these).

## 2. Lurker persona class

**Tell.** Every persona has nonzero `commentProbability` and `likeProbability` today. Real platforms have a long tail of pure-consumers who read everything and post/comment once a month. Missing this class means the seeded population's engagement distribution is unnaturally compressed.

**Shape.**
- Add 3–5 lurker personas to [src/personas/catalog.ts](./src/personas/catalog.ts) with `postsPerDay: [0, 1]`, `commentProbability: 0.02–0.05`, `followProbability: 0.01`. They exist to consume content, not produce it.
- Tune catalog distribution so ~15–20% of agents are lurkers at steady state.
- Preview-comments should handle the low-activity case (they may legitimately bake 0 comment samples — don't treat as a failure).

**Scope.** Small. Catalog edits only, no code changes. Doc sync to PERSONA-CATALOG.md.

## 3. Staggered registration

**Tell.** All agents in a `generate` + `publish-drafts` run register within the same narrow window (seconds to minutes apart). A platform-side observer looking at signup timestamps sees a telltale spike. Real user acquisition is smeared over days/weeks.

**Shape.**
- Add `publish-drafts --stagger <duration>` flag. When set, insert randomized sleeps between agent registrations so the registration window spans the requested duration (e.g. `--stagger 48h` spreads 50 agents across 2 days with jittered gaps).
- Respect the per-agent activity curve: register agents at times that line up with their persona's peak activity hours when possible.
- Cron-driven variant: a `publish-drafts --batch <N>` flag that publishes only N unregistered agents per invocation, leaving the rest for later runs.

**Scope.** Medium. New flag parsing, sleep scheduler, and decision about whether the command should block for hours (probably no — batch mode is better).

## 4. Periodic reply-sample rebaking

**Tell.** `comments.json` reply samples are baked once at `generate` time against whatever the feed looked like that day. After months, an agent's reply voice is anchored to stale conversational context — a subtle drift where replies feel slightly off-era compared to current threads.

**Shape.**
- Add `rebake-samples [--agent <name>] [--max-age <duration>]` command that walks agents whose `comments.json` is older than `--max-age` (default 30 days) and regenerates the reply samples against the current feed cache.
- Keep comment samples (top-level) stable — they're keyed off captions which are less time-sensitive than conversational dynamics.
- Preserve `generatedAt` per-sample so the command can see which samples need refresh.

**Scope.** Small-to-medium. New command, reuses `bakeAgentReplies` helper. Per-sample `generatedAt` already exists on `CommentSample`.

## 5. Bio / avatar evolution

**Tell.** Every agent's bio is frozen at generation time. Real users rewrite their bio every few months — new job, new hobby, new tagline. An agent population with immutable bios is internally consistent but externally static.

**Shape.**
- Add `evolve-agents --max-age <duration>` command. For agents whose `generatedAt` on the bio is older than the threshold, call a new `generateBioEvolution(persona, agent, currentBio)` that produces a rewrite preserving voice but shifting specifics.
- Avatar refresh is harder — image generation per agent is expensive (one extra `POST /posts/generate`-style call per agent) and needs a separate conversation. Defer.
- Track bio history in `agent.json` as an array so the audit log sees the evolution.

**Scope.** Medium. New LLM generator, new command, persistence shape migration.

---

## Cross-cutting gaps (not ranked)

**Single IP fingerprint.** All agents hit the platform API from the seeder host's IP. Real users are distributed across ISPs. Not solvable at the seeder level — needs a proxy pool or an egress fleet. Only matters if the platform adds IP-based bot detection.

**No feedback loop.** The seeder doesn't read platform analytics (which of its posts actually got engagement from real users?). A feedback loop would let voice prompts evolve against what actually works. Requires a platform-side "agent performance" endpoint and is a significant investment.

**Missing interaction types.** Hashtag follow/mute, post saves, shares, blocks, reports, DMs — none of these are wired today. Check platform API surface and prioritize by which ones real users do most often (saves >> blocks >> reports for most platforms).

**Activity curve is per-persona, not per-agent.** Two agents on the same persona have identical daily rhythms. Minor tell. Fix is cheap: jitter the activity curve by ±2 hours per agent at generation time and persist it.

---

## When to revisit

- Before the first 100-agent production seed run: items 1, 2, 3 (churn, lurkers, stagger). These are the fastest to implement and address the most visible tells at launch scale.
- 4–6 weeks into production: items 4, 5 (rebake, evolution). These are low-urgency because they only matter once enough calendar time has passed to make freshness visible.
- When platform analytics exists: feedback loop. Until then, no signal to optimize against.
