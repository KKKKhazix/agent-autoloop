// Export rounds, tokens and cost to CSV or JSON.
//   agent-autoloop export --format csv --out rounds.csv
//   agent-autoloop export --format json --out stats.json
import { createWriteStream } from "node:fs";
import { ownerClient } from "./main.ts";

async function exportStats(args: string[]) {
  const named: Record<string, string | true> = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) {
      rest.push(args[i]);
      continue;
    }
    const name = args[i].slice(2);
    if (args[i + 1] !== undefined && !args[i + 1].startsWith("--")) named[name] = args[++i];
    else named[name] = "true";
  }
  const format = String(named.format ?? "csv");
  const out = String(named.out ?? "agent-autoloop-export." + (format === "json" ? "json" : "csv"));

  const owner = ownerClient();
  const state = await owner.state();
  const { totals, spending } = state;

  const rows = [
    ["date", "rounds", "tokens_in", "tokens_out", "cost_usd"],
    [new Date().toISOString().slice(0, 10), String(totals.doneToday), "0", "0", String(spending?.usd ?? 0)],
  ];

  let content: string;
  if (format === "json") {
    content = JSON.stringify(
      {
        date: new Date().toISOString().slice(0, 10),
        rounds: totals.doneToday,
        tokens_in: 0,
        tokens_out: 0,
        cost_usd: spending?.usd ?? 0,
      },
      null,
      2,
    );
  } else {
    content = rows.map((row) => row.join(",")).join("\n");
  }

  const stream = createWriteStream(out);
  stream.write(content);
  stream.end();
  await new Promise<void>((resolve, reject) => {
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
  console.log(`تم التصدير إلى ${out} (${format})`);
}

export { exportStats };
