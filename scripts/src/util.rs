//! 通用工具：终端颜色、日志缓冲、命令执行、数字/转义/编码、ISO 时间戳

use std::path::Path;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

// ============================================================================
// 终端颜色
// ============================================================================

pub const RED: &str = "\x1b[0;31m";
pub const GREEN: &str = "\x1b[0;32m";
pub const YELLOW: &str = "\x1b[1;33m";
pub const NC: &str = "\x1b[0m";

pub fn print_color(message: &str, color: &str) {
    println!("{color}{message}{NC}");
}

pub fn print_separator(title: Option<&str>, color: &str, length: usize) {
    let separator = "=".repeat(length);
    print_color(&separator, color);
    if let Some(text) = title {
        print_color(text, color);
        print_color(&separator, color);
    }
}

/// 仓库级日志缓冲：先在内存中累积，完成后整块输出，避免并发交错
#[derive(Default)]
pub struct Log {
    buf: String,
}

impl Log {
    pub fn color(&mut self, message: &str, color: &str) {
        self.buf.push_str(color);
        self.buf.push_str(message);
        self.buf.push_str(NC);
        self.buf.push('\n');
    }

    pub fn separator(&mut self, title: &str, color: &str, length: usize) {
        let separator = "=".repeat(length);
        self.color(&separator, color);
        self.color(title, color);
        self.color(&separator, color);
    }

    pub fn flush(&self) {
        print!("{}", self.buf);
    }
}

// ============================================================================
// 命令执行
// ============================================================================

/// 运行命令并返回 (stdout.strip(), 退出码)
pub fn run_command(cmd: &str, args: &[&str], cwd: Option<&Path>) -> (String, i32) {
    let mut command = Command::new(cmd);
    command.args(args);
    if let Some(dir) = cwd {
        command.current_dir(dir);
    }

    match command.output() {
        Ok(output) => {
            let code = output.status.code().unwrap_or(1);
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            (stdout, code)
        }
        Err(err) => {
            print_color(&format!("❌ 命令执行失败: {err}"), RED);
            (String::new(), 1)
        }
    }
}

// ============================================================================
// 文本处理
// ============================================================================

/// 读取文本文件（模拟 Python 的 universal newlines，统一为 `\n`）
pub fn read_text_normalized(path: &Path) -> std::io::Result<String> {
    let content = std::fs::read_to_string(path)?;
    Ok(normalize_newlines(&content))
}

fn normalize_newlines(content: &str) -> String {
    if content.contains('\r') {
        content.replace("\r\n", "\n").replace('\r', "\n")
    } else {
        content.to_string()
    }
}

/// 千分位格式化数字（对应 Python 的 `f"{num:,}"`）
pub fn format_number(num: i64) -> String {
    let negative = num < 0;
    let digits = num.unsigned_abs().to_string();
    let bytes = digits.as_bytes();

    let mut out = String::with_capacity(digits.len() + digits.len() / 3 + 1);
    for (idx, byte) in bytes.iter().enumerate() {
        if idx > 0 && (bytes.len() - idx).is_multiple_of(3) {
            out.push(',');
        }
        out.push(*byte as char);
    }

    if negative {
        format!("-{out}")
    } else {
        out
    }
}

/// HTML 转义
pub fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// 等价于 Python 的 `urllib.parse.quote(text)`（safe='/'）
pub fn url_quote(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        let ch = byte as char;
        if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '-' | '~' | '/') {
            out.push(ch);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

// ============================================================================
// Base64（标准字母表，带填充）
// ============================================================================

const B64_ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn base64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;

        out.push(B64_ALPHABET[(triple >> 18) as usize & 0x3f] as char);
        out.push(B64_ALPHABET[(triple >> 12) as usize & 0x3f] as char);
        if chunk.len() > 1 {
            out.push(B64_ALPHABET[(triple >> 6) as usize & 0x3f] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(B64_ALPHABET[triple as usize & 0x3f] as char);
        } else {
            out.push('=');
        }
    }
    out
}

pub fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let mut acc: u32 = 0;
    let mut bits = 0u32;

    for byte in text.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => break,
            b' ' | b'\n' | b'\r' | b'\t' => continue,
            _ => return None,
        } as u32;

        acc = (acc << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }

    Some(out)
}

// ============================================================================
// ISO 8601 时间戳
// ============================================================================

/// 解析为 Unix 纳秒；解析失败返回 i64::MIN（排序时等价于 Python 的 datetime.min）
pub fn parse_iso_timestamp(text: &str) -> i64 {
    parse_iso_nanos(text).unwrap_or(i64::MIN)
}

fn parse_iso_nanos(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    if bytes.len() < 19 {
        return None;
    }
    if bytes[4] != b'-' || bytes[7] != b'-' || (bytes[10] != b'T' && bytes[10] != b' ') {
        return None;
    }
    if bytes[13] != b':' || bytes[16] != b':' {
        return None;
    }

    let year: i64 = text.get(0..4)?.parse().ok()?;
    let month: i64 = text.get(5..7)?.parse().ok()?;
    let day: i64 = text.get(8..10)?.parse().ok()?;
    let hour: i64 = text.get(11..13)?.parse().ok()?;
    let minute: i64 = text.get(14..16)?.parse().ok()?;
    let second: i64 = text.get(17..19)?.parse().ok()?;

    let mut rest = &text[19..];
    let mut nanos = 0i64;
    if rest.starts_with('.') {
        rest = &rest[1..];
        let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
        rest = &rest[digits.len()..];

        let mut fraction = digits;
        while fraction.len() < 9 {
            fraction.push('0');
        }
        fraction.truncate(9);
        nanos = fraction.parse().ok()?;
    }

    let offset_seconds = if rest.is_empty() || rest == "Z" {
        0
    } else {
        let sign: i64 = match rest.as_bytes().first().copied()? {
            b'+' => 1,
            b'-' => -1,
            _ => return None,
        };
        let offset_hour: i64 = rest.get(1..3)?.parse().ok()?;
        let offset_minute: i64 = if rest.len() >= 6 && rest.as_bytes()[3] == b':' {
            rest.get(4..6)?.parse().ok()?
        } else if rest.len() >= 5 {
            rest.get(3..5)?.parse().ok()?
        } else {
            0
        };
        sign * (offset_hour * 3600 + offset_minute * 60)
    };

    let days = days_from_civil(year, month, day);
    let seconds = days * 86400 + hour * 3600 + minute * 60 + second - offset_seconds;
    Some(seconds * 1_000_000_000 + nanos)
}

/// 当前 UTC 时间，格式等价于 Python 的 `datetime.now(tz=UTC).isoformat()`
pub fn now_iso_utc() -> String {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let seconds = duration.as_secs() as i64;
    let nanos = duration.subsec_nanos();

    let days = seconds.div_euclid(86400);
    let rem = seconds.rem_euclid(86400);
    let (year, month, day) = civil_from_days(days);
    let (hour, minute, second) = (rem / 3600, (rem % 3600) / 60, rem % 60);

    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{nanos:06}+00:00")
}

/// Howard Hinnant 的 civil_from_days / days_from_civil 算法
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_shift = if month > 2 { month - 3 } else { month + 9 };
    let day_of_year = (153 * month_shift + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146097 + day_of_era - 719468
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let shifted = days + 719468;
    let era = if shifted >= 0 {
        shifted
    } else {
        shifted - 146096
    } / 146097;
    let day_of_era = shifted - era * 146097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36524 - day_of_era / 146096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = if month_prime < 10 {
        month_prime + 3
    } else {
        month_prime - 9
    };
    let year = if month <= 2 { year + 1 } else { year };
    (year, month, day)
}
