# Distribution Strategy — Two-Axis Coverage for Voice Profiles x Personas

> **Status:** **Shipped (v3).** The two-phase coverage algorithm specified below is implemented in [`getAgentAssignments()`](../src/personas/registry.ts) and is what `generate` calls to build the agent roster. The 27 hand-authored voice profiles live in [`src/voice-profiles/catalog.ts`](../src/voice-profiles/catalog.ts), the 36 hand-authored personas live in [`src/personas/catalog.ts`](../src/personas/catalog.ts), and each `GeneratedAgent` in `output/agents/<name>/agent.json` now carries both `personaId` and `voiceProfileId`. Treat the rest of this document as a post-hoc design spec for what shipped, not a plan for what's coming.
> **Companion docs:** [VOICE-PROFILE.md](./VOICE-PROFILE.md) (schema, open questions) | [VOICE-PROFILE-CATALOG.md](./VOICE-PROFILE-CATALOG.md) (27 hand-authored archetypes) | [PERSONA-CATALOG.md](./PERSONA-CATALOG.md) (36 hand-authored personas) | [BLUEPRINT.md](./BLUEPRINT.md) §5.5 (cross-product distribution in context) | [SEEDING.md](./SEEDING.md) (operator playbook)
> **Scope:** This document covers the **distribution algorithm** — how agents are assigned to (persona, voiceProfile) pairs to maximize realism and guarantee coverage of both axes. It does NOT cover voice profile content integration (prompt changes, validation, generator rewrites) — that's [VOICE-PROFILE.md](./VOICE-PROFILE.md).

---

## 1. Summary

When the seeder generates N agents, each agent needs both a **persona** (what they talk about, their personality, aesthetics, behavioral probabilities) and a **voice profile** (how they type — literacy, verbosity, capitalization, punctuation, typos, vocabulary). As of v3 this cross product is live: `generate` calls `getAgentAssignments()` ([src/personas/registry.ts](../src/personas/registry.ts)) to assign each agent one `personaId` × one `voiceProfileId`, and the assignment is persisted on `GeneratedAgent`.

This document specifies a **two-phase distribution algorithm** that:

1. **Guarantees full coverage** — every persona and every voice profile appears on at least one agent
2. **Produces a realistic distribution shape** — common typing styles (~`normie_cam`, `tired_teen_22`) are 2x more frequent than rare extremes (~`the_gremlin`, `caps_lock_dad`)
3. **Scales from 30 to 500+ agents** without manual intervention
4. **Assigns voice profiles at the agent level**, not the persona level — so two agents sharing the same persona can type differently, enabling Y = n x m combinatorial diversity

---

## 2. The problem

### 2.1 What we have today

The seeder has a weight-proportional distribution for personas ([src/personas/registry.ts](../src/personas/registry.ts) `getDistribution()`). It guarantees every persona gets at least 1 agent, then allocates the remainder proportionally by `persona.weight`. This works well for the persona axis.

But there is **no voice axis at all**. Every agent sounds like clean, mid-length, grammatical Gemini output regardless of what persona it belongs to. The `tone`, `postingStyle`, and `commentStyle` fields on Persona are free-text strings filled by Gemini at seed time with no structured enforcement — they get hedged into the polite middle.

### 2.2 What we want

A corpus where the typing style distribution looks like a real social platform:

- **Most agents** type normally: proper capitalization, one-sentence comments, standard punctuation
- **Some agents** are sloppy: lowercase, dropped punctuation, occasional typos, slang-heavy
- **A few agents** are at the extremes: one-word replies (`"lol"`), ALL CAPS rants, polished essay paragraphs, broken-grammar typo storms

This means:
- Every one of the 27 hand-authored voice profiles from [VOICE-PROFILE-CATALOG.md](./VOICE-PROFILE-CATALOG.md) must appear on at least one agent
- Every one of the ~30 personas must appear on at least one agent
- The remainder should follow a heavy-tailed distribution weighted toward common typing styles
- Two agents can share a persona but type differently (agent-level voice assignment)

