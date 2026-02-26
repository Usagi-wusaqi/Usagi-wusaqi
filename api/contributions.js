// @ts-check
// Vercel Serverless Function: /api/contributions
// Usage: /api/contributions?username=xxx&hide_border=true&cache_seconds=86400

const GITHUB_API = "https://api.github.com";
const MAX_RETRIES = 10;
const RETRY_DELAY = 1000;
const BATCH_SIZE = 10;

// Vercel config: maxDuration = 60 (see vercel.json)

// ---- Validators ----

/** @param {string} hex */
const isValidHexColor = (hex) =>
  /^([A-Fa-f0-9]{3,4}|[A-Fa-f0-9]{6}|[A-Fa-f0-9]{8})$/.test(hex);

/**
 * @param {string} value
 * @param {string} fallback
 */
function sanitizeColor(value, fallback) {
  if (!value) return fallback;
  return isValidHexColor(value) ? `#${value}` : fallback;
}

// ---- GitHub API helpers ----

class RateLimitError extends Error {
  /**
   * @param {number} remaining
   * @param {number} resetAt
   */
  constructor(remaining, resetAt) {
    super(`GitHub API rate limit exceeded (remaining: ${remaining}, resets at ${new Date(resetAt * 1000).toISOString()})`);
    this.name = "RateLimitError";
  }
}

/** @param {Response} response */
function checkRateLimit(response) {
  if (response.status === 403 || response.status === 429) {
    const remaining = parseInt(response.headers.get("x-ratelimit-remaining") || "-1", 10);
    const reset = parseInt(response.headers.get("x-ratelimit-reset") || "0", 10);
    if (remaining === 0 || response.status === 429) {
      throw new RateLimitError(remaining, reset);
    }
  }
}

/**
 * @param {string} url
 * @param {string} [token]
 */
async function githubFetch(url, token) {
  /** @type {Record<string, string>} */
  const headers = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "github-readme-contributions",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const response = await fetch(url, { headers });
  checkRateLimit(response);
  return response;
}

/**
 * @param {string} username
 * @param {string} [token]
 */
async function fetchAllRepos(username, token) {
  const repos = [];
  let page = 1;

  while (true) {
    const response = await githubFetch(
      `${GITHUB_API}/users/${username}/repos?per_page=100&type=all&page=${page}`,
      token,
    );
    if (!response.ok) break;
    const data = await response.json();
    if (!Array.isArray(data) || data.length === 0) break;
    repos.push(...data);
    if (data.length < 100) break;
    page++;
  }

  return repos;
}

/**
 * @param {any} repo
 * @param {string} [token]
 * @returns {Promise<{owner: string, name: string}>}
 */
async function getUpstreamInfo(repo, token) {
  if (!repo.fork) return { owner: repo.owner.login, name: repo.name };

  const response = await githubFetch(
    `${GITHUB_API}/repos/${repo.full_name}`,
    token,
  );
  if (!response.ok) return { owner: repo.owner.login, name: repo.name };

  const detail = await response.json();
  const source = detail.source || detail.parent;
  return {
    owner: source?.owner?.login || repo.owner.login,
    name: source?.name || repo.name,
  };
}

/**
 * @param {string} username
 * @param {string} [token]
 */
async function fetchDisplayName(username, token) {
  const response = await githubFetch(
    `${GITHUB_API}/users/${username}`,
    token,
  );
  if (!response.ok) return username;
  const user = await response.json();
  return user.name || user.login;
}

/** @param {string} username */
async function fetchImageStats(username) {
  try {
    const url = `https://raw.githubusercontent.com/${username}/${username}/main/config.toml`;
    const response = await fetch(url);
    if (!response.ok) return null;
    const text = await response.text();
    const match = text.match(/^total_images\s*=\s*(\d+)/m);
    return match ? parseInt(match[1], 10) : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} owner
 * @param {string} repoName
 * @param {string} username
 * @param {string} [token]
 */
async function fetchContributions(owner, repoName, username, token) {
  const url = `${GITHUB_API}/repos/${owner}/${repoName}/stats/contributors`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await githubFetch(url, token);

    if (response.status === 202) {
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY));
        continue;
      }
      return { additions: 0, deletions: 0 };
    }

    if (response.status === 204 || !response.ok) {
      return { additions: 0, deletions: 0 };
    }

    const contributors = await response.json();
    if (!Array.isArray(contributors)) {
      return { additions: 0, deletions: 0 };
    }

    const user = contributors.find(
      (c) => c.author?.login?.toLowerCase() === username.toLowerCase(),
    );
    if (!user) return { additions: 0, deletions: 0 };

    const weeks = user.weeks || [];
    const additions = weeks.reduce((/** @type {number} */ sum, /** @type {any} */ w) => sum + (w.a || 0), 0);
    const deletions = weeks.reduce((/** @type {number} */ sum, /** @type {any} */ w) => sum + (w.d || 0), 0);
    return { additions, deletions };
  }

  return { additions: 0, deletions: 0 };
}

