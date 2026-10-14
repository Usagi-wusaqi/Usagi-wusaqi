//! README 与 SVG 产物生成

use std::fs;

use crate::cache::Stats;
use crate::config::App;
use crate::util::{
    escape_html, format_number, print_color, read_text_normalized, url_quote, GREEN, NC, RED,
    YELLOW,
};

// ============================================================================
// README
// ============================================================================

/// 通用占位符替换：`{{NAME}}` → value
fn replace_placeholders(content: &str, replacements: &[(&str, &str)]) -> String {
    let mut result = content.to_string();
    for (placeholder, value) in replacements {
        let token = ["{{", placeholder, "}}"].concat();
        result = result.replace(&token, value);
    }
    result
}

/// 原地替换 `VAR = 值` 定义中的值（对应 Python 的 `re.sub(r"({var} = )([^\n\r]+)")`）
fn update_variable_definition(content: &str, var_name: &str, var_value: &str) -> String {
    let marker = format!("{var_name} = ");
    let mut found = false;

    let lines: Vec<String> = content
        .split('\n')
        .map(|line| match line.find(&marker) {
            Some(position) => {
                found = true;
                format!("{}{marker}{var_value}", &line[..position])
            }
            None => line.to_string(),
        })
        .collect();

    if found {
        print_color(&format!("✅ 已更新 {var_name} 定义为: {var_value}"), GREEN);
    }

    lines.join("\n")
}

/// 更新 README 中的用户名（双向替换，支持重复运行）
fn update_usernames_in_readme(
    content: &str,
    origin_username: &str,
    upstream_username: &str,
) -> String {
    let content = update_variable_definition(content, "ORIGIN_USERNAME", origin_username);
    let content = update_variable_definition(&content, "UPSTREAM_USERNAME", upstream_username);

    let placeholder_count = content.matches("{{ORIGIN_USERNAME}}").count()
        + content.matches("{{UPSTREAM_USERNAME}}").count();

    if placeholder_count == 0 {
        print_color("ℹ️  未发现占位符，内容已包含真实用户名", YELLOW);
        return content;
    }

    let replaced = replace_placeholders(
        &content,
        &[
            ("ORIGIN_USERNAME", origin_username),
            ("UPSTREAM_USERNAME", upstream_username),
        ],
    );
    print_color(
        &format!("✅ 已替换 {placeholder_count} 个占位符为真实用户名"),
        GREEN,
    );
    replaced
}

/// 从模板生成 README 内容
fn generate_readme_from_template(app: &App, mode: &str) -> String {
    let content = read_text_normalized(&app.template_path).unwrap_or_default();

    // 根据模式选择贡献卡片来源
    let card_src = if mode == "actions" {
        "contributions.svg".to_string()
    } else {
        let vercel = &app.config.vercel;
        let title_param = match app.config.svg.custom_title.as_deref() {
            Some(title) => format!("&custom_title={}", url_quote(title)),
            None => String::new(),
        };
        let hide_param = if vercel.hide_border {
            "&hide_border=true"
        } else {
            ""
        };
        format!(
            "{}/api/contributions?username={}{hide_param}{title_param}&cache_seconds={}",
            vercel.base_url, app.origin_username, vercel.cache_seconds
        )
    };

    let content = replace_placeholders(
        &content,
        &[
            ("ORIGIN_USERNAME", app.origin_username.as_str()),
            ("UPSTREAM_USERNAME", app.upstream_username.as_str()),
            ("CONTRIBUTIONS_CARD_SRC", card_src.as_str()),
        ],
    );
    print_color("✅ 已从模板生成完整的 README", GREEN);

    content
}

fn save_readme_content(app: &App, content: &str) -> bool {
    match fs::write(&app.readme_path, content) {
        Ok(()) => true,
        Err(err) => {
            print_color(&format!("❌ 保存 README 失败: {err}"), RED);
            false
        }
    }
}

fn print_update_summary(app: &App, stats: &Stats) {
    let net = stats.total_additions - stats.total_deletions;
    let net_sign = if net >= 0 { "+" } else { "" };
    print_color("✅ README.md 更新成功！", GREEN);
    print_color(
        &format!(
            "   ✍️  +{} / -{} (net {net_sign}{})",
            format_number(stats.total_additions),
            format_number(stats.total_deletions),
            format_number(net)
        ),
        NC,
    );
    print_color(
        &format!("   🖼️  图片数量: {}", format_number(stats.total_images)),
        NC,
    );
    print_color(
        &format!("   🕒 最新 commit: {}", stats.latest_commit_timestamp),
        NC,
    );
    print_color(&format!("   👤 远端用户名: {}", app.origin_username), NC);
    print_color(&format!("   👑 上游用户名: {}", app.upstream_username), NC);
}

/// 更新 README.md（模板优先，回退为仅更新用户名）；变更检测由调用方完成
pub fn update_readme(app: &App, stats: &Stats, mode: &str) -> bool {
    print_color("📝 更新 README.md...", YELLOW);

    let content = if app.template_path.exists() {
        print_color("📄 使用模板系统生成 README", GREEN);
        generate_readme_from_template(app, mode)
    } else {
        print_color("⚠️  未发现模板文件，更新现有 README", YELLOW);

        if !app.readme_path.exists() {
            print_color("❌ README.md 不存在！", RED);
            return false;
        }

        let existing = read_text_normalized(&app.readme_path).unwrap_or_default();
        update_usernames_in_readme(
            &existing,
            app.origin_username.as_str(),
            app.upstream_username.as_str(),
        )
    };

    if !save_readme_content(app, &content) {
        return false;
    }

    print_update_summary(app, stats);
    true
}