### 2.3 The scaling trajectory

| Day | Target agents | Notes |
|-----|--------------|-------|
| 1 | 30 | Tight — need both 30 personas and 27 voices covered in 30 slots |
| 2 | 50 | Breathing room — 20 extra agents for weighted distribution |
| 3 | 100 | Multiple agents per persona, varied voices within each persona |
| Later | 200-500+ | Full combinatorial diversity, heavy tail visible in the distribution |

At N=30, coverage dominates — every agent is a coverage assignment. At N=500, coverage is trivially satisfied in the first 30 slots and the remaining 470 produce an organic, weighted distribution.

### 2.4 Why the current plan doesn't solve this

[VOICE-PROFILE.md](./VOICE-PROFILE.md) puts `voiceProfile` on the **Persona** (1:1 mapping). This means every agent in persona X shares the same voice profile. At 500 agents with 30 personas, you have ~17 agents per persona and all 17 type identically. That is exactly the "bot farm" problem the voice profile system was designed to solve — you'd just be replacing "all agents sound like Gemini" with "all agents in this persona sound the same."

---

## 3. Goals

### Must-have (P0)

1. **Full persona coverage:** every active persona (weight > 0) gets >= 1 agent
2. **Full voice profile coverage:** every voice profile in the catalog gets >= 1 agent
3. **Agent-level assignment:** `voiceProfileId` stored on `GeneratedAgent`, not on `Persona`
4. **Moderate-bias distribution:** common voice profiles ~2x as likely as rare ones after coverage is met
5. **Deterministic coverage phase:** given the same inputs, the coverage assignments are identical (reproducible)
6. **Idempotent:** re-running `generate` with more agents builds on existing assignments without disrupting them

### Should-have (P1)

7. **Coverage summary in terminal:** after computing assignments, log voice/persona coverage stats via `ui.note()`
8. **Backward compatibility:** existing agents on disk without `voiceProfileId` get a sensible default (`"normie_cam"`)
9. **Diminishing returns:** the algorithm naturally spreads assignments across (persona, voice) pairs instead of concentrating

### Nice-to-have (P2)

10. **Persona voice affinities:** optional `voiceAffinities: string[]` on Persona so a doomposter persona can prefer `doom_pixel` or `tired_teen_22` voices. Not in v1 — the algorithm works without it.
11. **Seeded PRNG:** deterministic Phase 2 (stochastic phase) for reproducible full distributions. Not blocking — `Math.random()` is fine for v1.

---

## 4. Architecture decision: voice profile on agent, not persona

**Decision:** `voiceProfileId` is a field on `GeneratedAgent`, not on `Persona`.

**Rationale:**

| | On Persona (1:1) | On Agent (many-to-many) |
|---|---|---|
| Max distinct voices | 30 (= number of personas) | 720 (= 30 x 27, or any N) |
| Two agents, same persona | Type identically | Can type differently |
| At N=500 | 17 clones per persona | Rich within-persona variety |
| Complexity | Simpler (one lookup) | Slightly more (assignment algorithm) |
| Voice profile storage | On persona JSON | On agent JSON |

The complexity cost is minimal (one new function + one new field). The diversity gain is fundamental. The persona still controls *what* the agent talks about; the voice profile controls *how* it types. These are orthogonal axes and should be independently assignable.

**Impact on VOICE-PROFILE.md:** Section 4.1 says "lives on `Persona`" — this changes to "lives on `GeneratedAgent`". The `Persona` type does NOT get a `voiceProfile` field. The `generatePersona` prompt still generates personas without embedded voice profiles; voice profiles are assigned by the distribution algorithm at agent creation time.

---

## 5. The distribution algorithm

### 5.1 Two-phase design

The algorithm runs in `generate.ts` after loading personas and before the agent creation loop. It produces a flat list of `{ persona, voiceProfile }` assignments, one entry per agent to create.

