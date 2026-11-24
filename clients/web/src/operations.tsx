import { useEffect, useState } from "react";
import {
  api,
  Box,
  Empty,
  ErrorBox,
  Field,
  LinkOut,
  Modal,
  msg,
  pretty,
  Runs,
  stamp,
  status,
  Tag,
  useAction,
} from "./common";
import type { Card, Fact, Line, Run, State } from "./types";

export type RuleOp = { kind: "run" | "pause" | "resume" | "replay"; rule?: string; subject?: string; since?: string };
const verbs = { run: "运行规则", pause: "暂停规则", resume: "恢复规则", replay: "补跑事件" };

export function RuleAction({
  op,
  lines,
  close,
  done,
}: {
  op: RuleOp;
  lines: Line[];
  close: () => void;
  done: (message: string) => void;
}) {
  const valid = lines.filter((l) => (op.kind === "resume" ? l.paused : op.kind === "pause" ? true : !l.paused));
  const [name, setName] = useState(op.rule ?? valid[0]?.name ?? ""),
    [reason, setReason] = useState(""),
    [subject, setSubject] = useState(op.subject ?? ""),
    [time, setTime] = useState("");
  const [since, setSince] = useState(op.since ?? ""),
    [receipt, setReceipt] = useState("");
  const { act, busy, error } = useAction();
  const path = "/rules/" + encodeURIComponent(name) + "/";
  return (
    <Modal title={op.kind === "run" && !op.rule ? "发布任务" : verbs[op.kind]} close={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void act(async () => {
            const data = await api<{
              run?: number;
              events?: number[];
              paused?: { since: string; skipped?: { count: number } };
            }>(
              path + op.kind,
              op.kind === "run"
                ? { subject, reason }
                : op.kind === "pause"
                  ? { reason, ...(time && { until: new Date(time).toISOString() }) }
                  : op.kind === "replay"
                    ? { since: new Date(since).toISOString() }
                    : {},
            );
            if (op.kind === "resume" && data.paused?.skipped?.count) {
              setSince(data.paused.since);
              setReceipt("已恢复，有 " + data.paused.skipped.count + " 条跳过的事件可补跑。");
              return;
            }
            done(
              data.run
                ? "已提交至第 " + data.run + " 轮"
                : data.events
                  ? "已补跑 " + data.events.length + " 条事件"
                  : verbs[op.kind] + "成功",
            );
          });
        }}
      >
        <Field title="执行规则">
          <select value={name} onChange={(e) => setName(e.target.value)} disabled={!!op.rule || !!receipt} required>
            {valid.map((l) => (
              <option key={l.name}>{l.name}</option>
            ))}
          </select>
        </Field>
        {op.kind === "run" && (
          <>
            <Field title="本轮任务说明">
              <textarea
                autoFocus
                placeholder="用自然语言描述这轮要处理的事"
                maxLength={500}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
            <p className="hint">说明随事件资料交给 Agent，执行方式由所选规则决定。</p>
            <Field title="事项标识（可选）">
              <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="例如 owner/repo#42" />
            </Field>
          </>
        )}
        {op.kind === "pause" && (
          <>
            <Field title="暂停原因">
              <input maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
            <Field title="自动恢复时间（可选，本机时间）">
              <input type="datetime-local" value={time} onChange={(e) => setTime(e.target.value)} />
            </Field>
          </>
        )}
        {op.kind === "replay" && (
          <Field title="补跑起始时间（含时区的 ISO 时间）">
            <input
              required
              placeholder="2026-11-24T09:00:00+08:00"
              value={since}
              onChange={(e) => setSince(e.target.value)}
            />
          </Field>
        )}
        {op.kind === "resume" && <p>{receipt || "恢复后新事件将照常派发。暂停期间跳过的事件可另行补跑。"}</p>}
        <ErrorBox text={error} />
        <div className="actions">
          <button type="button" onClick={close}>
            {receipt ? "关闭" : "取消"}
          </button>
          {receipt ? (
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const r = await api<{ events: number[] }>(path + "replay", { since });
                  done("已补跑 " + r.events.length + " 条事件");
                })
              }
            >
              补跑跳过的事件
            </button>
          ) : (
            <button className="primary" disabled={busy || !name}>
              {busy ? "正在提交…" : verbs[op.kind]}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}

