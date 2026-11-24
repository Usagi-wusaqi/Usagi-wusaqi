/**
 * git 子进程封装：克隆、取提交元数据、批量取 diff。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { FS, GIT_TIMEOUT_MS, GREEN, TS, YELLOW } from "./format.js";

/** 全局 git 认证参数，由 setGitAuth 写入，所有 git 子进程共用。 */
let gitAuthArgs = [];

/**
 * 把令牌放进请求头而非仓库地址，避免写进 .git/config。
 *
 * 通过 `-c` 传入，取值为环境变量形式，子进程（含懒拉取 blob 的 fetch）
 * 同样生效，仓库地址保持干净。
 */
export function setGitAuth(token) {
  if (!token) {
    gitAuthArgs = [];
    return;
  }
  const pair = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
  gitAuthArgs = [
    "-c",
    `http.https://github.com/.extraheader=AUTHORIZATION: basic ${pair}`,
  ];
}

/** 返回 { stdout, stderr, code }，失败原因交给调用方决定是否展示。 */
export function runGitRaw(args, { cwd = null, stdinData = null } = {}) {
  return new Promise((resolve) => {
    const child = spawn("git", [...gitAuthArgs, ...args], {
      cwd: cwd ?? undefined,
      // 令牌无效时直接失败，不等待交互式输入
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const out = [];
    const err = [];
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
    }, GIT_TIMEOUT_MS);

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", (exc) => {
      finish({ stdout: "", stderr: String(exc), code: 1 });
    });
    child.on("close", (code) => {
      finish({
        stdout: Buffer.concat(out).toString("utf8").trim(),
        stderr: Buffer.concat(err).toString("utf8").trim(),
        code: code ?? 1,
      });
    });

    child.stdin.on("error", () => {
      // 子进程提前退出时忽略 EPIPE
    });
    child.stdin.end(stdinData === null ? "" : stdinData);
  });
}

export async function runGit(args, options = {}) {
  const { stdout, code } = await runGitRaw(args, options);
  return { stdout, code };
}

export class CloneError extends Error {
  /** 仓库无法就绪，该仓库的统计结果不可信。 */
  constructor(message) {
    super(message);
    this.name = "CloneError";
  }
}

/** 取分支的 commit SHA，可指定取本地记录还是远端当前值。 */
export async function branchSha(repoPath, remote, branch, { atRemote }) {
  if (!atRemote) {
    const { stdout, code } = await runGit(
      ["rev-parse", `refs/remotes/${remote}/${branch}`],
      { cwd: repoPath },
    );
    return code === 0 ? stdout.trim() : "";
  }

  const { stdout, code } = await runGit(["ls-remote", "--heads", remote, branch], {
    cwd: repoPath,
  });
  if (code !== 0) {
    return "";
  }
  const expected = `refs/heads/${branch}`;
  for (const line of stdout.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) {
      continue;
    }
    if (line.slice(tab + 1).trim() === expected) {
      return line.slice(0, tab).trim();
    }
  }
  return "";
}

export async function remoteNameOf(repoPath) {
  const { stdout } = await runGit(["remote"], { cwd: repoPath });
  const names = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return names.length ? names[0] : "origin";
}

/** 返回 [远程名, 默认分支]。本地记录缺失时向远端查询一次。 */
export async function defaultBranchOf(repoPath, remote = null) {
  const name = remote ?? (await remoteNameOf(repoPath));
  const prefix = `refs/remotes/${name}/`;
  const symbolic = await runGit(["symbolic-ref", `refs/remotes/${name}/HEAD`], {
    cwd: repoPath,
  });
  if (symbolic.code === 0 && symbolic.stdout.startsWith(prefix)) {
    return [name, symbolic.stdout.slice(prefix.length)];
  }

  // 本地没有记录符号引用时问远端，避免把 master 默认分支错猜成 main
  const listed = await runGit(["ls-remote", "--symref", name, "HEAD"], {
    cwd: repoPath,
  });
  if (listed.code === 0) {
    for (const line of listed.stdout.split("\n")) {
      // 形如 `ref: refs/heads/main\tHEAD`
      if (line.startsWith("ref:")) {
        const ref = line.slice(4).trim().split(/\s+/)[0];
        if (ref.startsWith("refs/heads/")) {
          return [name, ref.slice("refs/heads/".length)];
        }
      }
    }
  }
  return [name, "main"];
}

