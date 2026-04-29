/**
 * Public surface for the shared-lore feature.
 *
 * Callers that just want "is there lore for this agent?" should use
 * `loadActiveLoreForAgent` — it folds the registry I/O, group lookup,
 * tier roll, and snippet pick into one call. Callers that need finer
 * control can compose the lower-level helpers directly.
 */

export type { LoreArchetype } from '@/lore/catalog';
export {
  allocateGroupBudget,
  getArchetype,
  LORE_ARCHETYPE_CATALOG,
} from '@/lore/catalog';
export type { ClusterInput, LoreGroupSeed } from '@/lore/clustering';
export {
  clusterAllArchetypes,
  clusterCirclejerks,
  clusterCollaborations,
  clusterCryptic,
  clusterFanClubs,
  clusterSoloObsessions,
} from '@/lore/clustering';
export {
  buildLoreBlock,
  parseResolvedLoreReferences,
  pickLoreSnippets,
  rollLoreTier,
} from '@/lore/prompt';
export {
  emptyRegistry,
  groupsForAgent,
  incrementReferenceCount,
  LORE_REGISTRY_VERSION,
  LoreRegistryMissingError,
  loadRegistry,
  loadRegistryStrict,
  readRegistryFile,
  writeRegistryFile,
} from '@/lore/registry';

import { pickLoreSnippets, rollLoreTier } from '@/lore/prompt';
import { groupsForAgent, loadRegistry } from '@/lore/registry';
import type { LoreGroup, LoreRegistryFile, LoreShareTier, LoreSnippet } from '@/types';

/**
 * One-shot per-call helper: given the registry + agent membership lookup,
 * roll the tier gate, pick snippets, and return both. Callers feed the
 * result straight into `generateComment` / `generateReply` and emit
 * `lore_referenced` events post-hoc with the surfaced snippet ids.
 *
 * Returns `{ tier: undefined, snippets: [] }` when:
 *   - the agent is in no groups
 *   - the tier roll failed
 *   - the matching groups have no entries yet (Gemini synthesis was
 *     interrupted, etc.)
 *
 * Pure given the inputs — `rand` defaults to `Math.random` for production
 * but is overridable for tests.
 */
export function loadActiveLoreForAgent(input: {
  registry: LoreRegistryFile;
  agentname: string;
  agentnameToPersonaId?: ReadonlyMap<string, string>;
  rand?: () => number;
}): { tier: LoreShareTier | undefined; snippets: LoreSnippet[]; groups: LoreGroup[] } {
  const { registry, agentname, agentnameToPersonaId, rand = Math.random } = input;
  const groups = groupsForAgent(registry, agentname, agentnameToPersonaId);
  const tier = rollLoreTier(groups, rand);
  const snippets = tier ? pickLoreSnippets(groups, tier, undefined, rand) : [];
  return { tier, snippets, groups };
}

/** Convenience re-export of the registry loader so callers don't have to
 * pull from `@/lore/registry` separately. */
export const loadLoreRegistry = loadRegistry;
