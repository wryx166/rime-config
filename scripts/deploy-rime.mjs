#!/usr/bin/env node

/**
 * deploy-rime.mjs
 *
 * 将此仓库的 Rime 配置覆写到用户 Rime 配置目录。
 *
 * 用法:
 *   node scripts/deploy-rime.mjs
 *   node scripts/deploy-rime.mjs --deploy           # 覆写后自动重新部署
 *   node scripts/deploy-rime.mjs --dry-run          # 预览模式，不实际写入
 *   node scripts/deploy-rime.mjs --pull-words       # 部署前将用户词表反拷回仓库（便于 git 版本化）
 *   node scripts/deploy-rime.mjs --target /path     # 指定目标目录
 *
 * 默认目标:
 *   Windows: C:\Users\<USER>\AppData\Roaming\Rime
 *   其他:     ~/.local/share/fcitx5/rime 或 ~/.config/ibus/rime (自动检测)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { spawnSync } from "node:child_process";

/* ── 路径 ─────────────────────────────────── */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

/** 尝试检测 Rime 用户数据目录 */
function detectRimeDir() {
  if (process.platform === "win32") {
    // Windows: %APPDATA%\Rime
    const appData = process.env.APPDATA;
    if (appData) {
      const dir = path.join(appData, "Rime");
      if (fs.existsSync(dir)) return dir;
    }
    // 备选：USERPROFILE
    const profile = process.env.USERPROFILE;
    if (profile) {
      const dir = path.join(profile, "AppData", "Roaming", "Rime");
      if (fs.existsSync(dir)) return dir;
    }
  }

  // Linux / macOS
  const home = os.homedir();
  const candidates = [
    path.join(home, ".local", "share", "fcitx5", "rime"),
    path.join(home, ".config", "ibus", "rime"),
    path.join(home, ".config", "rime"),
    path.join(home, "Library", "Rime"), // macOS 松鼠输入法
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }

  return null;
}

/** 尝试检测 WeaselDeployer 路径（仅 Windows） */
function detectWeaselDeployer() {
  const programDirs = [
    process.env["ProgramFiles"],
    process.env["ProgramFiles(x86)"],
    "C:\\Program Files\\Rime",
    "C:\\Program Files (x86)\\Rime",
  ].filter(Boolean);
  for (const base of programDirs) {
    if (!fs.existsSync(base)) continue;
    for (const entry of fs.readdirSync(base)) {
      const exe = path.join(base, entry, "WeaselDeployer.exe");
      if (fs.existsSync(exe)) return exe;
    }
  }
  return null;
}

/* ── 保护文件 ─────────────────────────────── */

/**
 * 目标端已存在时跳过（保留用户本地数据/自动生成的文件）。
 * .git：目标目录可能自己就是个仓库（如 %APPDATA%\Rime）。清理阶段若递归进去，
 * 会把源仓库没有的对象/ref 当作"源已删除"删掉，损坏那个仓库。拷贝阶段本来就
 * 排除它（见 main 中收集根目录条目的地方），这里补上让两边一致。
 */
const PROTECTED = new Set(["installation.yaml", "user.yaml", "build", ".git"]);

/** 判断条目是否受保护（精确匹配或通配模式） */
function isProtected(entry) {
  if (PROTECTED.has(entry)) return true;
  if (entry.endsWith(".userdb")) return true;
  if (entry.endsWith(".gram")) return true;
  return false;
}

/**
 * 用户词表文件：输入法运行时（Ctrl+D 删词 / Ctrl+X 隐藏 / Ctrl+J 降频）
 * 会把积累的词条写回 lua/cold_word_drop/*.lua（见 processor.lua 的 write_word_to_file）。
 * 目标端已有的这些文件代表用户数据，部署时既不覆盖也不清理，防止数据丢失。
 */
