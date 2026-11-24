/**
 * 对 scripts/ 下的所有脚本做语法检查。
 *
 * 本项目零依赖，用 Node 自带的 `--check` 即可；遍历放在脚本里而不是 package.json
 * 的 shell 循环，是为了让 Windows 的 cmd 与 CI 的 bash 行为一致。
 */

import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const libDir = path.join(here, "lib");

const files = [
  ...readdirSync(here)
    .filter((name) => name.endsWith(".js"))
    .map((name) => path.join(here, name)),
  ...readdirSync(libDir)
    .filter((name) => name.endsWith(".js"))
    .map((name) => path.join(libDir, name)),
];

for (const file of files) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (exc) {
    process.stderr.write(exc.stderr ?? "");
    console.error(`❌ 语法检查未通过: ${path.relative(here, file)}`);
    process.exit(1);
  }
}

console.log(`✅ 语法检查通过: ${files.length} 个文件`);
