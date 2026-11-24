import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, Box, Empty, ErrorBox, msg, Runs } from "./common";
import { Icon, Logo } from "./icons";
import { useHub } from "./useHub";
import { Dashboard, Waiting } from "./dashboard";
import { ConfigPage, Draft, type Edit } from "./configuration";
import { Approvals, History, Logs, RuleAction, type RuleOp, RunDetail } from "./operations";
import { Delivery, System } from "./system";
import type { Page, RuleFile, Run, Settings } from "./types";
import "./style.css";

const pages: Record<Page, [string, string]> = {
  overview: ["运行看板", "查看中台、接单节点与任务的运行情况。"],
  tasks: ["任务管理", "发布任务，跟踪当前轮次与历史执行记录。"],
  rules: ["工作流", "管理事件触发、执行规则与工作目录。"],
  agents: ["Agent 管理", "查看接单状态，配置执行插件与运行参数。"],
  cards: ["审核与审批", "处理 Agent 提问、通知与已结案的卡片。"],
  delivery: ["GitHub 交付", "查看交付项目、关联 PR、检查与审核回执。"],
  logs: ["运行日志", "查看实时事实流，追溯每一轮的执行过程。"],
  settings: ["系统设置", "检查本机环境、Hub 连接与原生进程。"],
};
const pageFromHash = (): Page => {
  const key = location.hash.slice(1);
  return Object.hasOwn(pages, key) ? (key as Page) : "overview";
};
function App() {
  const [page, setPage] = useState<Page>(pageFromHash),
    [nav, setNav] = useState(false),
    hub = useHub();
  const [local, setLocal] = useState<Settings | null>(null),
    [file, setFile] = useState<RuleFile | null>(null),
    [localError, setLocalError] = useState("");
  const [op, setOp] = useState<RuleOp | null>(null),
    [edit, setEdit] = useState<Edit | null>(null),
    [detail, setDetail] = useState<Run | null>(null),
    [notice, setNotice] = useState(""),
    [loading, setLoading] = useState(false);
  const localLoad = useCallback(async () => {
    try {
      const s = await api<Settings>("/local");
      setLocal(s);
      setFile(s.hub ? await api<RuleFile>("/rules") : null);
      setLocalError("");
    } catch (e) {
      setFile(null);
      setLocalError(msg(e));
    }
  }, []);
  async function sync() {
    setLoading(true);
    try {
      await Promise.all([hub.refresh(), localLoad()]);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void localLoad();
    const change = () => {
      setPage(pageFromHash());
      setNav(false);
      setEdit(null);
      setOp(null);
      setDetail(null);
    };
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, [localLoad]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 5500);
    return () => clearTimeout(t);
  }, [notice]);
  const go = (p: Page) => {
    location.hash = p;
    setNav(false);
  };
  const online = !!hub.state && !hub.error;
  const link = (p: Page) => (
    <a key={p} href={"#" + p} aria-current={page === p ? "page" : undefined} onClick={() => setNav(false)}>
      <Icon name={p} />
      {pages[p][0]}
      {p === "cards" && !!hub.state?.cards.length && <b>{hub.state.cards.length}</b>}
    </a>
  );
  return (
    <div className="shell">
      {nav && <button className="scrim" aria-label="关闭导航" onClick={() => setNav(false)} />}
      <aside className={nav ? "show" : ""}>
        <div className="brand">
          <Logo />
          <div>
            Autoloop<small>Agent 控制台</small>
          </div>
        </div>
        <nav>
          <label>工作空间</label>
          {(["overview", "tasks", "rules", "agents"] as Page[]).map(link)}
          <label>运行与交付</label>
          {(["cards", "delivery", "logs"] as Page[]).map(link)}
          <label>本机</label>
          {link("settings")}
        </nav>
        <div className="sidefoot">
          <span className={"light " + (online ? "on" : "")} />
          <span>{online ? "Hub 在线" : "Hub 未连接"}</span>
        </div>
      </aside>
      <main>
        <header className="top">
          <button className="mobile" aria-label="打开导航" onClick={() => setNav(true)}>
            <Icon name="menu" />
          </button>
          <span>本地工作区</span>
          <span className="slash">/</span>
          <strong>{pages[page][0]}</strong>
          <button className="refresh" onClick={() => void sync()} disabled={loading}>
            <Icon name="refresh" />
            {loading ? "刷新中" : "刷新"}
          </button>
        </header>
        <div className="content">
          <div className="pagehead">
            <div>
              <h1>{pages[page][0]}</h1>
              <p>{pages[page][1]}</p>
            </div>
            {(page === "overview" || page === "tasks") && (
              <button
                className="primary"
                disabled={!online || !hub.state?.lines.some((l) => !l.paused)}
                onClick={() => setOp({ kind: "run" })}
              >
                <Icon name="plus" />
                发布任务
              </button>
            )}
          </div>
          <ErrorBox text={hub.error && (hub.state ? "显示上次快照。" : "") + hub.error} />
          {["settings", "agents", "rules", "delivery"].includes(page) && (
            <ErrorBox text={localError || file?.problem} />
          )}
          {page === "overview" && (
            <Dashboard state={hub.state} local={local} online={online} go={go} open={setDetail} />
          )}
          {page === "tasks" && (
            <>
              <Box title="进行中的轮次">
                {hub.state ? (
                  <Runs
                    runs={hub.state.runs.filter((r) => ["claimed", "queued", "unknown"].includes(r.state))}
                    open={setDetail}
                  />
                ) : (
                  <Empty>等待读取 Hub 快照</Empty>
                )}
              </Box>
              {hub.state && <Waiting state={hub.state} />}
              <History state={hub.state} open={setDetail} />
            </>
          )}
          {(page === "rules" || page === "agents") && (
            <ConfigPage
              agents={page === "agents"}
              state={hub.state}
              file={file}
              settings={local}
              edit={setEdit}
              op={setOp}
            />
          )}
          {page === "cards" &&
            (hub.state ? <Approvals state={hub.state} refresh={hub.refresh} /> : <Empty>等待读取审批卡片</Empty>)}
          {page === "delivery" && <Delivery file={file} state={hub.state} open={setDetail} op={setOp} />}
          {page === "logs" && <Logs facts={hub.facts} stream={hub.stream} state={hub.state} open={setDetail} />}
          {page === "settings" && <System local={local} refresh={sync} edit={() => setEdit({ kind: "json" })} />}
        </div>
      </main>
      {op && (
        <RuleAction
          op={op}
          lines={hub.state?.lines ?? []}
          close={() => {
            setOp(null);
            void hub.refresh();
          }}
          done={(s) => {
            setNotice(s);
            setOp(null);
            void hub.refresh();
          }}
        />
      )}
      {edit && file && local && (
        <Draft
          edit={edit}
          file={file}
          settings={local}
          close={() => setEdit(null)}
          saved={(f) => {
            setFile(f);
            setEdit(null);
            setNotice("规则已通过原生校验并写入文件");
            void hub.refresh();
          }}
        />
      )}
      {detail && (
        <RunDetail
          run={hub.state?.runs.find((r) => r.id === detail.id) ?? detail}
          runAgain={
            hub.state?.lines.some((l) => l.name === detail.rule && !l.paused)
              ? () => {
                  setOp({ kind: "run", rule: detail.rule, subject: detail.events[0]?.subject });
                  setDetail(null);
                }
              : undefined
          }
          close={() => setDetail(null)}
          refresh={hub.refresh}
        />
      )}
      {notice && (
        <div role="status" className="toast">
          {notice}
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
