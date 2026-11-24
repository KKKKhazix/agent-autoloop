import { useState } from "react";
import { api, Box, Empty, ErrorBox, Field, Modal, pretty, Tag, useAction, stamp } from "./common";
import type { Agent, Rule, Rules, RuleFile, Settings, State } from "./types";
import type { RuleOp } from "./operations";

export function parsed(file: RuleFile | null): Rules | null {
  if (!file || file.problem) return null;
  try {
    const v = JSON.parse(file.text);
    return v && Array.isArray(v.rules) && v.agents && v.sources ? v : null;
  } catch {
    return null;
  }
}
type BaseProps = { file: RuleFile; settings: Settings; saved: (file: RuleFile) => void; close: () => void };
type Edit = { kind: "json" } | { kind: "agent"; id?: string } | { kind: "rule"; index?: number };
function Save({ busy, error }: { busy: boolean; error: string }) {
  return (
    <>
      <ErrorBox text={error} />
      <div className="actions">
        <button className="primary" disabled={busy}>
          {busy ? "正在保存…" : "校验并保存"}
        </button>
      </div>
    </>
  );
}
export function Draft({ edit, ...props }: BaseProps & { edit: Edit }) {
  const [original] = useState(props.file);
  const frozen = { ...props, file: original };
  return edit.kind === "json" ? (
    <Raw {...frozen} />
  ) : edit.kind === "agent" ? (
    <AgentForm {...frozen} id={edit.id} />
  ) : (
    <RuleForm {...frozen} index={edit.index} />
  );
}
function Raw({ file, close, saved }: BaseProps) {
  const [text, setText] = useState(file.text),
    [result, setResult] = useState(""),
    { act, busy, error } = useAction();
  return (
    <Modal title="编辑原生 rules.json" close={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void act(async () => saved(await api<RuleFile>("/rules", { text, revision: file.revision })));
        }}
      >
        <Field title="完整规则文件">
          <textarea
            className="codearea"
            spellCheck={false}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setResult("");
            }}
          />
        </Field>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              await api("/rules/check", { text });
              setResult("原生校验通过");
            })
          }
        >
          仅校验
        </button>
        　{result}
        <Save busy={busy} error={error} />
      </form>
    </Modal>
  );
}
function RuleForm({ index, file, close, saved }: BaseProps & { index?: number }) {
  const rules = parsed(file)!;
  const [r, setR] = useState<Rule>(() =>
    index === undefined
      ? {
          name: "",
          to: Object.keys(rules.agents)[0] ?? "",
          cwd: "",
          when: { source: Object.keys(rules.sources)[0] ?? "", types: ["*"] },
        }
      : rules.rules[index],
  );
  const { act, busy, error } = useAction();
  const put = <K extends keyof Rule>(key: K, value: Rule[K]) => setR({ ...r, [key]: value });
  return (
    <Modal title={index === undefined ? "新建工作流" : "编辑工作流"} close={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void act(async () => {
            const doc = parsed(file)!;
            if (index === undefined) doc.rules.push(r);
            else doc.rules[index] = r;
            saved(await api("/rules", { revision: file.revision, text: pretty(doc) + "\n" }));
          });
        }}
      >
        <div className="formgrid">
          <Field title="规则名称">
            <input required value={r.name} onChange={(e) => put("name", e.target.value)} />
          </Field>
          <Field title="执行 Agent">
            <select required value={r.to} onChange={(e) => put("to", e.target.value)}>
              {Object.entries(rules.agents).map(([id, a]) => (
                <option value={id} key={id}>
                  {a.name} · {id}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field title="工作目录">
          <input required value={r.cwd} placeholder="绝对路径" onChange={(e) => put("cwd", e.target.value)} />
        </Field>
        <Field title="触发方式">
          <select
            value={"cron" in r.when ? "cron" : "event"}
            onChange={(e) =>
              put(
                "when",
                e.target.value === "cron"
                  ? { cron: "" }
                  : { source: Object.keys(rules.sources)[0] ?? "", types: ["*"] },
              )
            }
          >
            <option value="event">来源事件</option>
            <option value="cron">定时触发</option>
          </select>
        </Field>
        {"cron" in r.when ? (
          <Field title="Cron 表达式">
            <input required value={r.when.cron} onChange={(e) => put("when", { cron: e.target.value })} />
          </Field>
        ) : (
          <div className="formgrid">
            <Field title="事件来源">
              <select
                required
                value={r.when.source}
                onChange={(e) => put("when", { ...r.when, source: e.target.value })}
              >
                {Object.keys(rules.sources).map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </Field>
            <Field title="事件类型（逗号分隔）">
              <input
                required
                value={r.when.types?.join(",")}
                onChange={(e) => put("when", { ...r.when, types: e.target.value.split(",").map((s) => s.trim()) })}
              />
            </Field>
          </div>
        )}
        <Field title="执行提示词">
          <textarea value={r.prompt ?? ""} onChange={(e) => put("prompt", e.target.value || undefined)} />
        </Field>
        <details>
          <summary>高级执行参数</summary>
          <div className="formgrid">
            {(["skill", "group", "parallel", "maxActive"] as const).map((k, i) => (
              <Field key={k} title={["Skill", "并发分组", "组并发上限", "规则并发上限"][i]}>
                <input
                  type={i > 1 ? "number" : "text"}
                  min={1}
                  value={r[k] ?? ""}
                  onChange={(e) =>
                    setR({ ...r, [k]: e.target.value ? (i > 1 ? Number(e.target.value) : e.target.value) : undefined })
                  }
                />
              </Field>
            ))}
          </div>
          <label>
            <input type="checkbox" checked={r.resume ?? false} onChange={(e) => put("resume", e.target.checked)} />{" "}
            接续上一轮会话
          </label>
          <Field title="通知方式">
            <select value={r.tell ?? ""} onChange={(e) => put("tell", e.target.value || undefined)}>
              <option value="">原生默认</option>
              <option value="needed">按需</option>
              <option value="always">成功时通知</option>
              <option value="never">抑制回执通知</option>
            </select>
          </Field>
        </details>
        <Save error={error} busy={busy} />
      </form>
    </Modal>
  );
}
function AgentForm({ file, id, settings, saved, close }: BaseProps & { id?: string }) {
  const doc = parsed(file)!;
  const [key, setKey] = useState(id ?? ""),
    [a, setA] = useState<Agent>(() =>
      id ? doc.agents[id] : { use: "codex", name: "", worker: settings.worker?.name ?? "" },
    );
  const { act, busy, error } = useAction();
  const builtin = settings.plugins.some((p) => p.name === a.use && p.builtin);
  const native = (...ids: string[]) => builtin && ids.includes(a.use);
  const fields: (keyof Agent)[] = ["name", "worker"];
  const hasPlaceholder = (name: string) => a.command?.some((part) => part.includes("{" + name + "}"));
  if (native("codex", "claude") || (native("command") && hasPlaceholder("model"))) fields.push("model");
  if (native("codex", "claude") || (native("command") && hasPlaceholder("effort"))) fields.push("effort");
  if (native("codex")) fields.push("tier");
  if (native("codex", "claude", "zcode", "dsh")) fields.push("program");
  fields.push("timeout", "maxActive");
  const names: Partial<Record<keyof Agent, string>> = {
    name: "显示名称",
    worker: "Worker 编号",
    model: "模型",
    effort: "推理强度",
    tier: "服务档位",
    program: "可执行程序路径",
    timeout: "超时（分钟）",
    maxActive: "Agent 并发上限",
  };
  return (
    <Modal title={id ? "配置 Agent" : "注册 Agent"} close={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void act(async () => {
            if (!id && Object.hasOwn(doc.agents, key)) throw new Error("此 Agent 编号已存在");
            const updated = { ...doc, agents: { ...doc.agents, [key]: a } };
            saved(await api("/rules", { revision: file.revision, text: pretty(updated) + "\n" }));
          });
        }}
      >
        <div className="formgrid">
          <Field title="Agent 编号">
            <input
              required
              pattern="[a-z][a-z0-9\-]*"
              disabled={!!id}
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          </Field>
          <Field title="执行插件">
            <select
              value={a.use}
              onChange={(e) =>
                setA({
                  name: a.name,
                  worker: a.worker,
                  use: e.target.value,
                  timeout: a.timeout,
                  maxActive: a.maxActive,
                })
              }
            >
              {[...new Set([...settings.plugins.map((p) => p.name), a.use])].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </Field>
        </div>
        <div className="formgrid">
          {fields.map((k) => (
            <Field key={k} title={names[k]!}>
              <input
                required={k === "name" || k === "worker"}
                type={k === "timeout" || k === "maxActive" ? "number" : "text"}
                min={1}
                value={String(a[k] ?? "")}
                onChange={(e) =>
                  setA({
                    ...a,
                    [k]: e.target.value
                      ? k === "timeout" || k === "maxActive"
                        ? Number(e.target.value)
                        : e.target.value
                      : undefined,
                  })
                }
              />
            </Field>
          ))}
        </div>
        {native("codex", "claude", "acp", "zcode", "dsh") && (
          <Field title="访问权限">
            <select value={a.access ?? ""} onChange={(e) => setA({ ...a, access: e.target.value || undefined })}>
              <option value="">默认（编辑）</option>
              <option value="read">只读</option>
              <option value="edit">编辑</option>
              <option value="full">完整访问</option>
            </select>
          </Field>
        )}
        {native("command", "delivery", "acp") && (
          <Field
            title={native("delivery") ? "交付参数（每行一个，首行为 owner/repo）" : "启动命令及参数（每行一个参数）"}
          >
            <textarea
              value={a.command?.join("\n") ?? ""}
              required
              onChange={(e) => setA({ ...a, command: e.target.value.split("\n") })}
            />
          </Field>
        )}
        {!builtin && <p className="hint">此插件的专有参数可在完整规则文件中编辑。</p>}
        <Save error={error} busy={busy} />
      </form>
    </Modal>
  );
}
export function ConfigPage({
  agents,
  state,
  file,
  settings,
  edit,
  op,
}: {
  agents: boolean;
  state: State | null;
  file: RuleFile | null;
  settings: Settings | null;
  edit: (e: Edit) => void;
  op: (o: RuleOp) => void;
}) {
  const doc = parsed(file);
  const tools = (
    <div className="row">
      <button disabled={!file} onClick={() => edit({ kind: "json" })}>
        完整 JSON
      </button>
      <button className="primary" disabled={!doc} onClick={() => edit({ kind: agents ? "agent" : "rule" })}>
        {agents ? "注册 Agent" : "新建规则"}
      </button>
    </div>
  );
  if (agents) {
    const ids = Array.from(new Set([...Object.keys(doc?.agents ?? {}), ...(state?.agents.map((a) => a.id) ?? [])]));
    return (
      <Box title="已登记的 Agent" action={tools}>
        {ids.length ? (
          ids.map((id) => {
            const live = state?.agents.find((a) => a.id === id);
            const a = doc?.agents[id] ?? live!;
            return (
              <article key={id} className="listitem">
                <div>
                  <div className="row">
                    <h3>{a.name}</h3>
                    <Tag tone={live?.online ? "green" : ""}>{live ? (live.online ? "在线" : "离线") : "状态未知"}</Tag>
                  </div>
                  <p>
                    {id} · {a.use} · Worker {a.worker}
                  </p>
                  {a.model && (
                    <small>
                      模型 {a.model}　{a.effort}
                    </small>
                  )}
                  {live?.limited && (
                    <p className="warn">
                      {live.limited.reason} · {stamp(live.limited.until)} 恢复
                    </p>
                  )}
                </div>
                <button disabled={!doc?.agents[id]} onClick={() => edit({ kind: "agent", id })}>
                  配置
                </button>
              </article>
            );
          })
        ) : (
          <Empty>暂无 Agent 配置</Empty>
        )}
      </Box>
    );
  }
  const rules = doc?.rules ?? [];
  const names = Array.from(new Set([...rules.map((r) => r.name), ...(state?.lines.map((l) => l.name) ?? [])]));
  return (
    <>
      <Box title="工作流规则" action={tools}>
        {names.length ? (
          names.map((name) => {
            const index = rules.findIndex((r) => r.name === name),
              r = rules[index],
              line = state?.lines.find((l) => l.name === name);
            return (
              <article key={name} className="ruleitem">
                <div className="row">
                  <h3>{name}</h3>
                  <Tag tone={line?.paused ? "amber" : line ? "green" : ""}>
                    {line?.paused ? "已暂停" : line ? "生效中" : "待 Hub 确认"}
                  </Tag>
                </div>
                <p>
                  {line?.every ||
                    r?.when.cron ||
                    [line?.source ?? r?.when.source, (line?.types ?? r?.when.types)?.join(", ")]
                      .filter(Boolean)
                      .join(" / ")}
                  　·　{r?.to ?? line?.agent}
                </p>
                {r?.cwd && <small className="mono">{r.cwd}</small>}
                {line?.paused && (
                  <p>
                    暂停于 {stamp(line.paused.since)}　{line.paused.reason}　跳过 {line.paused.skipped?.count ?? 0} 条
                  </p>
                )}
                <div className="row">
                  <button disabled={index < 0} onClick={() => edit({ kind: "rule", index })}>
                    编辑
                  </button>
                  {line && (
                    <>
                      <button disabled={!!line.paused} onClick={() => op({ kind: "run", rule: name })}>
                        立即运行
                      </button>
                      <button onClick={() => op({ kind: line.paused ? "resume" : "pause", rule: name })}>
                        {line.paused ? "恢复" : "暂停"}
                      </button>
                      {!line.every && !line.paused && (
                        <button onClick={() => op({ kind: "replay", rule: name })}>补跑</button>
                      )}
                    </>
                  )}
                </div>
              </article>
            );
          })
        ) : (
          <Empty>{settings?.hub ? "暂无工作流规则" : "规则编辑需要 Hub 主机的 rules.json"}</Empty>
        )}
      </Box>
      {!!state?.elsewhere.length && (
        <Box title="外部定时任务">
          {state.elsewhere.map((e) => (
            <p key={e.name}>
              {e.name} · {e.where} · {e.every} · 下次 {stamp(e.next)}
            </p>
          ))}
        </Box>
      )}
    </>
  );
}
export type { Edit };
