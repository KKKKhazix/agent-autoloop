// Project policy for the goal loop. The hub routes and journals the validated events through its regular receipt protocol.
import { dirname, isAbsolute, normalize } from "node:path";
import { fileURLToPath } from "node:url";

export type CodeSpec = { repository: string; files: string[]; check: string[]; checkFiles: string[] };
export type CodeProof = { revision: string; passed: boolean; exitCode: number };
export type Project = {
  id: string;
  goal: string;
  acceptance: string;
  maxRounds: number;
  requiredText?: string[];
  code?: CodeSpec;
};
export type Role = "plan" | "draft" | "review";
type Event = { type: string; source: string; subject: string; detail: string };
type Outbound = Omit<Event, "source"> & { id: string };
type Reply = { summary: string; events?: Outbound[] };
type Turn = { input: string; automatic?: Reply; accept(value: unknown, proof?: CodeProof): Reply };
type Task = { round: number; capability: "draft" | "review"; task: string; acceptance: string };
type WorkResult = {
  status: "done" | "blocked";
  output: string;
  evidence: string;
  verdict?: "pass" | "revise";
  artifact?: string;
  code?: CodeProof;
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
  const input = object(value, ["id", "goal", "acceptance", "maxRounds", "requiredText", "code"]);
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
  let code: CodeSpec | undefined;
  if (input.code !== undefined) {
    const spec = object(input.code, ["repository", "files", "check", "checkFiles"]);
    if (
      typeof spec.repository !== "string" ||
      !spec.repository ||
      spec.repository.length > 1000 ||
      !spec.repository.isWellFormed()
    )
      throw new Error("代码仓库路径无效");
    const repository = spec.repository;
    if (!isAbsolute(repository) || repository.includes("\0")) throw new Error("代码仓库须为本地绝对路径");
    if (
      !Array.isArray(spec.files) ||
      !spec.files.length ||
      spec.files.length > 12 ||
      !Array.isArray(spec.check) ||
      !spec.check.length ||
      spec.check.length > 16
    )
      throw new Error("需要文件白名单和固定验收命令");
    const check = spec.check.map((part, index) => {
      if (typeof part !== "string" || part.length > 1000 || !part.isWellFormed() || (index === 0 && !part.trim()))
        throw new Error("验收命令参数无效");
      return part;
    });
    if (check.some((part) => part.includes("\0"))) throw new Error("验收命令包含无效字符");
    const files = spec.files.map((value) => {
      const path = words(value, 200);
      if (path !== value) throw new Error("文件路径不能包含首尾空格");
      if (
        !/^[A-Za-z0-9_-][A-Za-z0-9_./-]*$/.test(path) ||
        path.split("/").some((part) => !part || part === "." || part === "..") ||
        /(^|\/)(package(?:-lock)?\.json|tests?|__tests__)(\/|$)/.test(path) ||
        /\.(test|spec)\./.test(path) ||
        /(^|\/)(tsconfig(?:\.[\w-]+)?\.json|jsconfig(?:\.[\w-]+)?\.json|[^/]+\.config\.[^/]+)$/.test(path) ||
        check.some((arg) => normalize(arg) === normalize(path))
      )
        throw new Error("文件越界或属于验收入口");
      return path;
    });
    if (new Set(files).size !== files.length) throw new Error("文件白名单重复");
    if (!Array.isArray(spec.checkFiles) || !spec.checkFiles.length || spec.checkFiles.length > 24)
      throw new Error("须显式列出固定验收文件");
    const checkFiles = spec.checkFiles.map((value) => {
      const path = words(value, 200);
      if (path !== value) throw new Error("文件路径不能包含首尾空格");
      if (
        !/^[A-Za-z0-9_-][A-Za-z0-9_./-]*$/.test(path) ||
        path.split("/").some((part) => !part || part === "." || part === "..") ||
        files.includes(path)
      )
        throw new Error("验收文件越界或与可改文件重叠");
      return path;
    });
    code = { repository, files, check, checkFiles };
  }
  return {
    ...(code ? { code } : {}),
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

export function codeProof(value: unknown): CodeProof {
  const proof = object(value, ["revision", "passed", "exitCode"]);
  if (
    typeof proof.revision !== "string" ||
    !/^[a-f0-9]{64}$/.test(proof.revision) ||
    typeof proof.passed !== "boolean" ||
    !Number.isInteger(proof.exitCode) ||
    (proof.exitCode as number) < 0 ||
    (proof.exitCode as number) > 255 ||
    (proof.passed && proof.exitCode !== 0)
  )
    throw new Error("代码验收证据无效");
  return proof as CodeProof;
}

function resultOf(value: unknown): WorkResult {
  const input = object(value, ["status", "output", "evidence", "verdict", "artifact", "code"]);
  if (input.verdict !== undefined && input.verdict !== "pass" && input.verdict !== "revise")
    throw new Error("审查结论无效");
  if (input.status !== "done" && input.status !== "blocked") throw new Error("回执状态无效");
  return {
    status: input.status,
    output: packetWords(input.output, 1000),
    evidence: packetWords(input.evidence, 350),
    ...(input.code ? { code: codeProof(input.code) } : {}),
    ...(input.verdict ? { verdict: input.verdict as "pass" | "revise" } : {}),
    ...(input.artifact !== undefined ? { artifact: packetWords(input.artifact, 1000) } : {}),
  };
}

// Model-owned fields are validated before the executor performs any local writes or starts acceptance commands.
export function modelReply(value: unknown, role: "draft" | "review") {
  object(value, role === "review" ? ["status", "output", "evidence", "verdict"] : ["status", "output", "evidence"]);
  return resultOf(value);
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
      accept(value: unknown, proof?: CodeProof): Reply {
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
              !(project.code ? result.code?.passed : meetsChecks(result.artifact)))
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
        // A review must check the draft's own criteria. Repairs may define a new task, always under the fixed project policy.
        if (task.capability === "review") task.acceptance = previous!.acceptance;
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
    accept(value: unknown, proof?: CodeProof): Reply {
      const result = modelReply(value, role);
      if (project.code && (result.status === "done" || proof !== undefined)) {
        result.code = codeProof(proof);
        if (role === "review" && previousResult?.code?.revision !== result.code.revision)
          throw new Error("审查代码与起草快照不一致");
      }
      if (role === "review") {
        if (!previousResult || previousResult.status !== "done" || previousResult.verdict || previousResult.artifact)
          throw new Error("审查需要已完成的起草结果");
        if (!result.verdict || !previousResult.output.includes(result.evidence))
          throw new Error("审查必须给出结论并引用草稿原文");
        if (
          result.verdict === "pass" &&
          (result.status !== "done" || !(project.code ? result.code?.passed : meetsChecks(previousResult.output)))
        )
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
