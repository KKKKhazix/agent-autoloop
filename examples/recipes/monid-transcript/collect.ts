import { pathToFileURL } from "node:url";

type Run = {
  runId?: string;
  status?: string;
  output?: unknown;
  providerResponse?: { httpStatus: number; error?: unknown };
};

export async function transcript(numberId: string, callId: string, request = fetch): Promise<unknown> {
  const key = process.env.MONID_API_KEY;
  if (!key) throw new Error("请先设置 MONID_API_KEY，再运行通话转写示例");
  if (!numberId || !callId) throw new Error("请提供你拥有的号码编号 numberId 和通话编号 callId");
  const headers = { Authorization: `Bearer ${key}`, "content-type": "application/json" };
  async function read(url: string, options: RequestInit): Promise<{ run: Run; status: number }> {
    const response = await request(url, { ...options, headers, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Monid ${response.status}: ${await response.text()}`);
    return { run: await response.json(), status: response.status };
  }
  const started = await read("https://api.monid.ai/v1/run", {
    method: "POST",
    body: JSON.stringify({
      provider: "agentline",
      endpoint: "/calls/{id}/transcript",
      input: { body: { numberId, callId } },
    }),
  });
  let run = started.run;
  if (started.status === 202) {
    const runId = run.runId;
    if (!runId) throw new Error("Monid 没有返回 runId");
    const terminal = new Set(["COMPLETED", "FAILED", "TIMED_OUT", "STOPPED", "BLOCKED"]);
    for (let attempt = 0; attempt < 60 && !terminal.has(run.status ?? ""); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      run = (await read(`https://api.monid.ai/v1/runs/${encodeURIComponent(runId)}`, { method: "GET" })).run;
    }
    if (!terminal.has(run.status ?? "")) throw new Error("Monid 等待超时，请用原 runId 查询结果");
  }
  if (run.status && run.status !== "COMPLETED") throw new Error(`Monid run ${run.status}`);
  const provider = run.providerResponse;
  if (provider && provider.httpStatus >= 400) {
    throw Object.assign(new Error(`AgentLine ${provider.httpStatus}: ${JSON.stringify(provider.error)}`), {
      status: provider.httpStatus,
      error: provider.error,
    });
  }
  return run.output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(await transcript(process.argv[2], process.argv[3]), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
