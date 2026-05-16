// Deploy-target registry. Each provider implements:
//   { id, label, description, deploy({ envVars, onCancel, log }) }
//
// Adding a new target = drop a sibling file (render.js, fly.js, …) and
// append it to PROVIDERS. The orchestrator (src/commands/deploy.js) picks
// among them with a `select` prompt and is otherwise provider-agnostic.

import { railwayProvider } from './railway.js';

export const PROVIDERS = [railwayProvider];

export function findProvider(id) {
  return PROVIDERS.find((p) => p.id === id) || null;
}
