import type { Rule } from "../kernel/rules.ts";
export type Job = {
  run: number;
  token: string;
  attempt: number;
  /** people: whom its receipts may address a card to; only there when the rule allows any. */
  rule: Pick<Rule, "name" | "cwd" | "skill" | "prompt" | "title" | "emits"> & {
    people?: { id: string; name: string }[];
  };
  agent: {
    id: string;
    name: string;
    use: string;
    model?: string;
    effort?: string;
    tier?: string;
    access: string;
    command?: string[];
    program?: string;
    timeout?: number;
  };
  session: string | null;
  askFirst: string[];
  context: {
    events: {
      id: string;
      source: string;
      sourceName: string;
      type: string;
      subject: string;
      summary: string;
      detail: string;
      link: string;
      receivedAt: string;
      hops?: number;
    }[];
    answers: {
      card: number;
      title: string;
      options: string[];
      choice: number | null;
      chosen: string | null;
      text: string | null;
      about: string;
      by: string | null;
      at: string;
    }[];
    timers: { key: string; about: string; at: string }[];
    waiting: { key: string; about: string; at: string }[];
    /** to: whom the card is for, when not the owner. */
    open: { card: number; title: string; text: string; at: string; to?: { id: string; name: string } }[];
    decided: { card: number; title: string; choice: string | null; at: string }[];
  };
};
