export interface Totals {
  running: number;
  queued: number;
  retrying: number;
  doneToday: number;
  unknown: number;
}
export interface Spending {
  rounds: number;
  tokens: number;
  cached: number;
  cost: number;
  missingTokens: number;
  missingCost: number;
}
export interface Agent {
  name: string;
  worker: string;
  use: string;
  model?: string;
  effort?: string;
  tier?: string;
  command?: string[];
  access?: string;
  program?: string;
  timeout?: number;
  maxActive?: number;
}
export interface Rule {
  name: string;
  to: string;
  cwd: string;
  when: { source?: string; types?: string[]; cron?: string };
  prompt?: string;
  skill?: string;
  parallel?: number;
  group?: string;
  maxActive?: number;
  resume?: boolean;
  tell?: string;
}
export interface Rules {
  sources: Record<string, { name: string }>;
  agents: Record<string, Agent>;
  rules: Rule[];
}
export interface Line {
  name: string;
  agent: string;
  every?: string;
  next?: string;
  source: string;
  types: string[];
  paused: { reason: string; since: string; until?: string; skipped?: { count: number } } | null;
}
export interface Run {
  id: number;
  rule: string;
  agent: string;
  state: string;
  attempts: number;
  stopping: boolean;
  summary: string;
  error: string;
  createdAt: string;
  finishedAt: string | null;
  notBefore: string;
  session?: string;
  link?: string;
  events: { subject: string; link?: string; summary: string; type: string }[];
  usage?: Record<string, number>;
}
export interface Card {
  id: number;
  kind: string;
  title: string;
  text: string;
  options: string[];
  recommend: number | null;
  choice: number | null;
  answer: string | null;
  result: string | null;
  state: string;
  by: string | null;
  rule: string | null;
  lane: string;
  about: string;
  createdAt: string;
}
export interface State {
  seq: number;
  now: string;
  timezone: string;
  totals: Totals;
  spending: { today: Spending; week: Spending };
  agents: (Agent & {
    id: string;
    online: boolean;
    seenAt: string | null;
    limited: { until: string; reason: string } | null;
  })[];
  channels: { id: string; name: string; online: boolean; lastFailure?: { error: string } }[];
  lines: Line[];
  elsewhere: { name: string; where: string; every: string; next: string }[];
  runs: Run[];
  cards: Card[];
  recentCards: Card[];
  timers: { rule: string; lane: string; about: string; at: string }[];
  unrouted: unknown[];
  skipped: unknown[];
}
export interface Settings {
  home: string;
  url: string;
  rulesPath: string;
  configPath: string;
  owner: boolean;
  hub?: { listen: string; publicUrl?: string };
  source?: string;
  worker?: { name: string; capacity?: number; unreachable?: string[] };
  channels: string[];
  plugins: { name: string; builtin: boolean }[];
  revision: string;
}
export interface RuleFile {
  problem?: string;
  text: string;
  revision: string;
}
export interface Fact {
  seq: number;
  type: string;
  at: string;
}
export type Page = "overview" | "tasks" | "rules" | "agents" | "cards" | "delivery" | "logs" | "settings";
