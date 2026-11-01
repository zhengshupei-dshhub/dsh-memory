# dsh-memory

给 DeepSeek Harness 用的**本机长期记忆插件**。跨会话保存有价值的事实与偏好，需要时再检索回来；还能全文回捞历史对话原文。用来替代 billion-context 的上下文管理：压缩注定有损，记忆可以无损。

- 仓库：https://github.com/zhengshupei-dshhub/dsh-memory（bundle 形态，装进 DSH 的 profile）
- 数据：`~/.dsh/memory/memories.json`（记忆）+ `~/.dsh/memory/persona.json`（人设），单文件 JSON，可直接查看/备份
- 依赖：零第三方依赖，只用 Node 内置模块
- 兼容性：已在 DSH 0.2.1-rc.3 与 0.2.1-rc.5 上验证（工具、提示段、人设注入均正常）

## 安装（从 GitHub）

```bash
# 方式一：DSH 插件命令（推荐）
dsh plugin --profile desktop add git+https://github.com/zhengshupei-dshhub/dsh-memory.git

# 方式二：写进 profile 的 package.json 后装依赖
#   "dsh-memory": "git+https://github.com/zhengshupei-dshhub/dsh-memory.git"
pnpm install
```

装好后确认 `dsh.profile.bundles` 里有 `dsh-memory`，重启 DSH 生效。国内拉 GitHub 需要代理：`export HTTPS_PROXY=http://127.0.0.1:7897`。

## 为什么不用 billion-context

billion-context 的做法是把旧上下文压成摘要，省 token 但有损，而且体量大、会 patch 一堆核心配置。dsh-memory 换个思路：

| | billion-context | dsh-memory |
|---|---|---|
| 长期信息 | 压缩进摘要，细节丢失 | 显式记忆条目，原文保留 |
| 找回方式 | `decompress` / `search_context` | `memory_search` / `memory_recall` |
| 上下文压力 | 自己实现压缩引擎 | 交给 DSH 自带 `dsh-compaction-basic`（超阈值自动压缩） |
| 依赖 | mysql2 / zod / jimp 等 | 无 |

两者可以共存，但默认二选一：本机已把 `billion-context` 从 profile 的 bundles 里摘掉，压缩回到 DSH 自带实现。

## 模型侧能力

### 记忆工具（四个）

| 工具 | 作用 |
|---|---|
| `memory_save` | 存一条记忆（`text` 必填；`kind` / `tags` / `importance` 1–5 / `scope` global\|project；传 `id` 则更新原条目） |
| `memory_search` | 检索记忆；空 query 列出高价值条目；可按 kind/scope/tags 过滤 |
| `memory_forget` | 按 id 删除 |
| `memory_recall` | 全文检索本机历史会话原文，返回会话 id、日期、cwd 和片段 |

每次请求会自动注入一段系统提示（`order 2500`，名字 `tool:memory`）：用法约定 + **置顶记忆**（`importance >= 4` 或 `kind = preference` 的全局记忆，默认最多 12 条 / 1600 字符）。置顶只随记忆变化，不随会话漂移，因此不破坏前缀缓存。

### 人设养成（三个工具 + 一块提示）

人设不是写死的提示词，而是**存在 `persona.json` 里、随对话一点点长出来的自我**：

| 工具 | 作用 |
|---|---|
| `persona_read` | 读当前人设：身份、性格强度、说话方式、看重的东西、小习惯、和用户的默契、最近日记、今日成长额度 |
| `persona_grow` | 推进一小步成长：`trait`（性格标签 + 强度增量，1–10）、`voice`（说话方式）、`value`（看重的东西）、`quirk`（小习惯）、`moment`（共同经历/梗）、`nickname`（怎么称呼用户） |
| `persona_diary` | 写一段第一人称日记（内容 / 心情 / 标签），连续的自我叙述是「活人感」的来源 |

机制：

- 性格有 0–100 的强度值，新性格从 40 起，每次成长按 `delta` 加；上限 12 条性格、各 10 条说话方式/价值观/习惯、30 段共同经历、80 篇日记。
- **每天成长次数由 `growthPerDay` 控制**（1–20，插件默认 6，本机当前设为 10），超额的调用只返回提示、不写数据——这是防止「一夜之间换个人」的限速器，不是技术上限。
- 人设块以 `order 2400`、名字 `persona:self` 注入系统提示，排在记忆块之前；默认预算 1200 字（`personaLimitChars`），会带上「认识第 N 天」「今天还可成长 x/4」这类连续感信息。
- 日记里可以记心情，提示块只取最近 2 篇、人设读取取最近 5 篇，避免上下文膨胀。

