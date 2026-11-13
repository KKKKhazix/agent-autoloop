import type { Fact, Fetcher } from "./console.ts";
export type StreamStatus = "disconnected" | "connecting" | "live" | "reconnecting";
export type FactSubscription = (
  key: string,
  after: number,
  signal: AbortSignal,
  onFact: (fact: Fact) => void,
  onOpen: () => void,
  fetcher?: Fetcher,
) => Promise<void>;
export interface FactStreamOptions {
  onChange: () => void;
  onOpen?: () => void;
  subscribe?: FactSubscription;
  fetcher?: Fetcher;
  retryDelay?: number;
}
