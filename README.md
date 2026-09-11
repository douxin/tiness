# Tiness

一个 Bun + TypeScript 实现的终端 Agent Harness：固定工具、显式权限、复杂任务计划、有预算的上下文、Esc 中断和 FIFO 消息队列。

**验证状态：40 项本地自动化测试通过，3 项真实模型集成场景分别通过；本机 PTY 终端验收及独立二进制启动/退出通过。测试发现并修复了摘要生成预算问题。详见 [测试报告](TESTING.md)。**

## 运行环境

- 开发：Bun 1.4.2 或更高版本。
- 使用独立二进制：macOS 或 Linux，不需要安装 Bun / Node。
- `/bin/bash`、交互式终端、可访问的 Responses API 端点及对应模型凭据。
- 任务需要的 git、Python 等程序由工作环境自行提供。

## 先手动配置模型

示例配置位于：

| 文件 | 手动放置位置 | 用途 |
|---|---|---|
| `config/config.example.json` | `~/.tiness/config.json` | API 地址、Key、模型名称 |
| `config/runtime.example.json` | `~/.tiness/runtime.json` | 全局运行默认值，可只保留需要修改的字段 |
| `config/workspace-runtime.example.json` | `<工作区>/.tiness/runtime.json` | 可选项目配置 |

首次配置时，在确认目标文件不存在或已备份后复制：

```bash
mkdir -p ~/.tiness
cp -n config/config.example.json ~/.tiness/config.json
cp -n config/runtime.example.json ~/.tiness/runtime.json
chmod 700 ~/.tiness
chmod 600 ~/.tiness/config.json ~/.tiness/runtime.json
```

编辑 `~/.tiness/config.json`：

```json
{
  "baseUrl": "https://api.openai.com/v1",
  "apiKey": "填写你自己的 API Key",
  "model": "填写端点实际支持的模型名称"
}
```

环境变量 `OPENAI_API_KEY` 优先于配置中的 `apiKey`。不从项目配置读取凭据，不自动创建密钥，不在仓库中保存密钥。不支持 ChatGPT 登录态直接替代 API Key。

模型需要支持 Responses API 的函数调用与所用 strict schema。配置 `windowTokens` 和 `maxOutputTokens` 时，以实际模型能力为准；默认 32768 是本地预算，不是对模型窗口的自动发现。

## 安装与构建

```bash
bun install --frozen-lockfile
bun run typecheck
bun run build
```

本机产物为 `dist/tiness`。从想要工作的目录启动：

```bash
cd /path/to/your/project
/path/to/tiness/dist/tiness
```

开发时从源码运行：

```bash
bun --no-env-file /path/to/tiness/src/cli.ts
```

独立二进制禁用项目 `.env`、`bunfig.toml`、`package.json`、`tsconfig.json` 的自动加载。源码开发建议直接使用上面的 `--no-env-file` 命令；父级启动器若已将变量导入环境，Tiness 无法判断其来源。

```bash
bun run build:all
```

产生 `dist/tiness-darwin-arm64`、`dist/tiness-darwin-x64`、`dist/tiness-linux-arm64` 和 `dist/tiness-linux-x64`。交叉编译需要获取对应 Bun runtime；各平台的实际运行验收仍需在对应系统完成。

## 终端操作

| 操作 | 行为 |
|---|---|
| Enter | 提交一条消息；有任务运行时进入 FIFO 队列 |
| Esc | 取消当前 Session；清理完成后自动执行下一条排队消息 |
| Tab | 存在审批时，在消息输入和审批区域之间切换焦点 |
| 审批区域 ↑ / ↓ / ← / → 或 1 / 2 / 3 | 选择允许一次、允许本 Session 同类操作、拒绝 |
| 审批区域 Enter | 确认所选审批；默认选中拒绝 |
| F2 | 展开/折叠工具输出；审批时查看完整操作与授权范围 |
| 鼠标点击审批选项 | 执行对应选择 |
| 滚轮 / ↑ / ↓ / PgUp / PgDn | 上下翻阅当前进程的消息 |
| Home / End（无草稿）或 Ctrl+Home / Ctrl+End | 跳到最早消息 / 回到最新消息 |
| Ctrl+A / Ctrl+E | 输入光标移动至开头 / 末尾 |
| Ctrl+U / Ctrl+K | 删除光标前 / 后内容 |
| `/new` | 仅在空闲且队列为空时创建新 Task |
| `/quit` / Ctrl+C | 取消当前任务，记录未执行队列消息，退出 |

