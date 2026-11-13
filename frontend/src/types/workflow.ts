import type { Node, Edge } from "@vue-flow/core";
import type { HubState, Run, Fact } from "./console.ts";
export type StageStatus = "idle" | "done" | "running" | "waiting" | "warning";
export interface StageData {
  title: string;
  caption: string;
  value: string;
  status: StageStatus;
  icon: string;
  step: string;
}
export interface WorkflowGraph {
  nodes: Node<StageData>[];
  edges: Edge[];
}
export interface WorkflowProps {
  state: HubState | null;
  run: Run | null;
  facts: Fact[];
  live: boolean;
}
export interface WorkflowEmits {
  filter: [value: string];
  inbox: [];
}

export interface ActivityProps {
  facts: Fact[];
  connected: boolean;
}