export async function cloneOrUpdate(repoPath, cloneUrl, log) {
  if (fs.existsSync(repoPath)) {
    const remote = await remoteNameOf(repoPath);
    // 上游可能改名或转让，让远端地址始终跟随当前仓库
    await runGit(["remote", "set-url", remote, cloneUrl], { cwd: repoPath });
    const [, branch] = await defaultBranchOf(repoPath, remote);
    const localSha = await branchSha(repoPath, remote, branch, {
      atRemote: false,
    });
    // 只比对远端分支的 SHA，没有新提交时一次网络往返即可，不触发对象协商
    if (
      localSha &&
      localSha ===
        (await branchSha(repoPath, remote, branch, { atRemote: true }))
    ) {
      log.color("  ✅ 已是最新", GREEN);
      return;
    }
    log.color("  🔄 拉取新增提交...", YELLOW);
    // 显式 refspec：单分支克隆的默认 refspec 不会跟踪新分支，
    // 上游改默认分支名后仍能把新分支拉到本地
    const fetched = await runGit(
      [
        "fetch",
        remote,
        `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`,
        "--prune",
        "--no-tags",
      ],
      { cwd: repoPath },
    );
    if (fetched.code === 0) {
      return;
    }
    // 本地克隆损坏、远端地址变更或网络中断：清掉重新克隆，避免沿用旧历史
    log.color("  ⚠️  更新失败，重新克隆", YELLOW);
    fs.rmSync(repoPath, { recursive: true, force: true });
  }

  log.color("  📥 克隆仓库...", YELLOW);
  // 只取默认分支：gh-pages 上是构建出来的页面而不是代码，不计行数，不值得多拉一份
  // 历史。统计只需要 commit 与 tree 对象；文件内容（blob）只在缓存未命中的少数 commit
  // 计算增删行数时才用到，git 会按需补拉。这类仓库的对象里有 96% 以上是 blob，
  // 因此用 blobless 部分克隆压掉下载量，比全量拉取省一个数量级。
  let code = 1;
  let detail = "";
  for (const filterArgs of [["--filter=blob:none"], []]) {
    const result = await runGitRaw(
      [
        "clone",
        ...filterArgs,
        "--no-checkout",
        "--single-branch",
        "--no-tags",
        cloneUrl,
        path.basename(repoPath),
      ],
      { cwd: path.dirname(repoPath) },
    );
    detail = result.stderr;
    code = result.code;
    if (code === 0 && fs.existsSync(repoPath)) {
      break;
    }
    // 失败（如 git 版本不支持 filter）会留下半成品目录，清掉再退回全量克隆
    if (fs.existsSync(repoPath)) {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  }
  if (code !== 0 || !fs.existsSync(repoPath)) {
    // 只取末行，git 的致命错误信息通常就在这一行
    const lines = detail.split("\n").filter(Boolean);
    const tail = lines.length ? lines[lines.length - 1].slice(0, 200) : "";
    throw new CloneError(
      `克隆 ${path.basename(repoPath)} 失败` + (tail ? `: ${tail}` : ""),
    );
  }
}

export function commitMetaFormat() {
  return `${FS}%H${FS}%aI${FS}%an${FS}%ae${FS}%(trailers:key=Co-authored-by,valueonly=true,separator=${TS})`;
}

/**
 * 一次 git log 拿到全部 commit 元数据，在本地按邮箱过滤。
 *
 * 全历史只扫描一次，过滤在内存中完成。
 * 匹配只比较邮箱，名字不参与；GitHub 判定归属也是同样的口径。
 * 返回 null 表示历史读取失败，与「确实没有提交」区分开。
 */
export async function collectUserCommits(repoPath, remote, branch, emails) {
  const { stdout, code } = await runGit(
    ["log", `${remote}/${branch}`, `--format=${commitMetaFormat()}`],
    { cwd: repoPath },
  );
  if (code !== 0) {
    // 分支引用不存在（空仓库或默认分支判断错误）按 0 提交处理，
    // 引用存在却读不出来才是真的失败，需要让调用方报错而不是记成 0
    const { code: refCode } = await runGit(
      ["show-ref", "--verify", "--quiet", `refs/remotes/${remote}/${branch}`],
      { cwd: repoPath },
    );
    return refCode === 0 ? null : [];
  }

  const wanted = new Set(
    emails.map((email) => email.trim().toLowerCase()).filter(Boolean),
  );
  if (!wanted.size) {
    return [];
  }

  const result = [];
  const seen = new Set();
  for (const line of stdout.split("\n")) {
    if (!line.startsWith(FS)) {
      continue;
    }
    const parts = line.slice(1).split(FS);
    if (parts.length < 5) {
      continue;
    }
    const [sha, date, , email, trailers] = parts;
    if (seen.has(sha)) {
      continue;
    }

    const emailKey = email.trim().toLowerCase();
    let matched = Boolean(emailKey) && wanted.has(emailKey);
    if (!matched && trailers) {
      for (const item of trailers.split(TS)) {
        // trailer 形如 `Name <email>`，只取尖括号中的地址参与比较
        const pos = item.lastIndexOf("<");
        if (pos < 0) {
          continue;
        }
        const candidate = item
          .slice(pos + 1)
          .replace(/[> ]+$/, "")
          .trim()
          .toLowerCase();
        if (candidate && wanted.has(candidate)) {
          matched = true;
          break;
        }
      }
    }
    if (matched) {
      seen.add(sha);
      result.push([sha, date]);
    }
  }
  return result;
}

/**
 * 一次 git log 批量取所有目标 commit 的增删行数与文件状态。
 *
 * 一批提交共用一个 git 进程。
 */
export async function collectCommitDetails(repoPath, shas) {
  if (!shas.length) {
    return new Map();
  }

  const fmt = `${FS}%H${FS}%aI`;
  const { stdout, code } = await runGit(
    ["log", "--raw", "--numstat", "--no-walk", "--stdin", `--format=${fmt}`],
    { cwd: repoPath, stdinData: `${shas.join("\n")}\n` },
  );
  if (code !== 0) {
    return new Map();
  }

  const details = new Map();
  let current = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith(FS)) {
      current = line.slice(1).split(FS)[0];
      details.set(current, { additions: 0, deletions: 0, files: [] });
      continue;
    }
    if (current === null || !line) {
      continue;
    }
    const entry = details.get(current);
    if (line.startsWith(":")) {
      // :<srcmode> <dstmode> <srcsha> <dstsha> <status>\t<path>[\t<oldpath>]
      const fields = line.slice(1).split("\t");
      const meta = fields[0].split(/\s+/);
      const status = meta.length ? meta[meta.length - 1].replace(/\d+$/, "") : "";
      const filePath =
        fields.length >= 3 ? fields[2] : fields.length >= 2 ? fields[1] : "";
      if (filePath) {
        const kind = status === "A" || status === "C" ? "added" : "modified";
        entry.files.push({ filename: filePath, status: kind });
      }
    } else if (line.includes("\t")) {
      const [additions, deletions] = line.split("\t");
      if (additions !== "-") {
        const value = Number.parseInt(additions, 10);
        if (Number.isFinite(value)) {
          entry.additions += value;
        }
      }
      if (deletions !== "-") {
        const value = Number.parseInt(deletions, 10);
        if (Number.isFinite(value)) {
          entry.deletions += value;
        }
      }
    }
  }
  return details;
}

export function countImages(app, files) {
  let total = 0;
  for (const item of files ?? []) {
    if (item?.status !== "added") {
      continue;
    }
    const lower = String(item.filename ?? "").toLowerCase();
    if (app.imageExtensions.some((ext) => lower.endsWith(ext))) {
      total += 1;
    }
  }
  return total;
}
