// @ts-check
// Vercel Serverless Function: /api/contributions
// Usage: /api/contributions?username=xxx&hide_border=true&cache_seconds=86400

const GITHUB_API = "https://api.github.com";
const MAX_RETRIES = 1;
const RETRY_DELAY = 1000;
const BATCH_SIZE = 10;

// Vercel config: maxDuration = 60 (see vercel.json)

// ---- Validators ----

const isValidHexColor = (hex) =>
  /^([A-Fa-f0-9]{3,4}|[A-Fa-f0-9]{6}|[A-Fa-f0-9]{8})$/.test(hex);

function sanitizeColor(value, fallback) {
  if (!value) return fallback;
  return isValidHexColor(value) ? `#${value}` : fallback;
}

// ---- GitHub API helpers ----

async function githubFetch(url, token) {
  const headers = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "github-readme-contributions",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return fetch(url, { headers });
}

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

async function getUpstreamOwner(repo, token) {
  if (!repo.fork) return repo.owner.login;

  const response = await githubFetch(
    `${GITHUB_API}/repos/${repo.full_name}`,
    token,
  );
  if (!response.ok) return repo.owner.login;

  const detail = await response.json();
  return (
    detail.source?.owner?.login ||
    detail.parent?.owner?.login ||
    repo.owner.login
  );
}

async function fetchDisplayName(username, token) {
  const response = await githubFetch(
    `${GITHUB_API}/users/${username}`,
    token,
  );
  if (!response.ok) return username;
  const user = await response.json();
  return user.name || user.login;
}

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

    const additions = user.weeks.reduce((sum, w) => sum + (w.a || 0), 0);
    const deletions = user.weeks.reduce((sum, w) => sum + (w.d || 0), 0);
    return { additions, deletions };
  }

  return { additions: 0, deletions: 0 };
}

// ---- SVG rendering ----

function formatNumber(num) {
  return num.toLocaleString("en-US");
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

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
  } = options;

  const net = additions - deletions;
  const netSign = net >= 0 ? "+" : "";
  const addColor = "#28a745";
  const delColor = "#d73a49";
  const netColor = net >= 0 ? addColor : delColor;

  const defaultTitle = `${escapeHtml(displayName)}'${/s$/i.test(displayName.trim()) ? "" : "s"} Code Contributions`;
  const titleText = custom_title ? escapeHtml(custom_title) : defaultTitle;

  // Match github-readme-stats card spacing
  const width = 467;
  const titleY = 35;          // same as Stats card title position
  const bodyY = 55;           // same as Stats card body start
  const statsRowHeight = 28;
  const bottomPadding = 12;
  const contentStartY = hide_title ? titleY : bodyY;
  const height = contentStartY + statsRowHeight + bottomPadding;

  const borderAttr = hide_border
    ? ""
    : `stroke="${border_color}" stroke-width="1"`;

  const titleSvg = hide_title
    ? ""
    : `<text x="25" y="${titleY}" class="header">${titleText}</text>`;

  const statsY = contentStartY + 12;
  const colWidth = Math.floor((width - 50) / 3);

  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" role="img">
  <style>
    .header { font: 600 18px 'Segoe UI', Ubuntu, Sans-Serif; fill: ${title_color}; }
    @supports(-moz-appearance: auto) { .header { font-size: 15.5px; } }
    .label { font: 400 12px 'Segoe UI', Ubuntu, Sans-Serif; fill: ${text_color}; }
    .value { font: 700 16px 'Segoe UI', Ubuntu, Sans-Serif; }
  </style>
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="4.5" fill="${bg_color}" ${borderAttr}/>
  ${titleSvg}
  <g transform="translate(25, ${statsY})">
    <text x="0" y="0" class="label">Additions</text>
    <text x="0" y="18" class="value" fill="${addColor}">+${formatNumber(additions)}</text>
  </g>
  <g transform="translate(${25 + colWidth}, ${statsY})">
    <text x="0" y="0" class="label">Deletions</text>
    <text x="0" y="18" class="value" fill="${delColor}">-${formatNumber(deletions)}</text>
  </g>
  <g transform="translate(${25 + colWidth * 2}, ${statsY})">
    <text x="0" y="0" class="label">Net</text>
    <text x="0" y="18" class="value" fill="${netColor}">${netSign}${formatNumber(net)}</text>
  </g>
</svg>`.trim();
}

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
export default async (req, res) => {
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

  const token = process.env.PAT_1;

  try {
    const allRepos = await fetchAllRepos(username, token);

    const excludeSet = new Set(
      (exclude_repo || "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    );
    const repos = allRepos.filter(
      (r) => !excludeSet.has(r.name.toLowerCase()),
    );

    const resolvedRepos = await Promise.all(
      repos.map(async (repo) => ({
        owner: await getUpstreamOwner(repo, token),
        name: repo.name,
      })),
    );

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

    const displayName = await fetchDisplayName(username, token);

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
      },
    );

    const cacheMax = Math.max(parseInt(cache_seconds, 10) || 86400, 7200);
    res.setHeader(
      "Cache-Control",
      `max-age=${Math.floor(cacheMax / 2)}, s-maxage=${cacheMax}, stale-while-revalidate=86400`,
    );

    return res.send(svg);
  } catch (err) {
    console.error("contributions error:", err);
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    return res.send(renderErrorCard("Failed to fetch contribution data"));
  }
};