// ============================================================================
// SVG 卡片（Actions 模式）
// ============================================================================

/// 生成贡献统计 SVG 卡片（与 Vercel 版本 renderContributionsCard 对齐）
pub fn generate_contributions_svg(app: &App, stats: &Stats, display_name: &str) -> String {
    let svg = &app.config.svg;
    let layout = &svg.layout;
    let font = &svg.font;
    let labels = &svg.labels;

    let additions = stats.total_additions;
    let deletions = stats.total_deletions;
    let images = stats.total_images;
    let net = additions - deletions;
    let net_sign = if net >= 0 { "+" } else { "" };

    let net_color = if net >= 0 {
        svg.add_color.as_str()
    } else {
        svg.del_color.as_str()
    };

    let title_text = match svg.custom_title.as_deref() {
        Some(title) => escape_html(title),
        None => {
            let escaped = escape_html(display_name);
            let suffix = if escaped.trim_end().ends_with('s') {
                ""
            } else {
                "s"
            };
            format!("{escaped}&apos;{suffix} Code Contributions")
        }
    };

    let width = svg.width;
    let height = svg.height;
    let rect_width = width - 1;
    let rect_height = height - 1;
    let padding = layout.padding;
    let title_y = layout.title_y;
    let stats_y = layout.stats_y;
    let value_gap = layout.value_gap;
    let border_radius = layout.border_radius;
    let col_width = (width - padding) / 4;
    let col1 = padding + col_width;
    let col2 = padding + col_width * 2;
    let col3 = padding + col_width * 3;

    let font_family = font.family.as_str();
    let font_family_ext = font.family_extended.as_str();
    let header_size = font.header_size.as_str();
    let header_size_ff = font.header_size_firefox.as_str();
    let stat_size = font.stat_size.as_str();
    let bold_size = font.bold_size.as_str();

    let title_color = svg.title_color.as_str();
    let text_color = svg.text_color.as_str();
    let bg_color = svg.bg_color.as_str();
    let border_color = svg.border_color.as_str();
    let add_color = svg.add_color.as_str();
    let del_color = svg.del_color.as_str();
    let img_color = svg.img_color.as_str();

    let lbl_add = labels.additions.as_str();
    let lbl_del = labels.deletions.as_str();
    let lbl_net = labels.net.as_str();
    let lbl_img = labels.images.as_str();

    let additions_text = format_number(additions);
    let deletions_text = format_number(deletions);
    let net_text = format_number(net);
    let images_text = format_number(images);

    format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{width}\" height=\"{height}\" viewBox=\"0 0 {width} {height}\" fill=\"none\" role=\"img\">\n  <style>\n    .header {{ font: {header_size} {font_family}; fill: {title_color}; }}\n    @supports(-moz-appearance: auto) {{ .header {{ font-size: {header_size_ff}; }} }}\n    .stat {{ font: {stat_size} {font_family_ext}; fill: {text_color}; }}\n    .bold {{ font: {bold_size} {font_family_ext}; }}\n  </style>\n  <rect x=\"0.5\" y=\"0.5\" width=\"{rect_width}\" height=\"{rect_height}\" rx=\"{border_radius}\" fill=\"{bg_color}\" stroke=\"{border_color}\" stroke-width=\"1\"/>\n  <text x=\"{padding}\" y=\"{title_y}\" class=\"header\">{title_text}</text>\n  <g transform=\"translate({padding}, {stats_y})\">\n    <text x=\"0\" y=\"0\" class=\"stat\">{lbl_add}</text>\n    <text x=\"0\" y=\"{value_gap}\" class=\"stat bold\" style=\"fill:{add_color}\">+{additions_text}</text>\n  </g>\n  <g transform=\"translate({col1}, {stats_y})\">\n    <text x=\"0\" y=\"0\" class=\"stat\">{lbl_del}</text>\n    <text x=\"0\" y=\"{value_gap}\" class=\"stat bold\" style=\"fill:{del_color}\">-{deletions_text}</text>\n  </g>\n  <g transform=\"translate({col2}, {stats_y})\">\n    <text x=\"0\" y=\"0\" class=\"stat\">{lbl_net}</text>\n    <text x=\"0\" y=\"{value_gap}\" class=\"stat bold\" style=\"fill:{net_color}\">{net_sign}{net_text}</text>\n  </g>\n  <g transform=\"translate({col3}, {stats_y})\">\n    <text x=\"0\" y=\"0\" class=\"stat\">{lbl_img}</text>\n    <text x=\"0\" y=\"{value_gap}\" class=\"stat bold\" style=\"fill:{img_color}\">{images_text}</text>\n  </g>\n</svg>"
    )
}

/// 保存 SVG 卡片（内容后补一个换行，与原脚本一致）
pub fn save_contributions_svg(app: &App, svg_content: &str) -> bool {
    let content = format!("{svg_content}\n");
    match fs::write(&app.svg_path, content) {
        Ok(()) => {
            print_color(
                &format!("✅ SVG 卡片已生成: {}", app.svg_path.display()),
                GREEN,
            );
            true
        }
        Err(err) => {
            print_color(&format!("❌ 保存 SVG 失败: {err}"), RED);
            false
        }
    }
}
