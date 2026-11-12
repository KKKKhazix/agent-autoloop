# Route background tasks through HiRoute

[中文](README.md)

Routine work such as feedback triage can use an economical model with tool support and consume less of your primary model's token allowance. Autoloop uses the existing Agent plugin to dispatch jobs, resume sessions, and collect receipts. The Agent sends model requests through [HiRoute](https://hiroute.ai/), which selects the model and records usage.

## Set up on the worker machine

Start HiRoute on the machine that runs the Agent. Connect an economical model and publish a fixed route for feedback triage. A fixed route tries the configured candidates in order and skips the decision call. If the difficulty varies across runs of a rule, try difficulty routing. [Connect models](https://hiroute.ai/en/docs/models/) · [Smart routing](https://hiroute.ai/en/docs/model-routing/)

Choose an Agent already installed on that machine.

- For **Claude Code**, open Agent → Claude Code → Model routing in HiRoute and map the route to the preset you use, such as Sonnet. The sample selects it with `use: "claude"` and `model: "sonnet"`. If you map another preset, update `model` accordingly. [Claude Code setup](https://hiroute.ai/en/docs/claude-code-model-routing/#connect-agent)
- For **Codex**, select On demand · CLI only for Codex CLI in HiRoute, set the published route as the profile default, and copy the configuration directory from the launch command. The script below selects the HiRoute profile for `exec`. Put the script's absolute path in `program` on the sample `hiroute-codex` agent. [Codex CLI setup](https://hiroute.ai/en/docs/codex-model-routing/)

On macOS or Linux, save this as `codex-via-hiroute.sh`, replace both paths, and make the script executable with `chmod +x`.

```sh
#!/bin/sh
codex_config='/absolute/path/to/codex-config'
codex_bin='/absolute/path/to/codex'
if [ "${1:-}" = exec ]; then
  CODEX_HOME="$codex_config" exec "$codex_bin" --profile hiroute "$@"
fi
CODEX_HOME="$codex_config" exec "$codex_bin" "$@"
```

On Windows, save this as `codex-via-hiroute.ps1` and use the configuration directory from the HiRoute launch command and the path to your Codex executable.

```powershell
$env:CODEX_HOME = 'C:\path\to\codex-config'
$codex = 'C:\path\to\codex.exe'
if ($args[0] -eq 'exec') {
  & $codex --profile hiroute @args
} else {
  & $codex @args
}
exit $LASTEXITCODE
```

Keep model credentials in HiRoute. The Codex check in `agent-autoloop doctor` checks the native login and may report that you are signed out when you use gateway credentials alone. Use the trial below to verify an actual request through HiRoute.

## Try a read-only rule

1. Create a scratch directory on the worker machine. Save these three lines as `feedback.txt` in that directory.

   ```text
   A The app exits when I export a CSV after the update.
   B I would like to choose which columns to export to CSV.
   C Where can I download an existing report?
   ```

2. Merge `sources`, the chosen entry under `agents`, and the rule from [rules.json](rules.json) into your rules file. Set `worker` to your worker name from `agent-autoloop status` and `cwd` to your scratch directory. `to` selects Claude Code by default. Set it to `hiroute-codex` to use Codex. The sample uses `access: "read"`, which the selected Agent plugin handles.
3. Run `agent-autoloop check`, then `agent-autoloop run "HiRoute feedback triage"`. Check the result in `agent-autoloop status`. The expected labels are `bug` for A, `feature` for B, and `question` for C. In HiRoute, open Sessions → Routing timeline and check the route and model used.

## Measure savings

Run the same input with your original model and with the economical route, and use the same acceptance criteria. Record primary-model tokens, input, output, and cache usage. Include retries and any extra decision calls. Use `agent-autoloop why` to inspect the run and HiRoute's [routing timeline and cost analysis](https://hiroute.ai/en/docs/optimize-model-routing/) to inspect the actual model and estimated API-equivalent cost.

A less expensive model can reduce the cost of the same usage, and routing routine work to it can save primary-model tokens. To reduce total tokens, use a script to filter events that need no work and give independent tasks only the material they need.