「活人感」的取舍：不靠堆形容词，而靠**具体细节 + 稳定的口味与习惯 + 连续的自我叙述 + 和用户之间的默契**。所以插件约束模型：每次成长必须有这次对话里的真实证据，且每次会话最多推进 1–2 次。

### 自我迭代（演化台账）

插件自己的改进也进记忆：

| 工具 | 作用 |
|---|---|
| `evolution_note` | 记一个改进点：`target`（memory / dafeiyu / both）、`kind`（idea / feature / bug / friction / refactor）、现象与证据 |
| `evolution_list` | 看未处理项与最近改动，决定下一步改什么 |
| `evolution_log` | 记录已落地的改动：版本、摘要、文件、测试结果；带 `backlogId` 会自动把对应项标 done |

数据是 append-only JSONL，在 `~/.dsh/memory/evolution/`：`backlog.jsonl`（想法）、`journal.jsonl`（改动）。系统提示里有一段 `order 2480` 的「自我迭代」约定，要求捕获 → 回看 → 验证 → 记录，每次最多推进一项。

门禁与流程见 [../EVOLUTION.md](../EVOLUTION.md) 和 `~/DeepSeekHarness/BigFish/selfcheck.mjs`。

### 和桌面大肥鱼联动

本机的 `dsh-dafeiyu` 已换成工作区里的本地分支（`/Users/zhengshupei/DeepSeekHarness/BigFish/dsh-dafeiyu`），新增了 `src/persona-bridge.js`：只读本插件的 `persona.json`，当人设成长、写日记或换天时，等你空闲后让桌宠冒一条气泡；空闲够久还会自言自语。开关与节奏在 dsh-dafeiyu 的插件设置里（`personaEnabled` / `personaIdleMinutes`）。记忆插件本身不需要额外配置。

## 配置

profile 的 `cordis.patch.yml` 里由 bundle 自己插入的这一行：

```yaml
- insert:
    - id: memory
      name: dsh-memory
      config:
        pinnedLimit: 12        # 注入的置顶记忆条数上限
        pinnedChars: 1600      # 注入的置顶记忆字符预算
        personaLimitChars: 1200 # 人设块字符预算
        # evolutionDir: /path   # 默认 $DSH_HOME/memory/evolution
        # root: /path           # 默认 $DSH_HOME/memory（memories.json + persona.json）
        # sessionsRoot: /path   # 默认 $DSH_HOME/sessions
        # disableRecall: true   # 关掉 memory_recall
```

## 检索实现

- 记忆检索：中英混合分词（中文 bigram + 拉丁词），BM25 变体打分，叠加 importance、120 天新鲜度衰减、项目目录匹配；无向量、无外部服务。
- 历史会话：直接读 `$DSH_HOME/sessions/<cwd>/<session>/*.jsonl.zstd`。DSH 的日志是**拼接的 Zstd 帧容器**，Node 的 `zstdDecompressSync` 只解第一帧，所以插件按帧头结构自己切分再逐帧解压（见 `lib/sessions.js`）。
- 不做 FTS 索引：本 profile 的 session-query 索引是 `openAt: never`，全量扫描更可控；当前 4 个会话 / 2.6MB 约 2.4ms。

## 开发

```bash
node --test test/store.test.js test/sessions.test.js test/persona.test.js   # 24 个单元测试
```

改完代码后，触碰一下 profile 的 `cordis.patch.yml` 触发一次 HMR 重新组合即可热加载，无需重启 DSH。

## 已知限制

- 记忆需要模型主动 `memory_save`，不做自动摘要/自动抽取。
- 人设同样靠模型主动 `persona_grow` / `persona_diary` 推进；插件只负责持久化、限速与注入，不会自己编造成长。
- 性格强度没有衰减，长期只会变强；想回退就手工改 `persona.json` 或删掉条目。
- `memory_recall` 只索引 `user/message` 与 `assistant/message` 的正文，不含 reasoning 与工具结果全文。
- 记忆规模按数千条设计；再多应换成 SQLite + 向量检索。
- 无跨设备同步，就是本机单机使用。

## 回滚到 billion-context

billion-context 已被完整卸载（依赖、node_modules、lockfile 条目都没了）。要回退：

```bash
dsh plugin --profile desktop add billion-context
```

再把 `"billion-context"` 加回 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 列表，保存后 HMR 会自动重新组合。