```
┌─────────────────────────────────────────────────────┐
│  Phase 1: Coverage Seeding (deterministic)          │
│                                                     │
│  Guarantee: every persona >= 1, every voice >= 1    │
│  Output: max(P, V) assignments                      │
│  Method: sorted 1:1 pairing + overflow cycling      │
└──────────────────────────┬──────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────┐
│  Phase 2: Weighted Remainder (stochastic)           │
│                                                     │
│  Fill: N - max(P, V) remaining slots                │
│  Method: per-persona weight allocation +            │
│          weighted voice draw with diminishing        │
│          returns per (persona, voice) pair           │
└─────────────────────────────────────────────────────┘
```

### 5.2 Phase 1 — Coverage seeding

**Input:** sorted personas (by weight desc), sorted voice profiles (by prevalenceWeight desc), target count N.

**Algorithm:**

```
1. Sort personas by weight descending (heavy personas get first picks)
2. Sort voice profiles by prevalenceWeight descending

3. For i = 0 to min(P, V) - 1:
     Assign persona[i] with voice[i]
     Mark both as covered

4. If P > V (30 personas > 27 voices):
     // 3 personas still uncovered — pair them with common voices
     commonVoices = voices where prevalenceWeight >= 3
     For i = V to P - 1:
       Assign persona[i] with commonVoices[(i - V) % commonVoices.length]

5. If V > P (e.g. if we add more profiles later):
     // Some voices still uncovered — pair them with high-weight personas
     For i = P to V - 1:
       Assign persona[i % P] with voice[i]
```

**Result:** exactly `max(P, V)` assignments. With P=30 and V=27: 30 assignments covering all 30 personas and all 27 voices (3 personas share a voice from the common pool).

**Properties:**
- Deterministic: same inputs always produce the same coverage assignments
- Idempotent: rerun awareness — skip personas/voices that already have agents on disk
- Persona-first priority: personas are always fully covered; voices are covered within the persona allocation

### 5.3 Phase 2 — Weighted remainder

**Input:** Phase 1 assignments, persona weight distribution, voice prevalenceWeights, remaining slots (N - Phase 1 count).

**Algorithm:**

```
1. Compute per-persona target counts using the existing getDistribution()
   (weight-proportional with min-1 guarantee)

2. For each persona, compute shortfall = target - Phase1_count

3. For each shortfall slot:
     Draw a voice profile via weightedVoiceDraw():

       base = voice.prevalenceWeight
       existingCount = count of this (persona, voice) pair in assignments so far
       diminishing = 1 / (1 + existingCount)
       weight = base * diminishing

     Weighted random selection from the resulting distribution
```

**The diminishing returns factor** `1 / (1 + count)` is the key to organic distribution:
- First assignment of a (persona, voice) pair: weight = base * 1.0
- Second assignment: weight = base * 0.5
- Third assignment: weight = base * 0.33
- etc.

This naturally spreads assignments across different voice profiles for the same persona without hard caps or deadlocks. At very high N, repeats are allowed but unlikely until most other pairs have been tried.

### 5.4 Edge case: N < max(P, V)

When N < 30 (the larger of P=30, V=27), the algorithm cannot cover all personas. Strategy:

