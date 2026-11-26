// Local code execution stays outside the kernel. Only configured files in a private clone may be changed by the model.
import { execFileSync, spawn } from "node:child_process";
import { commandLine } from "../../../host/command.ts";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join, resolve, relative, sep } from "node:path";
import { codeProof, modelReply, type Project, type CodeProof } from "./loop.ts";

// Native resolution expands Windows short aliases; path.relative also respects Windows case-insensitive spelling.
const realPath = realpathSync.native;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    ["-c", `core.hooksPath=${join(dirname(cwd), "hooks-disabled")}`, "-c", "core.fsmonitor=false", "-C", cwd, ...args],
    {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    },
  );
const policy = (project: Project) => hash(JSON.stringify(project));

export function codeWorkspace(project: Project, home: string, subject: string) {
  if (!project.code || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(subject)) throw new Error("代码项目或运行编号无效");
  const folder = join(resolve(home), "goal-code", project.id, subject);
  const workspace = join(folder, "workspace");
  const metadata = join(folder, "policy.json");
  if (existsSync(metadata)) {
    if (JSON.parse(readFileSync(metadata, "utf8")).policy !== policy(project))
      throw new Error("目标运行期间项目配置发生变化");
    return workspace;
  }
  if (existsSync(workspace)) throw new Error("代码副本初始化未完成，请使用新的运行编号");
  const repository = realPath(project.code.repository);
  if (relative(realPath(git(repository, "rev-parse", "--show-toplevel").trim()), repository) !== "")
    throw new Error("需要 Git 仓库根目录");
  const baseline = git(repository, "rev-parse", "--verify", "refs/heads/main^{commit}").trim();
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  execFileSync(
    "git",
    [
      "-c",
      `core.hooksPath=${join(folder, "hooks-disabled")}`,
      "clone",
      "--no-checkout",
      "--no-hardlinks",
      "--",
      repository,
      workspace,
    ],
    { stdio: "ignore" },
  );
  git(workspace, "checkout", "--detach", baseline);
  // Source files must already be regular files on main, with no symlink ancestors. Acceptance files remain at baseline.
  for (const path of project.code.files) {
    if (!/^100(644|755) blob /.test(git(workspace, "ls-tree", "HEAD", "--", path)))
      throw new Error("只能修改 main 已有的普通文件");
    if (realPath(join(workspace, path)) !== join(realPath(workspace), path)) throw new Error("文件不能经过符号链接");
  }
  const editable = project.code.files.map((path) => realPath(join(workspace, path)));
  for (const path of project.code.checkFiles) {
    const target = realPath(join(workspace, path));
    if (!target.startsWith(realPath(workspace) + sep) || !lstatSync(target).isFile() || editable.includes(target))
      throw new Error("验收真实入口不能在白名单内或副本外");
  }
  const originalRoot = realPath(project.code.repository);
  for (const arg of project.code.check) {
    // Both positional paths and --root=/path style options must stay away from the source checkout.
    const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : arg;
    const resolved = resolve(workspace, value);
    const actual = existsSync(resolved) ? realPath(resolved) : resolved;
    if (actual === originalRoot || actual.startsWith(originalRoot + sep))
      throw new Error("验收命令不能指向原仓库，请使用副本相对路径");
    const target = resolve(workspace, arg);
    if (existsSync(target) && editable.includes(realPath(target))) throw new Error("验收命令指向可修改文件");
  }
  writeFileSync(metadata, JSON.stringify({ policy: policy(project), baseline }), { mode: 0o600 });
  return workspace;
}

function sources(project: Project, workspace: string) {
  if (!project.code) throw new Error("未配置代码任务");
  const changed = git(workspace, "diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", "HEAD", "--")
    .split("\0")
    .filter(Boolean);
  if (changed.some((path) => !project.code!.files.includes(path))) throw new Error("验收入口或白名单外文件被修改");
  return project.code.files.map((path) => {
    const full = join(workspace, path);
    if (!lstatSync(full).isFile() || realPath(full) !== join(realPath(workspace), path))
      throw new Error("代码路径不再是普通文件");
    const content = readFileSync(full, "utf8");
    if (content.length > 24000 || !content.isWellFormed()) throw new Error("单个代码文件最多 24000 字");
    return { path, content };
  });
}

type CheckLog = {
  command: string[];
  stdout: string;
  stderr: string;
  state?: "running" | "finished";
  exitCode?: number;
  logError?: string;
};
type CheckProgress = { attempt: string; revision: string; check: CheckLog };
type CodeSnapshot = {
  files: { path: string; content: string }[];
  diff: string;
  revision: string;
  proof?: CodeProof;
  check?: CheckLog;
  lastCheck?: CheckProgress;
};
export function inspectCode(
  project: Project,
  workspace: string,
  expected: string,
): CodeSnapshot & { proof: CodeProof; check: CheckLog };
export function inspectCode(project: Project, workspace: string, expected?: string): CodeSnapshot;
export function inspectCode(project: Project, workspace: string, expected?: string): CodeSnapshot {
  const baseline = JSON.parse(readFileSync(join(dirname(workspace), "policy.json"), "utf8"));
  if (baseline.policy !== policy(project) || git(workspace, "rev-parse", "HEAD").trim() !== baseline.baseline)
    throw new Error("执行副本的配置或 main 基准发生变化");
  const files = sources(project, workspace);
  const revision = hash(JSON.stringify(files));
  const record = join(dirname(workspace), "check.json");
  const check = existsSync(record) ? JSON.parse(readFileSync(record, "utf8")) : null;
  const proof = check ? codeProof(check.proof) : undefined;
  const progressFile = join(dirname(workspace), "check-progress.json");
  const progress: CheckProgress | undefined = existsSync(progressFile)
    ? JSON.parse(readFileSync(progressFile, "utf8"))
    : undefined;
  const matching = proof?.revision === revision && (!progress || progress.attempt === check.attempt);
  if (expected && (expected !== revision || !matching)) throw new Error("代码已变更，原测试和审查证据失效");
  const diff = git(workspace, "diff", "--no-ext-diff", "--no-textconv", "HEAD", "--", ...project.code!.files);
  if (JSON.stringify(files).length > 48000) throw new Error("代码上下文超过本示例上限");
  // A candidate without a check for this exact revision is unchecked, never paired with an older result or log.
  return {
    files,
    diff,
    revision,
    proof: matching ? proof : undefined,
    check: matching ? check.check : progress?.revision === revision ? progress.check : undefined,
    lastCheck: progress && progress.revision !== revision ? progress : undefined,
  };
}

