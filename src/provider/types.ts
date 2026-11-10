/**
 * Provider and model type definitions.
 */

/** Supported provider identifiers. */
export type ProviderId = "zai" | "bigmodel";

/** Model definition derived from the catalog. */
export interface ModelDef {
  id: string;
  name: string;
  contextWindow: number;
  maxOutputTokens?: number;
  /** Whether the model supports reasoning/thinking mode. */
  reasoning?: boolean;
  /** Whether the model accepts image input (explicit — no id-shape heuristic). */
  vision?: boolean;
}
