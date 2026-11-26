// Project policy for the goal loop. The hub routes and journals the validated events through its regular receipt protocol.
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export type Project = { id: string; goal: string; acceptance: string; maxRounds: number; requiredText?: string[] };
export type Role = "plan" | "draft" | "review";
type Event = { type: string; source: string; subject: string; detail: string };
type Outbound = Omit<Event, "source"> & { id: string };
type Reply = { summary: string; events?: Outbound[] };
type Turn = { input: string; automatic?: Reply; accept(value: unknown): Reply };
type Task = { round: number; capability: "draft" | "review"; task: string; acceptance: string };
type WorkResult = {
  status: "done" | "blocked";
  output: string;
  evidence: string;
  verdict?: "pass" | "revise";
  artifact?: string;
};

function object(value: unknown, fields: string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("需要 JSON 对象");
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some((key) => !fields.includes(key))) throw new Error("包含未授权字段");
  return item;
}

function words(value: unknown, limit: number) {
  if (typeof value !== "string" || !value.trim() || value.length > limit || !value.isWellFormed())
    throw new Error("文字缺失或超过长度");
  return value.trim();
}

// Budget the JSON representation before accepting model text: the draft is copied into its review receipt.
function packetWords(value: unknown, limit: number) {
  const text = words(value, limit);
  if ([...JSON.stringify(text)].length - 2 > limit) throw new Error("文字的 JSON 编码超过交接预算");
  return text;
}

export function projectConfig(value: unknown): Project {
  const input = object(value, ["id", "goal", "acceptance", "maxRounds", "requiredText"]);
  const id = words(input.id, 40);
  if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error("项目编号无效");
  // Each execution round emits two events. Four executions return to the planner exactly at the hub's eight-hop limit.
  if (
    typeof input.maxRounds !== "number" ||
    !Number.isInteger(input.maxRounds) ||
    input.maxRounds < 1 ||
    input.maxRounds > 4
  )
    throw new Error("轮数须为 1 到 4");
  if (input.requiredText !== undefined && (!Array.isArray(input.requiredText) || input.requiredText.length > 8))
    throw new Error("必含文字最多 8 项");
  const requiredText = (input.requiredText as unknown[] | undefined)?.map((value) => words(value, 120));
  return {
    ...(requiredText ? { requiredText } : {}),
    id,
    goal: words(input.goal, 2000),
    acceptance: words(input.acceptance, 1500),
    maxRounds: input.maxRounds,
  };
}

function taskOf(value: unknown, project: Project): Task {
  const input = object(value, ["round", "capability", "task", "acceptance"]);
  const { round, capability } = input;
  if (
    typeof round !== "number" ||
    !Number.isInteger(round) ||
    round < 1 ||
    round > project.maxRounds ||
    (capability !== "draft" && capability !== "review")
  )
    throw new Error("任务轮次或能力超出项目规则");
  return { round, capability, task: packetWords(input.task, 700), acceptance: packetWords(input.acceptance, 400) };
}

function resultOf(value: unknown): WorkResult {
  const input = object(value, ["status", "output", "evidence", "verdict", "artifact"]);
  if (input.verdict !== undefined && input.verdict !== "pass" && input.verdict !== "revise")
    throw new Error("审查结论无效");
  if (input.status !== "done" && input.status !== "blocked") throw new Error("回执状态无效");
  return {
    status: input.status,
    output: packetWords(input.output, 1000),
    evidence: packetWords(input.evidence, 350),
    ...(input.verdict ? { verdict: input.verdict as "pass" | "revise" } : {}),
    ...(input.artifact !== undefined ? { artifact: packetWords(input.artifact, 1000) } : {}),
  };
}