支持中文、按显示宽度换行和 bracketed paste。粘贴内容里的换行保留在同一条草稿中，不会自动提交。最小窗口为 40 列 × 16 行；更小时显示扩窗提示并暂停审批确认。

授权使用居中面板，默认选中拒绝。没有草稿时自动聚焦授权；有草稿时保留输入焦点。Tab 可切换焦点，普通文字输入或粘贴也会切回输入区（数字 1/2/3 在授权焦点下用于选择）。审批等待时普通输入仍然可以排队；普通输入区的 Enter 不会批准工具。运行中提交的新消息不会改变正在执行的 Session。取消不自动回滚已经发生的修改。

顶部显示当前请求、轮次、工具和排队数量。计划与消息放在中间，工具结果默认折叠；底部保留输入框和快捷键。查看历史时新消息不会将视图拉回底部，当前进程的消息不会因超过固定行数而删除。启用鼠标滚动后，部分终端需要按住 Shift 才能选择复制文字。

## 权限

默认权限：

```json
{
  "permissions": {
    "read": "allow",
    "write": "ask",
    "edit": "ask",
    "shell": "ask"
  }
}
```

所有权限支持 `allow / ask / deny`。项目配置只能收紧全局权限；全局 `ask` 不会被项目文件中的 `allow` 覆盖。要设置更宽松的长期默认值，需由用户直接编辑全局运行配置。

一次文件修改审批绑定当时的目标与内容版本。审批后文件发生变化，操作返回冲突，要求重新读取。Session 临时授权不跨请求继承。

**权限不是 OS 沙箱。** 经批准的 shell 使用宿主用户权限，可能访问 Workspace 外文件和网络；批准本 Session 的 shell，就是允许该 Session 中的所有 shell 命令。文件工具的 Workspace 限制无法约束 shell。禁止文件写工具也不意味着批准的 shell 无法写文件。

原生文件工具拒绝 Workspace 外路径和 Harness 私有目录；当前 Task 已登记的长输出产物可以通过 `artifactId` 读取。路径检查防止通常的符号链接逃逸，但不承诺对恶意并发进程的完整隔离。

## 默认执行限制

| 配置 | 默认值 |
|---|---:|
| 最大 Agent Round 数 | 40 / Session |
| Session 总时间 | 30 分钟，包含审批、工具和压缩 |
| 单次模型请求 | 120 秒 |
| 暂时模型错误重试 | 最多 2 次 |
| 默认工具时间 | 120 秒 |
| shell 可申请的最大时间 | 10 分钟，仍受 Session 剩余时间限制 |
| 单次审批等待 | 5 分钟 |
| 取消清理宽限期 | 2 秒 |
| 最大待执行消息 | 100 条 |
| 单条输入上限 | 64 KiB |
| 普通工具结果上限 | 32 KiB |
| 单个长输出产物上限 | 10 MiB |
| 单次完整写入上限 | 1 MiB |

时间单位统一为毫秒。没有无限轮次或无限超时。`resultMaxBytes` 最小为 1024，为读取位置和截断提示保留空间；产物分页的 `maxBytes` 至少为 4，以容纳完整 UTF-8 字符。`modelMaxRetries: 0` 表示不重试，`maxInputRepairsPerRound: 0` 表示不自动修复服务端输入超限，均不代表无限制。

达到单个工具超时会返回工具错误；达到 Session 总超时或轮次上限会结束该 Session，清理后自动执行队列下一条。鉴权、日志写入和进程清理等全局失败会停止队列。

## 上下文与计划

复杂任务通过 `update_plan` 建立步骤，并随执行更新。它是同一个 Agent 的显式状态，不另设规划 Agent；Plan 不构成工具授权。

模型输入包括当前用户请求、AGENTS.md、Skill Catalog、当前计划、必要的 Skill 正文、历史摘要与近期完整调用块。每次调用前进行预算估算。

