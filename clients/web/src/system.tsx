import { useEffect, useState } from "react";
import { api, Box, Empty, ErrorBox, Field, LinkOut, pretty, Tag, useAction } from "./common";
import { parsed } from "./configuration";
import type { RuleFile, Settings, State, Run } from "./types";
import type { RuleOp } from "./operations";

export function System({ local, refresh, edit }: { local: Settings | null; refresh: () => void; edit: () => void }) {
  const [health, setHealth] = useState("检查中"),
    [proc, setProc] = useState({ owned: false, output: "" }),
    [out, setOut] = useState(""),
    [version, setVersion] = useState(0);
  const { act, error, busy } = useAction();
  useEffect(() => {
    let keep = true;
    const poll = () => {
      api<{ ok: boolean; commit: string }>("/health")
        .then((h) => keep && setHealth(h.ok ? "在线 · " + h.commit : "异常"))
        .catch((e) => keep && setHealth(e.message));
      api<typeof proc>("/process")
        .then((p) => keep && setProc(p))
        .catch((e) => keep && setHealth(e.message));
    };
    poll();
    const i = setInterval(poll, 5000);
    return () => {
      keep = false;
      clearInterval(i);
    };
  }, [version]);
  const run = (action: string) =>
    void act(async () => {
      setOut("");
      try {
        const v = await api<{ output: string }>("/cli/" + action, {});
        setOut(v.output);
      } finally {
        setVersion((v) => v + 1);
        refresh();
      }
    });
  return (
    <>
      <Box title="Hub 连接">
        <dl>
          <dt>Hub 地址</dt>
          <dd>{local?.url ?? "未配置"}</dd>
          <dt>健康检查</dt>
          <dd>{health}</dd>
          <dt>本人访问</dt>
          <dd>{local ? (local.owner ? "已配置" : "缺少本人密钥") : "—"}</dd>
          <dt>配置目录</dt>
          <dd>{local?.home ?? "—"}</dd>
          {local?.hub && (
            <>
              <dt>监听地址</dt>
              <dd>{local.hub.listen}</dd>
            </>
          )}
        </dl>
        {local && <Connection key={local.revision} local={local} />}
        {!local && (
          <p>
            首次使用请在仓库根目录执行 <code>node bin/agent-autoloop.ts init --no-service</code>，然后刷新。
          </p>
        )}
      </Box>
      <Box title="原生 CLI">
        <div className="row">
          <button disabled={busy} onClick={() => run("doctor")}>
            环境诊断
          </button>
          <button disabled={busy || proc.owned || !local} onClick={() => run("start")}>
            启动原生进程
          </button>
          <button disabled={busy || !proc.owned} onClick={() => confirm("停止本客户端启动的 up 进程？") && run("stop")}>
            停止原生进程
          </button>
          <button
            disabled={busy || !local}
            onClick={() => confirm("运行原生 update？它会更新当前引擎检出，并可能重启登录服务。") && run("update")}
          >
            更新引擎
          </button>
        </div>
        <p className="hint">由系统服务启动的进程请通过原服务管理。</p>
        <ErrorBox text={error} />
        {busy && <p>CLI 正在执行…</p>}
        {out && <pre>{out}</pre>}
        {proc.output && (
          <details>
            <summary>up 进程输出</summary>
            <pre>{proc.output}</pre>
          </details>
        )}
      </Box>
      {local && (
        <Box title="本机配置">
          <dl>
            <dt>配置文件</dt>
            <dd>{local.configPath}</dd>
            <dt>规则文件</dt>
            <dd>{local.rulesPath}</dd>
            <dt>通道</dt>
            <dd>{local.channels.join("、") || "未配置"}</dd>
            <dt>本机来源</dt>
            <dd>{local.source || "未配置"}</dd>
          </dl>
          {local.hub && <button onClick={edit}>编辑原生规则文件</button>}
          {local.worker && <Worker key={local.revision} local={local} refresh={refresh} />}
        </Box>
      )}
    </>
  );
}
function Connection({ local }: { local: Settings }) {
  const [url, setUrl] = useState(local.url),
    [listen, setListen] = useState(local.hub?.listen ?? ""),
    [publicUrl, setPublicUrl] = useState(local.hub?.publicUrl ?? "");
  const { act, busy, error } = useAction();
  return (
    <details>
      <summary>编辑连接配置</summary>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void act(async () => {
            if (url !== local.url && !confirm("保存后会使用原生配置中的凭据连接 " + url + "，确认此 Hub 归你管理？"))
              return;
            await api("/connection", { revision: local.revision, url, listen, publicUrl });
            location.reload();
          });
        }}
      >
        <Field title="客户端使用的 Hub 地址">
          <input required type="url" value={url} onChange={(e) => setUrl(e.target.value)} />
        </Field>
        {local.hub && (
          <div className="formgrid">
            <Field title="Hub 监听地址">
              <input required value={listen} onChange={(e) => setListen(e.target.value)} />
            </Field>
            <Field title="Hub 对外地址（可选）">
              <input type="url" value={publicUrl} onChange={(e) => setPublicUrl(e.target.value)} />
            </Field>
          </div>
        )}
        <p className="hint">客户端立即使用新地址。原生进程在下次启动时读取监听与对外地址。</p>
        <ErrorBox text={error} />
        <button disabled={busy}>保存连接配置</button>
      </form>
    </details>
  );
}