// ---- SVG rendering ----

/** @param {number} num */
function formatNumber(num) {
  return num.toLocaleString("en-US");
}

/** @param {string} str */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * @param {number} additions
 * @param {number} deletions
 * @param {string} displayName
 * @param {Record<string, any>} [options]
 */
function renderContributionsCard(
  additions,
  deletions,
  displayName,
  options = {},
) {
  const {
    custom_title,
    title_color = "#2f80ed",
    text_color = "#434d58",
    bg_color = "#fffefe",
    border_color = "#e4e2e2",
    hide_border = false,
    hide_title = false,
    total_images = null,
  } = options;

  const net = additions - deletions;
  const netSign = net >= 0 ? "+" : "";
  const addColor = "#28a745";
  const delColor = "#d73a49";
  const netColor = net >= 0 ? addColor : delColor;
  const imgColor = "#6f42c1";

  const defaultTitle = `${escapeHtml(displayName)}'${/s$/i.test(displayName.trim()) ? "" : "s"} Code Contributions`;
  const titleText = custom_title ? escapeHtml(custom_title) : defaultTitle;

  // 4-column layout: Additions, Deletions, Net, Images
  // ViewBox 1200×200 matches Activity Graph ratio (6:1) for equal rendered height
  // Labels ~20px referencing Activity Graph title size in same 1200-wide canvas
  const width = 1200;
  const height = 200;
  const padding = 67;

  // Even gap distribution: top → title → data block → bottom
  // Title 48px (visual ~34px), values 36px (visual ~25px), labels 20px (visual ~14px)
  // Data block: 14 + gap + 25 ≈ 47px
  // 3 gaps = (200 - 34 - 47) / 3 ≈ 40px
  const titleY = hide_title ? 0 : 70;
  const statsY = hide_title ? 80 : 120; // label baseline
  const valueGap = 36; // label → value baseline

  const borderAttr = hide_border
    ? ""
    : `stroke="${border_color}" stroke-width="1"`;

  const titleSvg = hide_title
    ? ""
    : `<text x="${padding}" y="${titleY}" class="header">${titleText}</text>`;

  // 4 equal zones: [padding → padding+col, ... , padding+3*col → width]
  // Col1 left edge aligns with title left edge
  const colWidth = Math.floor((width - padding) / 4);

  const imagesValue =
    total_images != null ? formatNumber(total_images) : "\u2014";

  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" role="img">
  <style>
    .header { font: 600 48px 'Segoe UI', Ubuntu, Sans-Serif; fill: ${title_color}; }
    @supports(-moz-appearance: auto) { .header { font-size: 41px; } }
    .stat { font: 600 20px 'Segoe UI', Ubuntu, "Helvetica Neue", Sans-Serif; fill: ${text_color}; }
    .bold { font: 700 36px 'Segoe UI', Ubuntu, "Helvetica Neue", Sans-Serif; }
  </style>
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="4.5" fill="${bg_color}" ${borderAttr}/>
  ${titleSvg}
  <g transform="translate(${padding}, ${statsY})">
    <text x="0" y="0" class="stat">Additions</text>
    <text x="0" y="${valueGap}" class="stat bold" style="fill:${addColor}">+${formatNumber(additions)}</text>
  </g>
  <g transform="translate(${padding + colWidth}, ${statsY})">
    <text x="0" y="0" class="stat">Deletions</text>
    <text x="0" y="${valueGap}" class="stat bold" style="fill:${delColor}">-${formatNumber(deletions)}</text>
  </g>
  <g transform="translate(${padding + colWidth * 2}, ${statsY})">
    <text x="0" y="0" class="stat">Net</text>
    <text x="0" y="${valueGap}" class="stat bold" style="fill:${netColor}">${netSign}${formatNumber(net)}</text>
  </g>
  <g transform="translate(${padding + colWidth * 3}, ${statsY})">
    <text x="0" y="0" class="stat">Images</text>
    <text x="0" y="${valueGap}" class="stat bold" style="fill:${imgColor}">${imagesValue}</text>
  </g>
</svg>`.trim();
}

/** @param {string} message */
function renderErrorCard(message) {
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100" viewBox="0 0 400 100">
  <style>
    .text { font: 600 14px 'Segoe UI', Ubuntu, sans-serif; fill: #d73a49; }
    .small { font: 400 12px 'Segoe UI', Ubuntu, sans-serif; fill: #666; }
  </style>
  <rect x="0.5" y="0.5" width="399" height="99" rx="4.5" fill="#fffefe" stroke="#e4e2e2"/>
  <text x="20" y="35" class="text">Something went wrong!</text>
  <text x="20" y="60" class="small">${escapeHtml(message)}</text>
</svg>`.trim();
}

