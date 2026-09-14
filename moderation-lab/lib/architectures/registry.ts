import { baselineArchitecture } from "./baseline";
import { strategistArchitecture } from "./strategist";
import { fanoutArchitecture } from "./fanout";
import type { Architecture } from "./types";

/**
 * Add new architectures here as they get built -- each one plugs in
 * without the webhook route, the dedup/logging/state plumbing, or the
 * manual-test UI needing to change.
 */
export const ARCHITECTURES: Record<string, Architecture> = {
  baseline: baselineArchitecture,
  strategist: strategistArchitecture,
  fanout: fanoutArchitecture,
};

export function getArchitecture(name: string): Architecture | undefined {
  return ARCHITECTURES[name];
}
