/**
 * git 不可用时的 API 兜底。
 */

import { NC, RED, intOf, nowIsoUtc } from "./format.js";
import { apiPerPage } from "./github.js";
import { ApiError, apiJson } from "./http.js";

export async function getCommitsFromApi(app, owner, repoName, branch, log) {
  const base = app.api.github_api_base;
  const perPage = apiPerPage(app);
  const maxPages = intOf(app.api.max_api_pages, 10);
  const commits = [];

  let page = 1;
  for (; page <= maxPages; page += 1) {
    const url =
      `${base}/repos/${owner}/${repoName}/commits` +
      `?author=${app.originUsername}&sha=${branch}&per_page=${perPage}&page=${page}`;
    log.color(`    🔍 API 获取commits (第${page}页)...`, NC);
    let data;
    try {
      data = await apiJson(app, url);
    } catch (exc) {
      if (exc instanceof ApiError && exc.kind === "rate_limit") {
        app.setRateLimit(exc.message);
      } else {
        log.color("    ❌ API调用失败", RED);
      }
      return commits;
    }
    if (!Array.isArray(data) || !data.length) {
      break;
    }
    for (const item of data) {
      const sha = item?.sha ?? "";
      const date = item?.commit?.author?.date ?? nowIsoUtc();
      if (sha) {
        commits.push([sha, date]);
      }
    }
    log.color(`    📊 已获取 ${commits.length} 个提交`, NC);
    if (data.length < perPage) {
      break;
    }
  }

  if (page > maxPages) {
    log.color(
      `    ℹ️  已达到最大页数限制 (${maxPages} 页)，共 ${commits.length} 个提交`,
      NC,
    );
  }
  return commits;
}

export async function getDetailsFromApi(app, owner, repoName, sha) {
  const url = `${app.api.github_api_base}/repos/${owner}/${repoName}/commits/${sha}`;
  let data;
  try {
    data = await apiJson(app, url);
  } catch (exc) {
    if (exc instanceof ApiError && exc.kind === "rate_limit") {
      app.setRateLimit(exc.message);
    }
    return { additions: 0, deletions: 0, files: [] };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { additions: 0, deletions: 0, files: [] };
  }
  const stats = data.stats ?? {};
  const files = (data.files ?? []).map((file) => ({
    filename: file?.filename ?? "",
    status: file?.status ?? "",
  }));
  return {
    additions: intOf(stats.additions, 0),
    deletions: intOf(stats.deletions, 0),
    files,
  };
}
