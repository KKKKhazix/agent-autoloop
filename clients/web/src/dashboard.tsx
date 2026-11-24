import { useState } from "react";
import { Box, Empty, Runs, stamp, Tag } from "./common";
import { Icon } from "./icons";
import type { Page, State, Run, Settings } from "./types";

export function Dashboard({
  state,
  local,
  online,
  go,
  open,
}: {
  state: State | null;
  local: Settings | null;
  online: boolean;
  go: (p: Page) => void;
  open: (r: Run) => void;
}) {
  const [week, setWeek] = useState(false),
    spending = state?.spending[week ? "week" : "today"];
  const workers = Array.from(new Map(state?.agents.map((a) => [a.worker, a]) ?? []).values());
  const attention = state?.cards.filter((c) => c.kind === "ask").length;
  const stats = [
    { label: "正在运行", value: state?.totals.running, icon: "pulse", tone: "mint", foot: "已由 Worker 领取" },
    {
      label: "排队轮次",
      value: state?.totals.queued,
      icon: "clock",
      tone: "sky",
      foot: state ? "其中 " + state.totals.retrying + " 轮等待重派" : "等待 Hub 数据",
    },
    {
      label: "今日完成",
      value: state?.totals.doneToday,
      icon: "check",
      tone: "lilac",
      foot: state?.timezone ?? "Hub 所在时区",
    },
    { label: "待审批", value: attention, icon: "cards", tone: "sand", foot: "等待本人回答的卡片" },
  ];
  return (
    <>
      <div className="hubbar">
        <span className="hubicon">
          <Icon name="hub" />
        </span>
        <div>
          <strong>Hub {online ? "已连接" : state ? "连接中断" : "等待连接"}</strong>
          <small>{local?.url ?? "请在系统设置中检查本机配置"}</small>
        </div>
        <div className="hubdetail">
          <span className={"light " + (online ? "on" : "")}></span>
          {state ? "快照 #" + state.seq : "暂无快照"}
        </div>
      </div>
      <div className="metrics">
        {stats.map((s) => (
          <div className="metric" key={s.label}>
            <div className="metrichead">
              {s.label}
              <span className={"metricicon " + s.tone}>
                <Icon name={s.icon} />
              </span>
            </div>
            <b>{s.value ?? "—"}</b>
            <small>{s.foot}</small>
          </div>
        ))}
      </div>
      <div className="columns">
        <Box
          title="运行节点"
          action={
            <button className="link" onClick={() => go("agents")}>
              查看 Agent
            </button>
          }
        >
          {workers.length ? (
            workers.map((w) => (
              <div className="listitem" key={w.worker}>
                <div>
                  <strong>{w.worker}</strong>
                  <small>
                    {state?.agents
                      .filter((a) => a.worker === w.worker)
                      .map((a) => a.name)
                      .join("、")}
                  </small>
                </div>
                <Tag tone={w.online ? "green" : ""}>{w.online ? "在线" : "离线"}</Tag>
              </div>
            ))
          ) : (
            <Empty>{state ? "暂无已登记的 Worker" : "等待读取 Worker 心跳"}</Empty>
          )}
        </Box>
        <Box
          title="原生用量"
          action={
            <div className="seg">
              <button aria-pressed={!week} onClick={() => setWeek(false)}>
                今天
              </button>
              <button aria-pressed={week} onClick={() => setWeek(true)}>
                近 7 天
              </button>
            </div>
          }
        >
          <div className="spend">
            <div>
              <span>Token</span>
              <strong>
                {spending?.rounds && spending.missingTokens < spending.rounds ? spending.tokens.toLocaleString() : "—"}
              </strong>
            </div>
            <div>
              <span>费用（USD）</span>
              <strong>
                {spending?.rounds && spending.missingCost < spending.rounds
                  ? "$" + spending.cost.toLocaleString("en-US", { maximumFractionDigits: 6 })
                  : "—"}
              </strong>
            </div>
          </div>
          <small>
            {spending
              ? spending.rounds +
                " 轮 · Token 未上报 " +
                spending.missingTokens +
                " 轮 · 费用未上报 " +
                spending.missingCost +
                " 轮"
              : "等待用量报告"}
          </small>
        </Box>
      </div>
      <Box
        title="最近执行"
        action={
          <button className="link" onClick={() => go("tasks")}>
            全部任务
          </button>
        }
      >
        {state ? <Runs runs={state.runs.slice(0, 5)} open={open} /> : <Empty>连接 Hub 后显示执行记录</Empty>}
      </Box>
      <Box
        title="待处理与异常"
        action={
          <button className="link" onClick={() => go("cards")}>
            查看审批
          </button>
        }
      >
        {state ? (
          <>
            {state.cards.map((c) => (
              <p key={c.id}>
                <Tag tone="amber">#{c.id}</Tag>　{c.title}
              </p>
            ))}
            {state.channels
              .filter((c) => c.lastFailure)
              .map((c) => (
                <p key={c.id}>
                  {c.name} · {c.lastFailure?.error}
                </p>
              ))}
            {state.runs
              .filter((r) => r.state === "unknown" || (r.state === "queued" && r.error))
              .slice(0, 5)
              .map((r) => (
                <p key={r.id}>
                  <button className="link" onClick={() => open(r)}>
                    第 {r.id} 轮
                  </button>
                  　{r.error || "执行结果不确定"}
                </p>
              ))}
            {!state.cards.length &&
              !state.totals.unknown &&
              !state.totals.retrying &&
              !state.channels.some((c) => c.lastFailure) && <Empty>暂无待处理事项</Empty>}
          </>
        ) : (
          <Empty>等待 Hub 快照</Empty>
        )}
      </Box>
    </>
  );
}

export function Waiting({ state }: { state: State }) {
  return state.timers.length ? (
    <Box title="等待复查">
      {state.timers.map((t, i) => (
        <p key={i}>
          {t.rule}　{t.lane}　{stamp(t.at)}　{t.about}
        </p>
      ))}
    </Box>
  ) : null;
}
