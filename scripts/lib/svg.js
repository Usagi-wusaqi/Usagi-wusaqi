/**
 * 贡献卡片 SVG 的生成与保存。
 */

import fs from "node:fs";

import { GREEN, RED, escapeHtml, formatNumber, intOf, printColor, shortPath } from "./format.js";

export function generateContributionsSvg(app, stats, displayName) {
  const svg = app.svg;
  const layout = svg.layout;
  const font = svg.font;
  const labels = svg.labels;

  const additions = stats.total_additions;
  const deletions = stats.total_deletions;
  const images = stats.total_images;
  const net = additions - deletions;
  const netSign = net >= 0 ? "+" : "";
  const netColor = net >= 0 ? svg.add_color : svg.del_color;

  const customTitle = svg.custom_title;
  let titleText;
  if (customTitle !== null && customTitle !== undefined) {
    titleText = escapeHtml(customTitle);
  } else {
    const escaped = escapeHtml(displayName);
    const suffix = escaped.trimEnd().endsWith("s") ? "" : "s";
    titleText = `${escaped}&apos;${suffix} Code Contributions`;
  }

  const width = intOf(svg.width, 1200);
  const height = intOf(svg.height, 200);
  const rectWidth = width - 1;
  const rectHeight = height - 1;
  const padding = layout.padding;
  const titleY = layout.title_y;
  const statsY = layout.stats_y;
  const valueGap = layout.value_gap;
  const borderRadius = layout.border_radius;
  const colWidth = Math.floor((width - padding) / 4);
  const col1 = padding + colWidth;
  const col2 = padding + colWidth * 2;
  const col3 = padding + colWidth * 3;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}" fill="none" role="img">\n` +
    "  <style>\n" +
    `    .header { font: ${font.header_size} ${font.family}; fill: ${svg.title_color}; }\n` +
    "    @supports(-moz-appearance: auto) { " +
    `.header { font-size: ${font.header_size_firefox}; } }\n` +
    `    .stat { font: ${font.stat_size} ${font.family_extended}; fill: ${svg.text_color}; }\n` +
    `    .bold { font: ${font.bold_size} ${font.family_extended}; }\n` +
    "  </style>\n" +
    `  <rect x="0.5" y="0.5" width="${rectWidth}" height="${rectHeight}" rx="${borderRadius}" ` +
    `fill="${svg.bg_color}" stroke="${svg.border_color}" stroke-width="1"/>\n` +
    `  <text x="${padding}" y="${titleY}" class="header">${titleText}</text>\n` +
    `  <g transform="translate(${padding}, ${statsY})">\n` +
    `    <text x="0" y="0" class="stat">${labels.additions}</text>\n` +
    `    <text x="0" y="${valueGap}" class="stat bold" style="fill:${svg.add_color}">` +
    `+${formatNumber(additions)}</text>\n` +
    "  </g>\n" +
    `  <g transform="translate(${col1}, ${statsY})">\n` +
    `    <text x="0" y="0" class="stat">${labels.deletions}</text>\n` +
    `    <text x="0" y="${valueGap}" class="stat bold" style="fill:${svg.del_color}">` +
    `-${formatNumber(deletions)}</text>\n` +
    "  </g>\n" +
    `  <g transform="translate(${col2}, ${statsY})">\n` +
    `    <text x="0" y="0" class="stat">${labels.net}</text>\n` +
    `    <text x="0" y="${valueGap}" class="stat bold" style="fill:${netColor}">` +
    `${netSign}${formatNumber(net)}</text>\n` +
    "  </g>\n" +
    `  <g transform="translate(${col3}, ${statsY})">\n` +
    `    <text x="0" y="0" class="stat">${labels.images}</text>\n` +
    `    <text x="0" y="${valueGap}" class="stat bold" style="fill:${svg.img_color}">` +
    `${formatNumber(images)}</text>\n` +
    "  </g>\n" +
    "</svg>"
  );
}

export function saveContributionsSvg(app, content) {
  try {
    fs.writeFileSync(app.svgPath, `${content}\n`, { encoding: "utf8" });
  } catch (exc) {
    printColor(`❌ 保存 SVG 失败: ${exc.message}`, RED);
    return false;
  }
  printColor(`✅ SVG 卡片已生成: ${shortPath(app.svgPath)}`, GREEN);
  return true;
}
