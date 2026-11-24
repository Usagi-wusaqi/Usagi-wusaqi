/**
 * 仓库标识的纯函数：全名归一、去重键、fork 上游推断。不发起任何请求。
 */

export function repoOwnerFromUrl(repoUrl) {
  const scheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]+\/([^/]+)\//.exec(repoUrl);
  if (scheme) {
    return scheme[1];
  }
  const bare = /^([^/:]+)\//.exec(repoUrl);
  return bare ? bare[1] : null;
}

export function upstreamOf(repo) {
  for (const key of ["source", "parent"]) {
    const value = repo?.[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value;
    }
  }
  return null;
}

/**
 * 把 `owner/name`、完整地址或带 .git 的地址统一成 `owner/name`；不合法返回空串。
 */
export function normalizeFullName(value) {
  const text = String(value ?? "")
    .trim()
    .replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "");
  const match = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(text);
  return match ? `${match[1]}/${match[2]}` : "";
}

/** 仓库在整轮统计里的唯一标识，用于去重与排除；大小写不敏感。 */
export function repoKeyOf(repo) {
  const full = normalizeFullName(repo?.full_name);
  if (full) {
    return full.toLowerCase();
  }
  const owner = repoOwnerFromUrl(String(repo?.html_url ?? ""));
  const name = String(repo?.name ?? "").trim();
  return owner && name ? `${owner}/${name}`.toLowerCase() : "";
}

/**
 * 由 `owner/name` 造一份最小仓库记录；fork 关系未知，留待解析上游时查详情。
 */
export function repoFromFullName(full, id = undefined) {
  const normalized = normalizeFullName(full);
  if (!normalized) {
    return null;
  }
  const [owner, name] = normalized.split("/");
  const repo = {
    name,
    full_name: `${owner}/${name}`,
    html_url: `https://github.com/${owner}/${name}`,
  };
  if (id !== undefined && id !== null) {
    repo.id = id;
  }
  return repo;
}
