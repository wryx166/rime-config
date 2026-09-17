# Rime 配置仓库

基于 [iDvel/rime-ice](https://github.com/iDvel/rime-ice)（雾凇拼音）的个人 Rime 配置，使用 [小狼毫 Weasel](https://rime.im/) 输入引擎。

## 目录结构

| 路径 | 说明 |
| --- | --- |
| `rime_ice.custom.yaml` | 雾凇拼音方案的自定义补丁（词典、lua 模块注册等） |
| `rime_ice.custom.dict.yaml` | 自定义词典（`translator/dictionary` 指向此文件） |
| `cn_dicts/` | 额外词库（如明日方舟） |
| `lua/` | lua 脚本：`blacklist.lua`（候选词黑名单）、`cold_word_drop/`（删词/隐藏/降频）、其他过滤器 |
| `scripts/deploy-rime.mjs` | 部署脚本：将本仓库覆写到用户 Rime 配置目录 |

## 部署

一键把仓库配置推送到用户目录（Windows 下为 `%APPDATA%\Rime`），并可选自动重新部署：

```bash
node scripts/deploy-rime.mjs                # 覆写 + 清理目标目录
node scripts/deploy-rime.mjs --deploy       # 覆写后自动运行 WeaselDeployer /deploy
node scripts/deploy-rime.mjs --pull-words   # 部署前将用户词表反拷回仓库（配合 git 版本化）
node scripts/deploy-rime.mjs --dry-run      # 预览，不实际写入
node scripts/deploy-rime.mjs --target <dir> # 指定目标目录
```

常用的完整流程：

```bash
node scripts/deploy-rime.mjs --pull-words --deploy
```

### 保护文件

目标目录中的 `installation.yaml`、`user.yaml`、`build/`、`*.userdb`、`*.gram` 以及
`lua/cold_word_drop/` 下的词表文件（见下）在部署时不会被覆盖，也不会被清理。

## 冷词丢弃模块（lua/cold_word_drop/）

官方 rime-ice 自带但默认不启用的模块（代码随仓库分发，需手动挂载）：

| 快捷键 | 功能 | 键名 |
| --- | --- | --- |
| `Ctrl+D` | 强制删词（无视输入编码），写入删词表 | `key_binder/drop_cand` |
| `Ctrl+X` | 按编码隐藏候选词，写入隐藏表 | `key_binder/hide_cand` |
| `Ctrl+J` | 降频（移出前三候选/置后），写入降频表 | `key_binder/reduce_freq_cand` |

### 注册（本仓库已配置）

`rime_ice.custom.yaml` 的 `patch:` 段：

```yaml
engine/processors/+: [lua_processor@*cold_word_drop.processor]
engine/filters/+: [lua_filter@*cold_word_drop.filter]
```

> ⚠️ processor 与 filter 必须一起挂：`filter.lua` 依赖 `processor.lua` 加载的
> `metatable.lua` 提供的 `table.find_index` 等辅助函数，只挂 filter 会导致候选列表报错。

### 快捷键来源与修改

快捷键在 `lua/cold_word_drop/processor.lua:86-89` 中定义，优先级为先读配置、后取硬编码默认值：

```lua
env.drop_cand_key = config:get_string("key_binder/drop_cand") or "Control+d"
```

修改方法：在 `rime_ice.custom.yaml` 的 `patch:` 段添加同名字符串键。如把删词键改为 `Ctrl+E`：

```yaml
patch:
  key_binder/drop_cand: "Control+e"
```

> ⚠️ 这是模块自定义的平铺键，由 Lua 代码读取，**不是** `key_binder` 节下 `bindings:` 列表的
> 原生绑定（如 `page_up: [Page_Down]`）。不要写进 bindings，否则按键会被 Rime 原生层拦截。

### 词表文件与数据同步

按快捷键后，词条由 `processor.lua` 的 `write_word_to_file()` 全量写回**用户数据目录**：

```
%APPDATA%\Rime\lua\cold_word_drop\{drop_words,hide_words,reduce_freq_words}.lua
```

仓库里的同名文件只是"种子"（首次部署时的示例），**删词记录不会自动回写仓库**。
为此：

- `scripts/deploy-rime.mjs` 对这几个文件做双向保护：部署时**不覆盖、不清理**用户积累的词表；
- 需要把删词纳入版本控制时，用 `--pull-words`（或手动反拷）后再提交：

```bash
node scripts/deploy-rime.mjs --pull-words --deploy   # 每次提交前跑一次
git add -A && git commit -m "同步删词记录"
```

### 实现路径（谁在调用 drop_words.lua）

按时序分四步：

**① 注册** — `rime_ice.custom.yaml` 的 `patch:` 段把模块挂进引擎，构建时合并进 `build/rime_ice.schema.yaml`：

```yaml
engine/processors/+: [lua_processor@*cold_word_drop.processor]
engine/filters/+: [lua_filter@*cold_word_drop.filter]
```

**② 加载（引擎启动时执行一次）** — 两个入口各自 `require` 同一份磁盘文件：

| 调用者 | 位置 | 作用 |
| --- | --- | --- |
| `filter.init()` | `filter.lua:14` | `pcall require("cold_word_drop/drop_words")` → `env.drop_words`，每次候选过滤时**只读**查找 |
| `processor.init()` | `processor.lua:79` | 同样的 require → `env.drop_words`，供运行时**增删** |

`require` 按 librime 的 lua plugin 路径解析，**实际加载的是用户部署目录** `%APPDATA%\Rime\lua\cold_word_drop\drop_words.lua`；
仓库里的同名文件不参与加载，只是种子/版本化来源。

**③ 触发（Ctrl+D）** — 按键事件链：按 `Ctrl+D` → `processor.func()`（`processor.lua:97`）里
`key:repr()` 与 `env.drop_cand_key`（默认 `"Control+d"`）匹配 → 有候选菜单则处理，返回 `kAccept` 拦截按键。

**④ 写回（先内存后磁盘）**：

- `append_word_to_droplist(env, ctx, "drop")` — `table.insert(env.drop_words, word)`，内存表更新 → 当前候选立即被隐藏（不重载）
- `write_word_to_file(env, "drop")` — `table.serialize` 全量序列化后重写磁盘文件

**过滤时机（只读侧）** — 每次出候选，`filter.func` 用 `table.find_index(drop_words, cand_text)` 逐词匹配
（`filter.lua:43-44`），命中即 `yield` 跳过，该词不出现在候选列表。

> ⚠️ 词表文件受部署保护（不覆盖），**手工编辑仓库 `drop_words.lua` 不会传播到用户目录**；
> 改清单请直接用 Ctrl+D，或编辑用户目录文件后 `--pull-words` 回拷。

### 日常节奏

1. 打字时遇到想删/想隐藏的词 → 选中候选词按 `Ctrl+D` / `Ctrl+X` / `Ctrl+J`
2. 定期 `node scripts/deploy-rime.mjs --pull-words --deploy`
3. `git commit`（可选，用于版本化删词记录）

## 其他 lua 模块

- `lua/blacklist.lua`：候选词黑名单过滤器，在 `rime_ice.custom.yaml` 中通过
  `engine/filters/+: [lua_filter@*blacklist]` 挂载。用途见该文件内的关键词列表。