export function next(project: Project, role: Role, events: Event[]): Turn {
  const [event] = events;
  if (events.length !== 1 || !event || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(event.subject))
    throw new Error("需要唯一的目标运行编号");
  const source = "goal-" + project.id;
  const publish = (type: string, round: number, body: unknown): Outbound => {
    const detail = JSON.stringify(body);
    if ([...detail].length > 4000) throw new Error("交接资料过长");
    return { id: event.subject + "-" + round + "-" + type, type, subject: event.subject, detail };
  };
  const base = { goal: project.goal, acceptance: project.acceptance, requiredText: project.requiredText ?? [] };
  const meetsChecks = (artifact: string) => base.requiredText.every((text) => artifact.includes(text));
  if (role === "plan") {
    if (event.source !== source + "-results" || !["run.manual", "goal.result"].includes(event.type))
      throw new Error("规划输入不属于此项目");
    const feedback = event.type === "goal.result" ? object(JSON.parse(event.detail), ["task", "result"]) : null;
    const previous = feedback ? taskOf(feedback.task, project) : null;
    const result = feedback ? resultOf(feedback.result) : null;
    const round = (previous?.round ?? 0) + 1;
    // Exhaustion is a policy outcome, not a model decision or a retryable execution failure.
    const automatic =
      round > project.maxRounds && result?.verdict !== "pass"
        ? { summary: "已达到项目轮数上限，待人工检查" }
        : undefined;
    return {
      input: JSON.stringify({ ...base, round, maxRounds: project.maxRounds, previous, result }),
      automatic,
      accept(value: unknown): Reply {
        if (automatic) return automatic;
        const plan = object(value, ["decision", "reason", "capability", "task", "acceptance"]);
        if (plan.decision === "complete" || plan.decision === "stop") {
          // A round ending successfully is not acceptance. Only the review of this artifact may close the goal.
          if (
            plan.decision === "complete" &&
            (previous?.capability !== "review" ||
              result?.status !== "done" ||
              result.verdict !== "pass" ||
              !result.artifact ||
              !result.artifact.includes(result.evidence) ||
              !meetsChecks(result.artifact))
          )
            throw new Error("结项需要实际草稿的审查和验收通过");
          const terminal = object(value, ["decision", "reason"]);
          return {
            summary:
              (terminal.decision === "complete" ? "验收通过，已结项：" : "规划停止：") +
              words(terminal.reason, 350).replace(/\s+/g, " "),
          };
        }
        if (plan.decision !== "task" || Object.hasOwn(plan, "reason")) throw new Error("规划决定无效");
        if (result?.status === "blocked") throw new Error("阻塞后只能停止，不能继续派发");
        const expected = previous?.capability === "draft" ? "review" : "draft";
        if (plan.capability !== expected) throw new Error("必须起草后审查，未通过后修正再审查");
        if (result?.verdict === "pass") throw new Error("验收通过后应结项或停止");
        const task = taskOf(
          { round, capability: plan.capability, task: plan.task, acceptance: plan.acceptance },
          project,
        );
        return {
          summary: "已安排第 " + round + " 轮",
          events: [publish("goal." + task.capability, round, { task, previousResult: result })],
        };
      },
    };
  }
  if (event.source !== source + "-tasks" || event.type !== "goal." + role)
    throw new Error("执行输入不属于此项目或能力不匹配");
  const packet = object(JSON.parse(event.detail), ["task", "previousResult"]);
  const task = taskOf(packet.task, project);
  const previousResult = packet.previousResult === null ? null : resultOf(packet.previousResult);
  if (task.capability !== role) throw new Error("执行能力不匹配");
  return {
    input: JSON.stringify({ ...base, task, previousResult }),
    accept(value: unknown): Reply {
      object(value, role === "review" ? ["status", "output", "evidence", "verdict"] : ["status", "output", "evidence"]);
      const result = resultOf(value);
      if (role === "review") {
        if (!previousResult || previousResult.status !== "done" || previousResult.verdict || previousResult.artifact)
          throw new Error("审查需要已完成的起草结果");
        if (!result.verdict || !previousResult.output.includes(result.evidence))
          throw new Error("审查必须给出结论并引用草稿原文");
        if (result.verdict === "pass" && (result.status !== "done" || !meetsChecks(previousResult.output)))
          throw new Error("草稿未通过程序验收，不能声明通过");
        // Bind the review to the exact draft supplied by the hub, never an artifact supplied by the reviewer.
        result.artifact = previousResult.output;
      }
      return {
        summary: result.status === "done" ? "已返回执行结果" : "已返回阻塞原因",
        events: [publish("goal.result", task.round, { task, result })],
      };
    },
  };
}

export function rulesFor(project: Project, worker: string, file: string) {
  const group = "goal-" + project.id;
  const tasks = group + "-tasks";
  const results = group + "-results";
  const roles = ["plan", "draft", "review"] as const;
  return {
    sources: { [tasks]: { name: project.id + " 目标任务" }, [results]: { name: project.id + " 目标回执" } },
    agents: Object.fromEntries(
      roles.map((role) => [
        group + "-" + role,
        {
          name: project.id + " " + role,
          worker,
          use: "command",
          access: "read",
          command: [process.execPath, fileURLToPath(new URL("./run.ts", import.meta.url)), role, file],
          timeout: 3,
        },
      ]),
    ),
    rules: roles.map((role) => ({
      name: project.id + " " + { plan: "目标规划", draft: "起草", review: "审查" }[role],
      when: { source: role === "plan" ? results : tasks, types: [role === "plan" ? "goal.result" : "goal." + role] },
      to: group + "-" + role,
      cwd: dirname(file),
      group,
      parallel: 1,
      emits: {
        source: role === "plan" ? tasks : results,
        types: role === "plan" ? ["goal.draft", "goal.review"] : ["goal.result"],
      },
    })),
  };
}