const WORD_FILES = new Set([
  "lua/cold_word_drop/drop_words.lua",
  "lua/cold_word_drop/hide_words.lua",
  "lua/cold_word_drop/reduce_freq_words.lua",
  "lua/cold_word_drop/turn_down_words.lua",
]);

/** 判断相对路径是否属于用户词表文件 */
function isWordFile(relPath) {
  return WORD_FILES.has(relPath.replaceAll("\\", "/"));
}

/* ── 核心逻辑 ─────────────────────────────── */

function log(msg) {
  console.log(msg);
}

function copyFile(src, dest, dryRun) {
  if (dryRun) {
    log(`  → ${src}  →  ${dest}`);
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.copyFileSync(src, dest);
    log(`  ✓ ${path.relative(REPO_ROOT, src)}`);
  } catch (err) {
    log(`  - 跳过: ${path.relative(REPO_ROOT, src)} (${err.code || err.message})`);
  }
}

function copyDir(srcDir, destDir, dryRun) {
  for (const entry of fs.readdirSync(srcDir)) {
    const srcPath = path.join(srcDir, entry);
    const destPath = path.join(destDir, entry);
    // 用户词表文件：目标已存在说明积累了用户数据，跳过覆盖
    // 注意：用仓库侧的 srcPath 计算相对路径——destPath 在 Windows 上可能与仓库跨盘。
    if (
      !fs.statSync(srcPath).isDirectory() &&
      isWordFile(path.relative(REPO_ROOT, srcPath)) &&
      fs.existsSync(destPath)
    ) {
      log(`  - 保留用户词表（跳过覆盖）: ${path.relative(REPO_ROOT, srcPath)}`);
      continue;
    }
    if (fs.statSync(srcPath).isDirectory()) {
      copyDir(srcPath, destPath, dryRun);
    } else {
      copyFile(srcPath, destPath, dryRun);
    }
  }
}

/** 清理目标目录中源目录已不存在的文件/目录（跳过 PROTECTED），tgtBase 为最终目标根目录（用于跨盘符相对路径） */
function cleanTarget(srcDir, tgtDir, dryRun, tgtBase = null) {
  if (!tgtBase) tgtBase = tgtDir;
  let removed = 0;
  for (const entry of fs.readdirSync(tgtDir)) {
    const srcPath = path.join(srcDir, entry);
    const tgtPath = path.join(tgtDir, entry);
    if (isProtected(entry)) {
      log(`  - 跳过保护条目: ${entry}`);
      continue;
    }
    // 用户词表文件：防止源目录已删除对应文件时把用户的积累数据一并清理
    if (isWordFile(path.relative(tgtBase, tgtPath))) {
      log(`  - 保留用户词表: ${path.relative(tgtBase, tgtPath)}`);
      continue;
    }
    const isDir = fs.statSync(tgtPath).isDirectory();

    // 递归清理：目标存在子目录且源也有同名目录 → 深入清理
    if (isDir && fs.existsSync(srcPath) && fs.statSync(srcPath).isDirectory()) {
      log(`  ~ 扫描目录: ${entry}/`);
      removed += cleanTarget(srcPath, tgtPath, dryRun, tgtBase);
      continue;
    }

    // 源已不存在 → 删除目标条目
    if (fs.existsSync(srcPath)) continue;

    if (dryRun) {
      log(`  ~ 将删除: ${entry}${isDir ? "/" : ""}`);
      removed++;
    } else {
      try {
        fs.rmSync(tgtPath, { recursive: true, force: true });
        log(`  ✗ 已删除: ${entry}${isDir ? "/" : ""}`);
        removed++;
      } catch (err) {
        log(`  - 删除失败: ${entry} (${err.code || err.message})`);
      }
    }
  }
  return removed;
}

/* ── 主函数 ───────────────────────────────── */