export function RunDetail({
  run,
  close,
  refresh,
  runAgain,
}: {
  run: Run;
  close: () => void;
  refresh: () => void;
  runAgain?: () => void;
}) {
  const [data, setData] = useState<{ timeline: string; facts: Fact[] } | null>(null),
    [issue, setIssue] = useState("");
  const { busy, error, act } = useAction();
  useEffect(() => {
    let keep = true;
    api<{ timeline: string; facts: Fact[] }>("/runs/" + run.id + "/why")
      .then((d) => keep && setData(d))
      .catch((e) => keep && setIssue(msg(e)));
    return () => {
      keep = false;
    };
  }, [run.id, run.state, run.attempts, run.stopping]);
  return (
    <Modal title={"第 " + run.id + " 轮 · " + run.rule} close={close}>
      <div className="row">
        <Tag tone={status(run)[1]}>{status(run)[0]}</Tag>
        <span>{run.agent}</span>
        <LinkOut href={run.link}>打开 Agent 会话</LinkOut>
      </div>
      <p>{run.summary || run.error}</p>
      {run.session && <p className="hint">会话编号　{run.session}</p>}
      {run.events.map((e, i) => (
        <p key={i}>
          {e.subject} {e.summary} <LinkOut href={e.link}>事件来源</LinkOut>
        </p>
      ))}
      <h3>执行时间线</h3>
      <ErrorBox text={issue || error} />
      {data ? (
        <>
          <pre>{data.timeline}</pre>
          <details>
            <summary>原始事实与用量</summary>
            <pre>{pretty({ usage: run.usage, facts: data.facts })}</pre>
          </details>
        </>
      ) : (
        !issue && <p>正在读取…</p>
      )}
      {runAgain && run.state === "queued" && run.attempts > 0 && (
        <div>
          <p className="hint">
            下次重派 {stamp(run.notBefore)} · 已尝试 {run.attempts} 次
          </p>
          <button onClick={runAgain}>按规则立即运行</button>
        </div>
      )}
      {["queued", "claimed", "unknown"].includes(run.state) && !run.stopping && (
        <button
          className="danger"
          disabled={busy}
          onClick={() => {
            if (confirm("停止第 " + run.id + " 轮？"))
              void act(async () => {
                await api("/runs/" + run.id + "/cancel", {});
                refresh();
              });
          }}
        >
          停止本轮
        </button>
      )}
    </Modal>
  );
}

export function History({ state, open, onlyRule }: { state: State | null; open: (r: Run) => void; onlyRule?: string }) {
  const [rule, setRule] = useState(onlyRule ?? ""),
    [page, setPage] = useState<{ runs: Run[]; nextBefore: number | null } | null>(null),
    [cursors, setCursors] = useState<number[]>([]),
    [err, setErr] = useState("");
  const before = cursors.at(-1);
  useEffect(() => {
    let keep = true;
    setPage(null);
    setErr("");
    const q = new URLSearchParams();
    if (rule) q.set("rule", rule);
    if (before) q.set("before", String(before));
    api<{ runs: Run[]; nextBefore: number | null }>("/history?" + q)
      .then((d) => keep && setPage(d))
      .catch((e) => keep && setErr(msg(e)));
    return () => {
      keep = false;
    };
  }, [rule, before, state?.totals.doneToday, state?.runs.find((r) => !["queued", "claimed"].includes(r.state))?.id]);
  return (
    <Box
      title="历史执行记录"
      action={
        !onlyRule && (
          <select
            aria-label="筛选历史规则"
            value={rule}
            onChange={(e) => {
              setRule(e.target.value);
              setCursors([]);
            }}
          >
            <option value="">全部规则</option>
            {state?.lines.map((l) => (
              <option key={l.name}>{l.name}</option>
            ))}
          </select>
        )
      }
    >
      <ErrorBox text={err} />
      {page ? <Runs runs={page.runs} open={open} /> : !err && <Empty>正在读取历史记录…</Empty>}
      {(before || page?.nextBefore) && (
        <div className="actions">
          <button disabled={!before} onClick={() => setCursors((c) => c.slice(0, -1))}>
            上一页
          </button>
          <button disabled={!page?.nextBefore} onClick={() => setCursors((c) => [...c, page!.nextBefore!])}>
            下一页
          </button>
        </div>
      )}
    </Box>
  );
}