// ---- Vercel Handler ----

// @ts-ignore
export default async (/** @type {any} */ req, /** @type {any} */ res) => {
  const {
    username,
    cache_seconds = "86400",
    exclude_repo,
    custom_title,
    title_color,
    text_color,
    bg_color,
    border_color,
    hide_border,
    hide_title,
  } = req.query;

  res.setHeader("Content-Type", "image/svg+xml");

  if (!username) {
    return res.send(renderErrorCard("Missing ?username= parameter"));
  }

  // @ts-ignore
  const token = process.env.PAT_1;

  try {
    const allRepos = await fetchAllRepos(username, token);

    const excludeSet = new Set(
      (exclude_repo || "")
        .split(",")
        .map((/** @type {string} */ s) => s.trim().toLowerCase())
        .filter(Boolean),
    );
    const repos = allRepos.filter(
      (r) => !excludeSet.has(r.name.toLowerCase()),
    );

    const resolvedRepos = [];
    for (let i = 0; i < repos.length; i += BATCH_SIZE) {
      const batch = repos.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(async (repo) => getUpstreamInfo(repo, token)),
      );
      resolvedRepos.push(...results);
    }

    let totalAdditions = 0;
    let totalDeletions = 0;

    for (let i = 0; i < resolvedRepos.length; i += BATCH_SIZE) {
      const batch = resolvedRepos.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map((r) =>
          fetchContributions(r.owner, r.name, username, token),
        ),
      );
      for (const { additions, deletions } of results) {
        totalAdditions += additions;
        totalDeletions += deletions;
      }
    }

    const [displayName, totalImages] = await Promise.all([
      fetchDisplayName(username, token),
      fetchImageStats(username),
    ]);

    const svg = renderContributionsCard(
      totalAdditions,
      totalDeletions,
      displayName,
      {
        custom_title,
        title_color: sanitizeColor(title_color, "#2f80ed"),
        text_color: sanitizeColor(text_color, "#434d58"),
        bg_color: sanitizeColor(bg_color, "#fffefe"),
        border_color: sanitizeColor(border_color, "#e4e2e2"),
        hide_border: hide_border === "true",
        hide_title: hide_title === "true",
        total_images: totalImages,
      },
    );

    const cacheMax = Math.max(parseInt(cache_seconds, 10) || 86400, 60);
    res.setHeader(
      "Cache-Control",
      `max-age=${Math.floor(cacheMax / 2)}, s-maxage=${cacheMax}, stale-while-revalidate=86400`,
    );

    return res.send(svg);
  } catch (err) {
    console.error("contributions error:", err);
    if (err instanceof RateLimitError) {
      // Rate limited: short cache to avoid hammering, but retry soon
      res.setHeader("Cache-Control", "max-age=300, s-maxage=600, stale-while-revalidate=3600");
      return res.send(renderErrorCard("GitHub API rate limit exceeded. Try again later."));
    }
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    return res.send(renderErrorCard("Failed to fetch contribution data"));
  }
};