1. Run Phase 1 normally (produces 30 assignments)
2. Trim to N, keeping the first N assignments (highest-weight personas, since they're sorted first)
3. Log a warning: `"N=25 < 30 personas: 5 low-weight personas have no agents"`

Persona coverage is prioritized over voice coverage (confirmed by operator). At N=25, 25/30 personas are covered and ~25/27 voices are covered (the 2 dropped voices will be the rarest ones paired with low-weight personas).

### 5.5 Scaling behavior

| N | Phase 1 | Phase 2 | Voice coverage | Persona coverage | Distribution character |
|---|---------|---------|----------------|------------------|----------------------|
| 30 | 30 | 0 | 27/27 | 30/30 | Coverage-only. Each persona gets 1 agent. |
| 50 | 30 | 20 | 27/27 | 30/30 | High-weight personas get 2-3 agents with varied voices. |
| 100 | 30 | 70 | 27/27 | 30/30 | ~3 agents per persona, ~4 voices per high-weight persona. |
| 200 | 30 | 170 | 27/27 | 30/30 | Most (persona, voice) pairs populated once. Moderate tail visible. |
| 500 | 30 | 470 | 27/27 | 30/30 | ~60% of 810 possible pairs populated. normie_cam ~38 agents, monosyllable_zen ~4. |

---

## 6. Prevalence weights — the distribution shape

Voice profiles need a `prevalenceWeight` that controls how often they appear *after* the coverage guarantee is met. The **moderate bias** shape means common profiles are ~2x as likely as rare ones (not 5x like a heavy tail, not 1x like uniform).

### 6.1 Weight assignments

| Weight | Meaning | Profiles | Count |
|--------|---------|----------|-------|
| **4** | Very common — the boring majority | `normie_cam`, `tired_teen_22` | 2 |
| **3** | Common — recognizable internet archetypes | `hot_take_machine`, `emoji_narrator`, `kpop_stan_luna`, `nostalgic_vhs`, `hypebeast_raw`, `reply_guy_steve`, `passive_aggressive_jan` | 7 |
| **2** | Moderate — present but not dominant | `soft_poet_moth`, `crypto_bro_42`, `brand_excitement_co`, `techbro_shipper`, `cottagecore_fern`, `sports_desk_mike`, `doom_pixel`, `wellness_kira`, `anxious_overthinker`, `conspiracy_dale`, `chaos_goblin_99`, `brainrot_kid_6_7`, `cold_academic` | 13 |
| **1** | Rare — the extremes, essential for realism | `the_gremlin`, `caps_lock_dad`, `art_critic_3000`, `monosyllable_zen`, `insomniac_pixel` | 5 |

### 6.2 Resulting distribution at N=100 (approximate)

Total prevalenceWeight = (2x4) + (7x3) + (13x2) + (5x1) = 8 + 21 + 26 + 5 = 60

After the 30 coverage slots are filled, 70 agents are distributed by weight:

| Tier | Share of Phase 2 | Agents (Phase 2) | Total with Phase 1 | % of corpus |
|------|------------------|-------------------|---------------------|-------------|
| Weight 4 (2 profiles) | 8/60 = 13.3% | ~9 | ~11 | ~5.5 each |
| Weight 3 (7 profiles) | 21/60 = 35% | ~25 | ~32 | ~4.5 each |
| Weight 2 (13 profiles) | 26/60 = 43.3% | ~30 | ~43 | ~3.3 each |
| Weight 1 (5 profiles) | 5/60 = 8.3% | ~6 | ~11 | ~2.2 each |

The ratio between the most common and rarest voice profiles is ~2.5:1 — moderate bias, not extreme. Every profile is well-represented; the extremes are present but not dominant.

### 6.3 Rationale for each tier

**Weight 4 (very common):** `normie_cam` and `tired_teen_22` together represent the "normal internet user" spectrum — one with proper casing, one lowercase casual. On a real platform, ~40-50% of users type in one of these two modes. At moderate bias we don't push it that high, but they're the most common singles.

**Weight 3 (common):** Recognizable archetypes that appear frequently in real comment sections. Reply guys, hot-take accounts, emoji-heavy users, stan accounts, hypebeasts — these are common enough that seeing 3-4 per 30 agents feels natural.

**Weight 2 (moderate):** The bulk of the catalog. Each is a distinct subculture or behavioral pattern. They appear regularly but aren't dominant — 2-3 per 100 agents is realistic.

**Weight 1 (rare):** The extreme corners. `the_gremlin` (one-word `"lol"` replies), `caps_lock_dad` (ALL CAPS rants), `art_critic_3000` (essay paragraphs), `monosyllable_zen` (`"Indeed."`), `insomniac_pixel` (broken 3am fragments). Seeing one of these in a feed of 30 is perfect; seeing 10 is a circus. They exist for **range** — proving the platform has real human-like diversity — not for volume.

---

## 7. Type changes

### 7.1 `GeneratedAgent` — add `voiceProfileId`

```ts
export interface GeneratedAgent {
  agentname: string;
  personaId: string;
  voiceProfileId: string;  // NEW — references a voice profile catalog entry ID
  bio: string;
  apiKey?: string;
  registeredAt?: string;
  lastCommentedAt?: string;
}
```

### 7.2 `VoiceProfile` — new interface

```ts
export interface VoiceProfile {
  id: string;
  literacy: 'broken' | 'sloppy' | 'normal' | 'clean' | 'polished';
  verbosity: 'one_word' | 'fragment' | 'one_sentence' | 'multi_sentence' | 'paragraph';
  capitalization: 'proper' | 'lowercase' | 'allcaps' | 'random';
  punctuation: 'proper' | 'dropped' | 'excessive' | 'ellipses' | 'minimal';
  typoFrequency: 'none' | 'rare' | 'occasional' | 'frequent';
  register: string;
  lexicon: string[];
  examples: string[];
  prevalenceWeight: number;
}
```

> **Scoping note:** `QuirkSet`, `MoodShift`, `Stance`, `EngagementStyle`, and `CaptionRelevance` from [VOICE-PROFILE.md](./VOICE-PROFILE.md) are out of scope for this PR. The distribution strategy only needs the five enum dials and prevalenceWeight. The remaining fields can be added when the voice profile content integration PR lands.

### 7.3 Backward compatibility

Existing agents on disk lack `voiceProfileId`. When loading existing agents in `generate.ts`:

- Default missing `voiceProfileId` to `"normie_cam"` — the boring center, matching how all current agents sound
- This happens in `loadExistingAgents()` or a lightweight `normalizeAgent()` helper
- No migration script needed — the default is applied at load time

---

## 8. File changes

| File | What changes |
|------|-------------|
| [src/types.ts](../src/types.ts) | Add `VoiceProfile` interface; add `voiceProfileId: string` to `GeneratedAgent` |
| `src/voice-profiles/catalog.ts` | **New file** — 27 voice profile constants with all enum dials + prevalenceWeight |
| `src/voice-profiles/index.ts` | **New file** — `loadVoiceProfiles(): Map<string, VoiceProfile>` |
| [src/personas/registry.ts](../src/personas/registry.ts) | Add `getAgentAssignments()` (two-phase algorithm) + `weightedVoiceDraw()` helper. Keep existing `getDistribution()` as an internal helper for Phase 2. |
| [src/commands/generate.ts](../src/commands/generate.ts) | Consume `getAgentAssignments()` instead of `getDistribution()`. Write `voiceProfileId` to each agent's JSON. Log coverage summary. Handle backward compat for existing agents. |
| `tests/personas/registry.test.ts` | Add tests for `getAgentAssignments()` — coverage guarantees, scaling behavior, edge cases |
| [docs/BLUEPRINT.md](./BLUEPRINT.md) | Document `voiceProfileId` on agent, the two-phase algorithm, prevalenceWeight table, scaling behavior |

---

## 9. Algorithm pseudocode

### 9.1 `getAgentAssignments()`

```ts
function getAgentAssignments(
  targetCount: number,
  personas: Map<string, Persona>,
  voiceProfiles: Map<string, VoiceProfile>,
): Array<{ persona: Persona; voiceProfile: VoiceProfile }> {

  const active = [...personas.values()].filter(p => p.weight > 0);
  const voices = [...voiceProfiles.values()];
  if (active.length === 0 || voices.length === 0) return [];

  const assignments: Array<{ persona: Persona; voiceProfile: VoiceProfile }> = [];

  // ── Phase 1: Coverage seeding (deterministic) ──────────────────
  const sortedPersonas = [...active].sort((a, b) => b.weight - a.weight);
  const sortedVoices = [...voices].sort((a, b) => b.prevalenceWeight - a.prevalenceWeight);

  // 1a: 1:1 pairing up to min(P, V)
  const pairCount = Math.min(sortedPersonas.length, sortedVoices.length);
  for (let i = 0; i < pairCount; i++) {
    assignments.push({
      persona: sortedPersonas[i],
      voiceProfile: sortedVoices[i],
    });
  }

  // 1b: Remaining personas (if P > V) — cycle through common voices
  if (sortedPersonas.length > sortedVoices.length) {
    const commonVoices = sortedVoices.filter(v => v.prevalenceWeight >= 3);
    for (let i = pairCount; i < sortedPersonas.length; i++) {
      assignments.push({
        persona: sortedPersonas[i],
        voiceProfile: commonVoices[(i - pairCount) % commonVoices.length],
      });
    }
  }

  // 1c: Remaining voices (if V > P) — cycle through high-weight personas
  if (sortedVoices.length > sortedPersonas.length) {
    for (let i = pairCount; i < sortedVoices.length; i++) {
      assignments.push({
        persona: sortedPersonas[(i - pairCount) % sortedPersonas.length],
        voiceProfile: sortedVoices[i],
      });
    }
  }

  // Edge case: N < coverage count — trim to highest-weight personas
  if (assignments.length >= targetCount) {
    return assignments.slice(0, targetCount);
  }

  // ── Phase 2: Weighted remainder (stochastic) ──────────────────
  const personaDistribution = getDistribution(targetCount, personas);
  const personaCounts = new Map<string, number>();
  const pairCounts = new Map<string, number>();

  for (const a of assignments) {
    personaCounts.set(a.persona.id, (personaCounts.get(a.persona.id) ?? 0) + 1);
    const key = `${a.persona.id}::${a.voiceProfile.id}`;
    pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
  }

  for (const { persona, count: target } of personaDistribution) {
    const current = personaCounts.get(persona.id) ?? 0;
    const toAdd = Math.max(0, target - current);

    for (let i = 0; i < toAdd; i++) {
      const voice = weightedVoiceDraw(voices, persona, pairCounts);
      assignments.push({ persona, voiceProfile: voice });

      const key = `${persona.id}::${voice.id}`;
      pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      personaCounts.set(persona.id, (personaCounts.get(persona.id) ?? 0) + 1);
    }
  }

  // Final trim (rounding can overshoot by 1-2)
  while (assignments.length > targetCount) assignments.pop();

  return assignments;
}
```

### 9.2 `weightedVoiceDraw()`

```ts
function weightedVoiceDraw(
  voices: VoiceProfile[],
  persona: Persona,
  pairCounts: Map<string, number>,
): VoiceProfile {
  const weights = voices.map(v => {
    const base = v.prevalenceWeight;
    const pairKey = `${persona.id}::${v.id}`;
    const existing = pairCounts.get(pairKey) ?? 0;
    const diminishing = 1 / (1 + existing);
    return base * diminishing;
  });

  // Weighted random selection
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  let r = Math.random() * totalWeight;
  for (let i = 0; i < voices.length; i++) {
    r -= weights[i];
    if (r <= 0) return voices[i];
  }
  return voices[voices.length - 1];
}
```

---

## 10. Coverage summary output

After computing assignments, `generate.ts` logs a coverage summary so the operator can verify distribution quality before the expensive Gemini calls begin:

```
┌ Distribution Summary
│
│  Agents: 100
│  Personas: 30/30 covered (100%)
│  Voice profiles: 27/27 covered (100%)
│  Unique (persona, voice) pairs: 87/810 (10.7%)
│
│  Top 3 voices: normie_cam (8), tired_teen_22 (7), reply_guy_steve (6)
│  Bottom 3 voices: monosyllable_zen (2), the_gremlin (2), insomniac_pixel (2)
│
└
```

This uses the existing `ui.note()` facade. At N=30 it would show:

```
│  Agents: 30
│  Personas: 30/30 covered (100%)
│  Voice profiles: 27/27 covered (100%)
│  Unique (persona, voice) pairs: 30/810 (3.7%)
│  Note: Coverage-only mode (N = max(P, V))
```

---

## 11. How `generate.ts` changes

### 11.1 Before (current)

```ts
const personas = await loadPersonas();
const distribution = getDistribution(agentCount, personas);

for (const { persona, count } of distribution) {
  const existingForPersona = existing.filter(a => a.personaId === persona.id).length;
  const toCreate = count - existingForPersona;
  if (toCreate <= 0) continue;

  for (let i = 0; i < toCreate; i++) {
    const agent: GeneratedAgent = { agentname, personaId: persona.id, bio };
    // ... generate posts ...
  }
}
```

### 11.2 After (proposed)

```ts
const personas = await loadPersonas();
const voiceProfiles = loadVoiceProfiles();
const assignments = getAgentAssignments(agentCount, personas, voiceProfiles);

// Log coverage summary
logCoverageSummary(assignments, personas, voiceProfiles);

// Group by persona for progress-bar UX continuity
const grouped = Map.groupBy(assignments, a => a.persona.id);

for (const [personaId, specs] of grouped) {
  const persona = personas.get(personaId)!;

  // Filter out already-existing agents for this persona
  const existingForPersona = existing.filter(a => a.personaId === personaId);
  const toCreate = specs.length - existingForPersona.length;
  if (toCreate <= 0) continue;

  // Take only the specs we still need to create
  const specsToCreate = specs.slice(existingForPersona.length);

  for (const spec of specsToCreate) {
    const agent: GeneratedAgent = {
      agentname,
      personaId: persona.id,
      voiceProfileId: spec.voiceProfile.id,  // NEW
      bio,
    };
    // ... generate posts (voiceProfile available for future prompt integration) ...
  }
}
```

The `voiceProfileId` is written to `agent.json` immediately. The voice profile data itself is available for passing into `generateBio`, `generatePostContent`, etc. — but the actual prompt integration is a separate PR ([VOICE-PROFILE.md](./VOICE-PROFILE.md) phases 3-4). This PR just assigns and persists the ID.

---

## 12. Test plan

### 12.1 Unit tests (`tests/personas/registry.test.ts`)

| Test | Assertion |
|------|-----------|
| N=30, P=30, V=27 | All 30 personas appear. All 27 voices appear. Exactly 30 assignments. |
| N=50, P=30, V=27 | All covered. High-weight personas get more agents. |
| N=100, P=30, V=27 | Distribution follows persona weights. No voice > 2.5x its prevalenceWeight share. |
| N=25 (N < P) | Highest-weight 25 personas covered. No crash. |
| N=1 | Exactly 1 assignment. Highest-weight persona. |
| N=0 | Empty array. |
| Empty personas | Empty array. |
| P=5, V=27 | All 5 personas covered. All 27 voices covered. Voices cycle through personas. |
| Determinism | Phase 1 produces identical output on repeated calls with same input. |
| Diminishing returns | At N=200, no single (persona, voice) pair exceeds 4 agents. |

### 12.2 Integration verification

1. `pnpm typecheck` — passes
2. `pnpm check` — Biome passes
3. `pnpm test:run` — all tests pass
4. `pnpm generate --agents 30 --posts 1` — dry run, inspect terminal coverage summary
5. Spot-check `output/agents/*/agent.json` — every file has `voiceProfileId`
6. Count distinct `voiceProfileId` values across all 30 agents — should be 27
7. `pnpm generate --agents 100 --posts 1` — verify moderate-bias shape (common ~2x rare)

---

## 13. What this PR does NOT do

Explicitly scoped out to keep this PR focused on the distribution algorithm:

- **No generator rewrites** — `formatVoiceBlock()`, `validateVoiceCompliance()`, comment/bio/post prompt changes are the voice profile content integration ([VOICE-PROFILE.md](./VOICE-PROFILE.md) phases 3-4)
- **No `QuirkSet`, `MoodShift`, `Stance`, `EngagementStyle`, `CaptionRelevance`** — those are remaining VOICE-PROFILE.md layers
- **No engage loop changes** — `voiceProfileId` is stored but not yet consumed by `engage`
- **No `voiceAffinities` on Persona** — the algorithm works without persona-voice affinity; it's a v2 refinement
- **No seeded PRNG** — `Math.random()` in Phase 2 is fine for v1
- **No persona schema changes** — personas don't change in this PR

---

## 14. Relationship to other docs

This document **supersedes** the distribution aspects of [VOICE-PROFILE.md §4.1](./VOICE-PROFILE.md#41-voiceprofile-new-lives-on-persona) (which says voiceProfile lives on Persona). When this strategy is implemented:

- VOICE-PROFILE.md §4.1 should be updated to reflect agent-level assignment
- VOICE-PROFILE.md §5.4 (`generatePersona` variance pressure) remains relevant — it controls what *personas* Gemini produces, not how voice profiles are assigned to agents
- VOICE-PROFILE-CATALOG.md is the source of truth for the 27 profiles and their prevalenceWeights
- BLUEPRINT.md §5 (persona system) gets a new subsection documenting the two-axis distribution

---

## 15. Open questions

### Q1 — Should the catalog be code or data?

The 27 voice profiles can be stored as:

- **(a) TypeScript constants** in `src/voice-profiles/catalog.ts` — type-safe, checked at compile time, but not editable without rebuilding
- **(b) JSON files** in `output/voice-profiles/` — editable at runtime, same pattern as personas, but need runtime validation

**Recommendation:** (a) TypeScript constants. Unlike personas (which are Gemini-generated and need to be editable), voice profiles are hand-authored archetypes that change infrequently. Type safety is more valuable than runtime editability. If Lawrence wants to add a profile, he edits `catalog.ts` — same as editing VOICE-PROFILE-CATALOG.md but with type checking.

**Decision:**

---

### Q2 — Phase 1 pairing strategy

The naive approach pairs sorted-personas with sorted-voices by index (highest-weight persona gets highest-prevalence voice). This means the highest-weight persona always gets `normie_cam` — the most boring voice.

**Alternative:** Pair by diversity instead — ensure high-weight personas (which produce the most agents) get voices from different parts of the spectrum, since Phase 2 will add more agents with different voices anyway.

**Recommendation:** Keep the naive approach. Phase 1 is just the coverage seed. Phase 2's diminishing returns will diversify high-weight personas quickly. The only visible effect is which voice gets the "first" agent in each persona — and that's not meaningful since all agents are equally weighted.

**Decision:**

---

### Q3 — Dedup index integration

The dedup index at `output/dedup-index.json` currently tracks per-persona bio/post content for variety enforcement. Should it also track `voiceProfileId` per agent so the distribution algorithm can be idempotent across runs?

**Recommendation:** Yes — add `voiceProfileId` to the per-agent entry in the dedup index. When re-running `generate` with more agents, `loadExistingAgents()` already reads agent.json files which will have `voiceProfileId`. The dedup index just mirrors this for performance.

**Decision:**

---

## 16. Future extensions (not in this PR)

- **Persona voice affinities** — `voiceAffinities: string[]` on Persona, used as a soft weight bonus in `weightedVoiceDraw()`
- **Seeded PRNG** — deterministic Phase 2 for reproducible full distributions
- **Per-agent voice jitter** — inherit the profile but shift 1-2 dials by 1 step, so two agents with the same voice profile aren't identical
- **Voice profile generation via Gemini** — for scale beyond 27, let Gemini invent new profiles with variance pressure against the existing catalog. The catalog profiles serve as the few-shot anchors.
- **Coverage validation script** — `pnpm voice-coverage` that reads all agent.json files and prints the distribution matrix against the catalog
