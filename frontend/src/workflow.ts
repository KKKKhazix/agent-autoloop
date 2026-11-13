import type { HubState, Run, Fact } from "./types/console.ts";
import type { WorkflowGraph, StageData, StageStatus } from "./types/workflow.ts";
import { MarkerType } from "@vue-flow/core";

/** The canvas describes scheduling facts, not unreported agent tools or internal reasoning. */
export function buildWorkflow(state: HubState | null, run: Run | null, facts: Fact[], live: boolean): WorkflowGraph {
  const relatedCards = facts.flatMap((f) =>
    f.changes.filter((c) => c.table === "cards" && Number(c.row?.run_id) === run?.id),
  );
  const latestCards = [...new Map(relatedCards.map((c) => [Number(c.row?.id), c.row])).values()];
  const waiting = run
    ? latestCards.filter((c) => c?.kind === "ask" && c.state === "open").length
    : (state?.cards.filter((c) => c.kind === "ask").length ?? 0);
  const running = run ? Number(run.state === "claimed" && !run.stopping) : (state?.totals.running ?? 0);
  const queued = run ? Number(run.state === "queued") : (state?.totals.queued ?? 0);
  const finished = run ? ["done", "nothing", "cancelled"].includes(run.state) : (state?.totals.doneToday ?? 0) > 0;
  const status = (active: boolean, complete = false): StageStatus =>
    !state ? "idle" : active ? "running" : complete ? "done" : "idle";
  const stages: [string, number, number, StageData][] = [
    [
      "events",
      20,
      50,
      {
        title: "事件来源",
        caption: run ? run.events[0]?.subject || "本轮资料" : "外部事件 · 定时触发",
        value: run
          ? `${run.events.length} 条可见资料`
          : state
            ? `${state.sources.reduce((n, s) => n + s.events, 0)} 条事件`
            : "等待连接",
        status: status(false, !!state),
        icon: "events",
        step: "01",
      },
    ],
    [
      "rules",
      310,
      50,
      {
        title: "规则匹配",
        caption: run?.rule || "可信规则决定去向",
        value: state ? (run ? "已匹配规则" : `${state.lines.length} 条规则`) : "等待连接",
        status: status(false, !!state),
        icon: "rules",
        step: "02",
      },
    ],
    [
      "queue",
      600,
      50,
      {
        title: "事项队列",
        caption: "同一事项合并 · 按组派发",
        value: state ? `${queued} 轮等待执行` : "等待连接",
        status: queued ? "waiting" : status(false, !!state),
        icon: "queue",
        step: "03",
      },
    ],
    [
      "agent",
      890,
      50,
      {
        title: "Agent 执行",
        caption: run?.agent || "接单程序领取并运行",
        value: state ? (run?.stopping ? "等待停止确认" : running ? `${running} 轮执行中` : "当前无执行") : "等待连接",
        status: run?.stopping || run?.state === "unknown" ? "warning" : status(running > 0, !!run && finished),
        icon: "agent",
        step: "04",
      },
    ],
    [
      "receipt",
      890,
      300,
      {
        title: "执行回执",
        caption: "结果 · 卡片 · 后续事件",
        value: run
          ? finished
            ? "本轮已交回结果"
            : "等待本轮结果"
          : state
            ? `${state.totals.doneToday} 轮今日完成`
            : "等待连接",
        status: status(false, finished),
        icon: "receipt",
        step: "05",
      },
    ],
    [
      "human",
      600,
      300,
      {
        title: "本人决定",
        caption: "回答后叫醒原事项",
        value: state ? `${waiting} 个问题等待回答` : "等待连接",
        status: waiting > 0 ? "waiting" : status(false),
        icon: "human",
        step: "06",
      },
    ],
    [
      "done",
      310,
      300,
      {
        title: "本轮结束",
        caption: "事项继续 · 到期再复查",
        value: run
          ? run.state === "cancelled"
            ? "本轮已停止"
            : finished
              ? "结果已记录"
              : "等待结果"
          : "事实记录可追溯",
        status: status(false, finished),
        icon: "done",
        step: "07",
      },
    ],
  ];
  const edges: WorkflowGraph["edges"] = [
    ["events", "rules"],
    ["rules", "queue"],
    ["queue", "agent"],
    ["agent", "receipt"],
    ["receipt", "done"],
    ["receipt", "human"],
    ["human", "queue"],
  ].map(([source, target]) => ({
    id: `${source}-${target}`,
    source: source!,
    target: target!,
    type: "smoothstep",
    sourceHandle:
      source === "human"
        ? "top"
        : source === "receipt" && target === "done"
          ? "bottom"
          : source === "receipt"
            ? "left"
            : source === "agent"
              ? "bottom"
              : "right",
    targetHandle:
      target === "queue" && source === "human"
        ? "bottom"
        : target === "done"
          ? "bottom"
          : target === "receipt"
            ? "top"
            : target === "human"
              ? "right"
              : "left",
    animated: live && running > 0 && (source === "queue" || source === "agent"),
    label: source === "human" ? "回答 → 新一轮" : source === "receipt" && target === "done" ? "记录结果" : undefined,
    markerEnd: MarkerType.ArrowClosed,
    style: {
      stroke: live && running > 0 && (source === "queue" || source === "agent") ? "#6366f1" : "#bfc8d9",
      strokeWidth: 1.8,
    },
  }));
  return {
    nodes: stages.map(([id, x, y, data]) => ({
      id,
      position: { x, y },
      type: "stage",
      data,
      draggable: false,
      connectable: false,
    })),
    edges,
  };
}