- 已知 tokenizer 的模型使用本地 tokenizer，并加上估算余量。
- 未知模型使用保守的 UTF-8 字节估算，可能比实际窗口更早压缩。
- 压缩阈值默认是可用输入预算的 80%，目标为 60%。
- 长 Session 内也会折叠已经完成的旧 Round，不等待整个 Session 结束。
- 每个 Session 最多 4 次压缩调用；失败不会用空摘要替换历史。
- `summaryMaxTokens` 限制保留的可见摘要长度；摘要请求使用 `maxOutputTokens` 作为包含推理开销的生成总预算，避免推理耗尽正文预算。
- 当前请求和计划不静默截断；工具调用和结果按完整块保留或折叠。
- 压缩摘要是有损历史观察，不是长期 Memory，也不是权限来源。

文件读取默认 200 行，最多 2000 行；长输出保存在当前工作区 `.tiness/artifacts/`，通过引用按需分页。超出产物上限的部分不再保存，结果明确标记截断。

## 文件与日志

```text
<workspace>/.tiness/
├── runtime.json
├── tasks/<task-id>.jsonl
└── artifacts/<task-id>/*.txt
```

每次启动新建 Task，JSONL 记录消息队列、Session、Round、模型响应、工具调用与结果、审批、Plan 和压缩摘要。请将 `.tiness/` 加入项目 `.gitignore`。

不提供旧任务列表、搜索、恢复、自动重试或重新执行。重启后未消费的旧消息不会运行。崩溃后有 `tool_started` 而无 `tool_result` 的调用可能已经产生副作用，用户需要查看实际文件或系统状态。

## Skills

只发现项目内 `.agents/skills/*/SKILL.md`，读取根目录 `AGENTS.md`。启动后不热加载，不搜索父目录或全局指令。

Skill 的正文通过 `read` 获取，资源相对 Skill 目录解析；脚本通过受同样权限与执行限制的 shell 运行。Skill 元数据不会放宽权限。没有 Extension、Hook、Custom Tool 或远程扩展加载。

## 运行测试

本地测试不需要真实 Key，不连接外部 API；Adapter 测试只启动本机临时 HTTP 服务。PTY 测试需要 Python 3（仅测试依赖，不是 Harness 运行依赖）；环境缺少 Python 时该项会跳过。

```bash
bun test
```

覆盖配置合并、权限、FIFO、取消、预算、上下文压缩、协议配对、文件冲突、路径边界、长输出、进程组、Skills、终端输入与 JSONL 写入。

真实模型集成测试需要单独明确启用，会产生 API 使用费用：

```bash
TINESS_LIVE=1 bun test tests/live.test.ts
```

真实测试读取你已经配置的模型，分别验证基础读写、复杂修复加 FIFO 接续、历史压缩后继续请求。所有场景使用临时工作区：基础读写禁止 shell；复杂修复只批准 fixture 中的目标源码修改及 `bun test` 命令；压缩场景使用合成历史。不会让模型操作本仓库，结束后删除临时工作区。

建议随后在一个可丢弃的小项目中进行终端验收：

1. 请求读取文件并输出结果。
2. 请求修改文件，分别尝试拒绝与批准，确认只有批准后才改变文件。
3. 请求一个多步骤修复，检查 Plan 与测试证据。
4. 在任务 A 执行中输入 B、C，确认依次执行且 A 看不到后续消息。
5. 在模型等待、审批等待和长命令运行时按 Esc，确认取消后处理下一条。
6. 使用较小的运行预算验证超时、轮次上限、长输出和压缩。
7. 退出并重启，确认创建新 Task，旧队列不被恢复。

## 当前边界

不支持后台进程托管、交互式子程序、Windows、历史恢复、多模型切换、OS 沙箱或插件。复杂任务是否使用 Plan 由模型指令引导，并通过行为测试验收；Core 校验计划结构，不用第二个模型强制判断任务复杂度。

当前验证环境为 macOS arm64；其余目标已交叉编译，但尚未在对应系统实机运行。自动化结果覆盖列出的场景，不代表所有模型端点、任务或终端环境都已验证。
