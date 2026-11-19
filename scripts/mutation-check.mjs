/**
 * 变异测试：去掉 observer 的「忽略自己」守卫后，用例必须失败。
 * 用法：node scripts/mutation-check.mjs
 *
 * 它会临时改 lib/client.js、跑一次测试、再恢复原文件。原文件先备份到 lib/client.js.bak。
 */
import { copyFileSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";

const file = "lib/client.js";
const backup = "lib/client.js.bak";
const GUARD = "if (allOwnNodes(added) && allOwnNodes(removed)) continue;";

copyFileSync(file, backup);
let failed = false;
try {
  const source = readFileSync(file, "utf8");
  if (!source.includes(GUARD)) throw new Error("守卫不见了，先看代码是不是改过");
  writeFileSync(file, source.replace(GUARD, "/* mutation test: guard removed */"), "utf8");
  try {
    execFileSync("node", ["--test", "test/client.test.js"], { stdio: "pipe" });
    console.log("FAIL: 去掉守卫后测试仍然通过 —— 那条用例没有真正覆盖「忽略自己」");
  } catch (error) {
    failed = true;
    const output = String(error.stdout === undefined ? "" : error.stdout) + String(error.stderr === undefined ? "" : error.stderr);
    const hit = output.includes("observer 不因自己插的节点而再次调度");
    console.log(hit
      ? "PASS: 去掉守卫后，恰好是「忽略自己」那条用例失败"
      : "PASS（但失败的不是预期那条，请检查）:\n" + output.split("\n").slice(-12).join("\n"));
  }
} finally {
  copyFileSync(backup, file);
  unlinkSync(backup);
}
if (!failed) process.exitCode = 1;