function Worker({ local, refresh }: { local: Settings; refresh: () => void }) {
  const w = local.worker!;
  const [cap, setCap] = useState(String(w.capacity ?? "")),
    [args, setArgs] = useState(w.unreachable?.join("\n") ?? ""),
    { error, busy, act } = useAction();
  return (
    <details>
      <summary>Worker 高级配置 · {w.name}</summary>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void act(async () => {
            await api("/worker", {
              revision: local.revision,
              capacity: cap ? Number(cap) : null,
              unreachable: args ? args.split("\n") : [],
            });
            refresh();
          });
        }}
      >
        <Field title="本机并发容量（留空采用原生默认值）">
          <input type="number" min="1" value={cap} onChange={(e) => setCap(e.target.value)} />
        </Field>
        <Field title="Hub 失联通知命令（每行一个参数）">
          <textarea value={args} onChange={(e) => setArgs(e.target.value)} />
        </Field>
        <ErrorBox text={error} />
        <button disabled={busy}>保存 Worker 配置</button>
        <p className="hint">配置在下次启动原生进程时生效。</p>
      </form>
    </details>
  );
}

interface Pr {
  number: number;
  title: string;
  url: string;
  state: string;
  reviewDecision: string;
  statusCheckRollup: {
    name?: string;
    context?: string;
    status?: string;
    state?: string;
    conclusion?: string;
    detailsUrl?: string;
    targetUrl?: string;
  }[];
}
function Project({ id, repo, rules, op }: { id: string; repo: string; rules: string[]; op: (o: RuleOp) => void }) {
  const [num, setNum] = useState(""),
    [pr, setPr] = useState<Pr | null>(null),
    [config, setConfig] = useState(""),
    { act, busy, error } = useAction();
  const endpoint = "/delivery?agent=" + encodeURIComponent(id);
  return (
    <article className="ruleitem">
      <div className="row">
        <h3>{repo || "仓库参数缺失"}</h3>
        <Tag>{id}</Tag>
      </div>
      <p>交付规则　{rules.join("、") || "未关联"}</p>
      <div className="row">
        <button disabled={busy || !repo} onClick={() => void act(async () => setConfig(pretty(await api(endpoint))))}>
          读取 main 项目配置
        </button>
        <LinkOut href={"https://github.com/" + repo}>打开仓库</LinkOut>
      </div>
      {config && <pre>{config}</pre>}
      <form
        className="inlineform"
        onSubmit={(e) => {
          e.preventDefault();
          void act(async () => {
            setPr(null);
            setPr(await api<Pr>(endpoint + "&pr=" + num));
          });
        }}
      >
        <Field title="关联 PR 编号">
          <input
            required
            pattern="[1-9][0-9]*"
            value={num}
            onChange={(e) => {
              setNum(e.target.value);
              setPr(null);
            }}
          />
        </Field>
        <button disabled={busy || !repo}>读取 PR 状态</button>
      </form>
      <ErrorBox text={error} />
      {pr && (
        <>
          <h3>
            <LinkOut href={pr.url}>
              #{pr.number} {pr.title}
            </LinkOut>
          </h3>
          <p>
            PR {pr.state} · 审核 {pr.reviewDecision || "尚无决定"}
          </p>
          {pr.statusCheckRollup.length ? (
            pr.statusCheckRollup.map((s, i) => (
              <p key={i}>
                {s.name || s.context} · {s.conclusion || s.status || s.state}{" "}
                <LinkOut href={s.detailsUrl || s.targetUrl}>检查详情</LinkOut>
              </p>
            ))
          ) : (
            <p className="hint">此 PR 尚无检查记录</p>
          )}
          <div className="row">
            {rules.map((rule) => (
              <button key={rule} onClick={() => op({ kind: "run", rule, subject: repo + "#" + pr.number })}>
                运行「{rule}」
              </button>
            ))}
          </div>
        </>
      )}
    </article>
  );
}
export function Delivery({
  file,
  state,
  open,
  op,
}: {
  file: RuleFile | null;
  state: State | null;
  open: (r: Run) => void;
  op: (o: RuleOp) => void;
}) {
  const doc = parsed(file);
  const agents = Object.entries(doc?.agents ?? {}).filter(([, a]) => a.use === "delivery");
  const names = new Set(agents.map(([id]) => id));
  const rules = doc?.rules.filter((r) => names.has(r.to)) ?? [];
  const runs = state?.runs.filter((r) => names.has(r.agent)) ?? [];
  const cards = [...(state?.cards ?? []), ...(state?.recentCards ?? [])].filter((c) =>
    rules.some((r) => r.name === c.rule),
  );
  return (
    <>
      <Box title="交付项目">
        {agents.length ? (
          agents.map(([id, a]) => (
            <Project
              key={id}
              id={id}
              repo={a.command?.[0] ?? ""}
              rules={rules.filter((r) => r.to === id).map((r) => r.name)}
              op={op}
            />
          ))
        ) : (
          <Empty>{doc ? "当前规则文件没有配置 delivery Agent" : "请连接保存交付规则的 Hub 主机"}</Empty>
        )}
      </Box>
      <Box title="近期交付与审核回执">
        {runs.map((r) => (
          <article className="listitem" key={r.id}>
            <div>
              <h3>{r.events[0]?.subject || r.rule}</h3>
              <p>{r.summary || r.error || "等待交付回执"}</p>
              {r.events.map((e, i) => (
                <LinkOut key={i} href={e.link}>
                  {e.subject || "关联事项"}　
                </LinkOut>
              ))}
            </div>
            <button onClick={() => open(r)}>第 {r.id} 轮</button>
          </article>
        ))}
        {cards.map((c) => (
          <p key={c.id}>
            <strong>{c.title}</strong>　{c.text}　{c.result || c.answer}
          </p>
        ))}
        {!runs.length && !cards.length && <Empty>暂无交付回执或审核卡片</Empty>}
      </Box>
    </>
  );
}