async function main() {
  // 解析参数
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const doDeploy = args.includes("--deploy");
  const doPullWords = args.includes("--pull-words");

  const targetRawIdx = args.indexOf("--target");
  let targetDir;
  if (targetRawIdx !== -1 && args[targetRawIdx + 1]) {
    targetDir = path.resolve(args[targetRawIdx + 1]);
  } else {
    targetDir = detectRimeDir();
  }

  if (!targetDir) {
    console.error(
      "错误：未找到 Rime 配置目录。请通过 --target 参数指定：\n" +
        "  node scripts/deploy-rime.mjs --target /path/to/Rime",
    );
    process.exit(1);
  }

  if (!fs.existsSync(targetDir)) {
    console.error(`错误：目标目录不存在: ${targetDir}`);
    process.exit(1);
  }

  console.log(`源目录: ${REPO_ROOT}`);
  console.log(`目标目录: ${targetDir}`);
  console.log(`模式: ${dryRun ? "预览 (dry-run)" : "覆写 + 清理"}${doPullWords ? " + 反拷用户词表" : ""}`);
  console.log("");

  // 先把用户词表反拷回仓库（可选），保证 git 能记录删词/隐藏词的变化
  if (doPullWords) {
    log("── 反拷用户词表 ──");
    for (const rel of WORD_FILES) {
      const src = path.join(targetDir, rel);
      const dest = path.join(REPO_ROOT, rel);
      if (!fs.existsSync(src)) {
        log(`  - 用户词表不存在，跳过: ${rel}`);
        continue;
      }
      if (dryRun) {
        log(`  ← ${rel}  →  ${path.relative(REPO_ROOT, dest)}`);
        continue;
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      log(`  ← ${rel}`);
    }
    console.log("");
  }

  // 先清理目标目录中已不存在的文件
  log("── 清理目标目录 ──");
  const cleaned = cleanTarget(REPO_ROOT, targetDir, dryRun);
  log(`清理完成，移除了 ${cleaned} 个条目。`);
  console.log("");

  // 收集根目录下所有条目（排除 .git）
  const entries = fs.readdirSync(REPO_ROOT).filter(e => e !== ".git");
  let count = 0;
  let skipped = 0;

  for (const entry of entries) {
    const srcPath = path.join(REPO_ROOT, entry);
    const destPath = path.join(targetDir, entry);

    if (isProtected(entry)) {
      if (fs.existsSync(destPath)) {
        log(`  - 跳过保护文件: ${entry}`);
        skipped++;
        continue;
      }
    }

    if (fs.statSync(srcPath).isDirectory()) {
      if (fs.readdirSync(srcPath).length === 0) {
        log(`  - 空目录，跳过: ${entry}/`);
        skipped++;
        continue;
      }
      copyDir(srcPath, destPath, dryRun);
      count += fs.readdirSync(srcPath).length;
    } else {
      copyFile(srcPath, destPath, dryRun);
      count++;
    }
  }

  console.log("");
  if (dryRun) {
    console.log(`预览完成。共 ${count} 个文件，跳过 ${skipped} 个。`);
    console.log("移除 --dry-run 以实际覆写。");
  } else {
    console.log(`部署完成。已写入 ${count} 个文件，跳过 ${skipped} 个。`);
    if (doDeploy && process.platform === "win32") {
      const deployer = detectWeaselDeployer();
      if (deployer) {
        console.log("正在重新部署...");
        const r = spawnSync(deployer, ["/deploy"], { stdio: "ignore" });
        if (r.error) {
          console.error(`  ⚠ 重新部署失败: ${r.error.message}`);
        } else {
          console.log("  ✓ 重新部署完成");
        }
      } else {
        console.log("  ⚠ 未找到 WeaselDeployer.exe，请手动重新部署");
      }
    } else if (doDeploy) {
      console.log("提示：--deploy 仅支持 Windows 小狼毫，请手动重新部署。");
    } else {
      console.log("提示：加 --deploy 参数可在覆写后自动重新部署。");
    }
  }
}

main().catch((err) => {
  console.error("部署失败:", err.message);
  process.exit(1);
});