function Approval({ card, refresh }: { card: Card; refresh: () => void }) {
  const [words, setWords] = useState(""),
    { busy, error, act } = useAction();
  const send = (action: string, body: object) =>
    void act(async () => {
      await api("/cards/" + card.id + "/" + action, body);
      refresh();
    });
  return (
    <article className="carditem">
      <div className="row">
        <Tag tone={card.kind === "ask" ? "amber" : "blue"}>{card.kind === "ask" ? "人工审批" : "通知"}</Tag>
        <span className="meta">
          #{card.id} · {card.rule || "中台"}　{stamp(card.createdAt)}
        </span>
      </div>
      <h3>{card.title}</h3>
      <p className="preserve">{card.text}</p>
      {card.about && <p className="hint">{card.about}</p>}
      {card.state === "open" ? (
        <>
          <div className="row">
            {card.options.map((s, i) => (
              <button
                disabled={busy}
                key={i}
                onClick={() => send("answer", card.kind === "ask" ? { choice: i } : { text: words })}
              >
                {s}
                {card.recommend === i ? "（推荐）" : ""}
              </button>
            ))}
          </div>
          <Field title="回答或结案说明">
            <input value={words} onChange={(e) => setWords(e.target.value)} />
          </Field>
          <div className="row">
            {card.kind === "ask" && (
              <button disabled={busy || !words.trim()} onClick={() => send("answer", { text: words })}>
                提交文字回答
              </button>
            )}
            <button disabled={busy || !words.trim()} onClick={() => send("resolve", { reason: words })}>
              按说明结案
            </button>
          </div>
          <ErrorBox text={error} />
        </>
      ) : (
        <p className="hint">
          {({ decided: "已回答", closed: "已结案", done: "已处理" } as Record<string, string>)[card.state] ??
            card.state}
          　
          {[card.by, card.choice !== null ? card.options[card.choice] : "", card.answer, card.result]
            .filter(Boolean)
            .join(" · ")}
        </p>
      )}
    </article>
  );
}
export function Approvals({ state, refresh }: { state: State; refresh: () => void }) {
  return (
    <>
      <Box title="待处理卡片" action={<Tag>{state.cards.length}</Tag>}>
        {state.cards.length ? (
          state.cards.map((c) => <Approval key={c.id} card={c} refresh={refresh} />)
        ) : (
          <Empty>当前没有待处理卡片</Empty>
        )}
      </Box>
      <Box title="近期处理结果">
        {state.recentCards.length ? (
          state.recentCards.map((c) => <Approval key={c.id} card={c} refresh={refresh} />)
        ) : (
          <Empty>暂无已处理记录</Empty>
        )}
      </Box>
    </>
  );
}
export function Logs({
  facts,
  stream,
  state,
  open,
}: {
  facts: Fact[];
  stream: string;
  state: State | null;
  open: (r: Run) => void;
}) {
  return (
    <>
      <Box title="实时事件流" action={<Tag tone={stream === "已连接" ? "green" : "amber"}>{stream}</Tag>}>
        {facts.length ? (
          <div className="feed">
            {facts.map((f) => (
              <details key={f.seq}>
                <summary>
                  <code>#{f.seq}</code>　{f.type}　<span className="meta">{stamp(f.at)}</span>
                </summary>
                <pre>{pretty(f)}</pre>
              </details>
            ))}
          </div>
        ) : (
          <Empty>等待连接后产生的原生事件</Empty>
        )}
      </Box>
      <History state={state} open={open} />
    </>
  );
}
