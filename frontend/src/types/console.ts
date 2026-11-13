export interface RunEvent {
  source: string;
  type: string;
  subject: string;
  summary: string;
  link: string;
}
export interface Run {
  id: number;
  rule: string;
  agent: string;
  state: string;
  attempts: number;
  createdAt: string;
  claimedAt: string | null;
  finishedAt: string | null;
  notBefore: string;
  summary: string;
  error: string;
  link: string;
  session: string | null;
  stopping: boolean;
  usage: Record<string, number> | null;
  events: RunEvent[];
}
export interface Card {
  id: number;
  version: number;
  kind: string;
  state: string;
  title: string;
  text: string;
  options: string[];
  recommend: number | null;
  choice: number | null;
  answer: string | null;
  rule: string;
  createdAt: string;
}
export interface Totals {
  running: number;
  queued: number;
  retrying: number;
  unknown: number;
  done: number;
  doneToday: number;
  attention: number;
}
export interface HubState {
  now: string;
  timezone: string;
  totals: Totals;
  cards: Card[];
  recentCards: Card[];
  sources: { id: string; name: string; events: number }[];
  lines: {
    id: string;
    name: string;
    agent: string;
    source: string;
    types: string[];
    every: string | null;
    totals: Totals;
  }[];
  agents: { id: string; name: string; online: boolean; worker: string }[];
  channels: { id: string; name: string; online: boolean }[];
  runs: Run[];
  hasMore: boolean;
  nextBefore: number | null;
  unrouted: Record<string, unknown>[];
  spending: { today: { rounds: number; tokens: number; cost: number; missingTokens: number; missingCost: number } };
}
export interface Change {
  table: string;
  key: string;
  row: Record<string, unknown> | null;
}
export interface Fact {
  seq: number;
  at: number;
  type: string;
  changes: Change[];
}
export interface EventInput {
  id: string;
  type: string;
  subject?: string;
  summary?: string;
  detail?: string;
  link?: string;
}
export interface Answer {
  choice?: number;
  text?: string;
}
export type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export interface ConsoleOptions {
  fetcher?: Fetcher;
  interval?: number;
  realtime?: boolean;
}
export interface ConnectionProps {
  connected: boolean;
  busy: boolean;
}
export interface ConnectionEmits {
  connect: [key: string];
  disconnect: [];
}
export interface FlowProps {
  state: HubState | null;
}
export interface FlowEmits {
  filter: [value: string];
}
export interface RunListProps {
  runs: Run[];
  selected: number | null;
  hasMore: boolean;
  busy: boolean;
  filter: string;
}
export interface RunListEmits {
  select: [id: number];
  more: [];
  filter: [value: string];
}
export interface DetailProps {
  run: Run | null;
  facts: Fact[];
  busy: boolean;
  error: string;
  pending: boolean;
}
export interface DetailEmits {
  stop: [id: number];
  retry: [];
}
export interface InboxProps {
  cards: Card[];
  pending: boolean;
}
export interface InboxEmits {
  answer: [id: number, answer: Answer];
  resolve: [id: number, reason: string];
}
export interface EventComposerProps {
  pending: boolean;
}
export interface EventComposerEmits {
  send: [key: string, event: EventInput];
  close: [];
}

export interface CardDraft {
  choice: string;
  text: string;
  reason: string;
  resolve: boolean;
}
export interface EmittedEvent {
  event: number;
  duplicate: boolean;
  routed: string[];
}