export async function applyChanges(project: Project, workspace: string, value: unknown) {
  if (!project.code || !Array.isArray(value) || !value.length || value.length > project.code.files.length)
    throw new Error("需要白名单内的文件修改");
  const seen = new Set<string>();
  const changes = value.map((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      Object.keys(item).some((key) => !["path", "content"].includes(key)) ||
      !project.code!.files.includes(item.path) ||
      seen.has(item.path) ||
      typeof item.content !== "string" ||
      item.content.length > 24000 ||
      !item.content.isWellFormed()
    )
      throw new Error("模型修改越界或内容无效");
    seen.add(item.path);
    return { path: item.path as string, content: item.content as string };
  });
  const current = sources(project, workspace);
  const prospective = current.map((file) => changes.find((change) => change.path === file.path) ?? file);
  if (JSON.stringify(prospective).length > 48000) throw new Error("代码上下文超过本示例上限");
  for (const change of changes) writeFileSync(join(workspace, change.path), change.content);
  const snapshot = inspectCode(project, workspace);
  const [program, args] = commandLine(project.code.check);
  const progress: CheckProgress = {
    attempt: randomUUID(),
    revision: snapshot.revision,
    check: { command: project.code.check, stdout: "", stderr: "", state: "running" },
  };
  const progressFile = join(dirname(workspace), "check-progress.json");
  const persist = () => {
    writeFileSync(progressFile + ".tmp", JSON.stringify(progress), { mode: 0o600 });
    renameSync(progressFile + ".tmp", progressFile);
  };
  // Mark this attempt before launch so an older successful check cannot stand in for an interrupted rerun.
  persist();
  const remember = () => {
    try {
      persist();
    } catch (error) {
      progress.check.logError = String((error as { code?: string }).code ?? "IO");
    }
  };
  // Drain and persist bounded tails during execution, including when the worker later terminates the whole tree.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      [
        "HOME",
        "PATH",
        "TMPDIR",
        "TMP",
        "TEMP",
        "USER",
        "USERNAME",
        "USERPROFILE",
        "SystemRoot",
        "SYSTEMROOT",
        "ComSpec",
        "COMSPEC",
        "PATHEXT",
        "APPDATA",
        "LOCALAPPDATA",
        "LANG",
      ].includes(key),
    ),
  );
  const { exitCode, stdout, stderr } = await new Promise<{ exitCode: number; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(program, args, { cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        progress.check.stdout = (progress.check.stdout + chunk).slice(-8000);
        remember();
      });
      child.stderr.on("data", (chunk: string) => {
        progress.check.stderr = (progress.check.stderr + chunk).slice(-8000);
        remember();
      });
      child.once("error", () => reject(new Error("验收命令无法启动")));
      child.once("close", (code) => {
        if (code === null) reject(new Error("验收命令未正常结束，不能生成通过证据"));
        else resolve({ exitCode: code, stdout: progress.check.stdout, stderr: progress.check.stderr });
      });
    },
  );
  progress.check.state = "finished";
  progress.check.exitCode = exitCode;
  remember();
  // Tests must not rewrite the candidate: both the review and the recorded status bind to this exact source snapshot.
  if (inspectCode(project, workspace).revision !== snapshot.revision) throw new Error("验收命令改写了待审代码");
  const proof: CodeProof = {
    revision: snapshot.revision,
    passed:
      exitCode === 0 &&
      (project.requiredText ?? []).every((text) => snapshot.files.some((file) => file.content.includes(text))),
    exitCode,
  };
  const record = {
    proof,
    attempt: progress.attempt,
    check: { ...progress.check, stdout, stderr },
  };
  const file = join(dirname(workspace), "check.json");
  writeFileSync(file + ".tmp", JSON.stringify(record), { mode: 0o600 });
  renameSync(file + ".tmp", file);
  return inspectCode(project, workspace, proof.revision);
}

type SavedReply = { value: ReturnType<typeof modelReply>; proof: CodeProof };
const roundFile = (workspace: string, round: number) => {
  if (!Number.isInteger(round) || round < 1 || round > 4) throw new Error("起草轮次无效");
  return join(dirname(workspace), `draft-${round}.json`);
};

export function savedCodeReply(project: Project, workspace: string, round: number): SavedReply | undefined {
  const file = roundFile(workspace, round);
  if (!existsSync(file)) return;
  const record = JSON.parse(readFileSync(file, "utf8"));
  const value = modelReply(record.value, "draft");
  const proof = codeProof(record.proof);
  // This is a historical receipt replay, not acceptance of the current candidate. Never overwrite a later revision.
  inspectCode(project, workspace);
  return { value, proof };
}

export function saveCodeReply(workspace: string, round: number, value: unknown, proof: CodeProof) {
  const record = { value: modelReply(value, "draft"), proof: codeProof(proof) };
  const file = roundFile(workspace, round);
  writeFileSync(file + ".tmp", JSON.stringify(record), { mode: 0o600 });
  renameSync(file + ".tmp", file);
}
