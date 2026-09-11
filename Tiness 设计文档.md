# Tiness 极简 Agent Harness 设计文档

> - Version: V0.1 Design · Revised
> - Product: `tiness`
> - Runtime: Bun · TypeScript
> - Platform: macOS / Linux
> - Interface: Terminal Only
> - Model Protocol: OpenAI Responses API
> - Storage: Workspace-local Files + JSONL
> - Skills: Agent Skills Specification
> - Distribution: Single Binary First

---

# 1. 项目定位

`tiness` 是一个极简、可理解、能够实际完成本地文本与代码任务的 Agent Harness。

用户在终端提出请求，模型读取上下文、制定必要的计划、请求工具、观察结果并继续工作。Harness 负责权限检查、执行控制、上下文管理、消息排队和过程记录。

核心目标：

> **用少量明确的机制，完成有权限边界、有执行上限、可中断、可追踪的 Agent 工作闭环。**

极简衡量的是机制数量和理解成本，而不是主循环的行数。参数校验、权限、取消、超时、上下文容量和可靠记录属于闭环本身。

本版不提供 Extension、Hook、Custom Tool、Memory、RAG、MCP、子 Agent、独立 Planner、数据库、后台 Agent、历史会话管理、Web UI、桌面 UI、多 Provider 或运行时模型切换。不给这些能力预留框架和扩展协议。

复杂任务使用同一个 Agent 的显式 Plan，不创建第二个规划 Agent。

---

# 2. 核心概念与组成

> **模型决定下一步，Plan 记录工作步骤，权限决定能否执行，工具执行动作，文件保存当前事实，JSONL 记录过程，Context 选择模型当前需要的信息。**

```text
Tiness
├── Terminal：输入、输出、审批、Esc、队列状态
├── Runtime：Task / Session / Round、FIFO 队列、执行限制
├── Agent Loop：模型 → 工具 → 结果 → 下一轮
├── Plan：复杂任务的步骤与状态
├── Permission Gate：allow / ask / deny
├── Context：指令、Skills、计划、近期历史、压缩摘要
├── Model：OpenAI Responses Adapter
├── Tools：read / write / edit / shell / update_plan
├── Skills：项目内 .agents/skills/
└── Storage：当前工作区 .tiness/
```

`update_plan` 是一个内置状态工具；其余四个是文件与命令行操作工具。工具集合固定，运行时不能注册新工具。

---

# 3. Workspace 与存储原则

Workspace Root 是启动 `tiness` 时当前工作目录的真实路径，在进程内固定不变。

**除明确属于用户级的信息外，所有 Harness 数据优先保存在当前工作区 `.tiness/`。** 目录名统一为 `.tiness`。

```text
~/.tiness/
├── config.json                 # 用户级模型连接与凭据
└── runtime.json                # 用户级执行、权限、上下文默认配置

<workspace>/
├── AGENTS.md                   # 项目指令
├── .agents/skills/*/SKILL.md    # 标准项目 Skills
├── .tiness/
│   ├── runtime.json            # 可选：项目运行参数覆盖，不保存 API Key
│   ├── tasks/<task-id>.jsonl    # 每个 Task 一份追加式事件记录
│   └── artifacts/<task-id>/    # 工具长输出等过程产物
└── ...                         # 项目本身的文件
```

Plan、消息队列事件、权限决策、压缩摘要都记录在当前 Task JSONL 中，不再为它们建立第二套持久化状态文件。运行时可维护内存投影。

项目源码是当前事实；历史工具输出是当时的观察。修改前需核对文件当前内容，不能把历史副本当作最新文件。

进程启动创建新的 Task，不扫描、选择、恢复或重新执行旧 Task。用户需要查看旧记录时直接阅读 JSONL。历史记录的存在不意味着支持历史会话功能。

`.tiness/` 应作为本地运行数据排除出版本控制；启动时提示用户配置忽略规则，不擅自修改现有 `.gitignore`。记录可能包含用户输入和项目内容，不记录 API Key 或完整进程环境。

---

# 4. Task / Session / Round

| 概念 | 定义 | 生命周期 |
|---|---|---|
| Task | 同一个工作区中一段连续工作上下文 | 启动或 `/new` 创建，`/new` 或退出结束 |
| Session | 一条出队的用户消息所触发的一次完整执行 | 开始执行至正常回复、取消、失败或达到限制 |
| Round | 一次逻辑 Agent 模型请求，以及该响应的工具调用与结果 | 模型请求开始至该批调用被结算 |

一个 Task 中的 Session 串行执行，共享已完成的工作上下文。一个 Round 内的多个工具调用也串行执行。

用户输入尚在队列里时，不创建 Session，不进入当前 Session 的模型上下文。

模型网络重试属于同一个 Round 的不同 attempt；压缩调用属于辅助模型请求，不计入 Round，但单独受次数、时间和 token 上限约束并记录用途。

Session 状态至少包括：

```text
running / awaiting_approval / cancelling
completed / cancelled / failed / limit_reached
```

`completed` 表示这次请求产生了正常终结回复，不等同于业务目标已经成功。拒绝执行、无法完成、测试未通过等必须在回复与记录中如实表达。

---

# 5. 输入与 FIFO 消息队列

终端输入在模型请求、工具执行和压缩期间保持可用。按 Enter 提交一条完整消息；未提交的编辑草稿不进入队列。

所有普通消息先分配 `messageId` 和单调递增的 `queueSeq`，追加 `message_queued`，成功后才显示“已排队”。只有一个队列消费者。

```text
Session A 正在执行
用户提交 B → 队列 [B]
用户提交 C → 队列 [B, C]
A 结束并完成清理、持久化
→ B 出队，创建 Session B
→ B 结束并完成清理、持久化
→ C 出队，创建 Session C
```

规则：

- 严格 first-in-first-out，不合并、改写、插队或并行执行消息。
- 新消息不注入当前 Session，不作为当前工具的参数或审批答案。
- 后续 Session 能看到前面 Session 的实际结果、取消或失败状态，但不能假设前序请求成功。
- 普通完成、Esc 取消、Session 局部失败或达到执行限制后，清理完毕就自动执行下一条。
- 全局鉴权失败、日志不可写、无法完成进程清理等使后续任务无法安全运行的问题，停止消费并退出；剩余消息记录为未执行，不伪装为已完成。日志已经不可写时只能在终端列出未执行消息，明确说明记录不完整。
- 不做自动去重；连续提交两条相同内容也是两条消息。
- 队列仅在当前进程中调度，重启后不自动执行 JSONL 中尚未消费的消息。
- 队列达到配置上限时拒绝新提交，保留输入草稿并提示；不丢弃最早消息。

消息从出队到 Session 结束只有一个执行者。输入监听器只负责入队与控制信号，不能直接启动另一个 Agent Loop。

---

# 6. Esc 中断与退出

**执行任务时按 Esc，立即请求取消当前 Session。** Esc 不退出进程、不清空队列、不回滚已经完成的文件或外部操作。

取消覆盖模型请求、模型重试等待、上下文压缩、权限等待和工具执行：

1. 标记当前 Session 为 `cancelling`，触发同一个 Session AbortController。
2. 不启动新的模型请求或工具；关闭当前审批。
3. 中止网络等待，停止受管 shell 进程组并等待清理。
4. 对已有模型响应中尚未执行的调用记录 `not_executed`；对结果无法确认的调用记录 `unknown`。
5. 对已经进入原子文件提交阶段的操作，核实结果后再报告，不能宣称已回滚。
6. 写入 `session_end: cancelled`，显示取消结果，然后自动消费队列下一条消息。

网络取消不承诺服务端停止计算或不计费。取消后晚到的网络结果不得进入下一 Session；回调必须校验 Session ID 和取消状态。

Esc 只作用于按键发生时的活动 Session。取消清理期间的重复 Esc 不取消后续排队消息；空闲时 Esc 不产生任务操作。终端需区分独立 Esc 与方向键等转义序列。

`Ctrl+C` 和 `/quit` 请求退出整个进程：停止消费队列、取消当前执行、将队列剩余消息记录为 `message_abandoned`，关闭 Task、刷新记录并退出。退出清理失败时返回非零状态。

---

# 7. Slash Commands 与审批输入

V0.1 保留 `/new` 和 `/quit`。

- `/new` 仅允许在没有活动 Session 且队列为空时执行；否则提示先等待，或用 Esc 逐个中断当前执行。它不会悄悄清空排队消息。
- `/new` 结束旧 Task，创建新 Task，清空历史投影、压缩摘要、当前 Plan、Skill 激活记录和临时授权。Workspace 与启动配置不变。
- `/quit` 是即时控制命令，不进入 FIFO 队列。
- 未知 slash command 显示错误，不作为普通任务执行。

审批使用居中的独立选择面板，默认选中拒绝。无草稿时自动聚焦审批；有草稿时保留输入焦点。Tab 切换焦点，普通文字或粘贴转入消息输入，数字 1/2/3 在审批焦点下用于选择。审批焦点下，由用户选择“允许一次 / 本 Session 允许同类操作 / 拒绝”。普通输入区的 Enter 永远只提交新任务消息，不会隐式批准工具。

审批等待期间仍可在普通输入区排队消息；Esc 始终取消当前 Session。权限超时则拒绝该次调用，默认不执行。

---

# 8. 全局配置与默认值

`~/.tiness/config.json` 保存用户级模型连接：

```json
{
  "baseUrl": "https://api.openai.com/v1",
  "apiKey": "",
  "model": ""
}
```

`OPENAI_API_KEY` 覆盖这里的 Key。模型名称必须由用户填写，不硬编码会过时的默认模型；缺少有效连接信息时启动报错，不发送请求。

`~/.tiness/runtime.json` 保存运行默认配置。文件不存在时使用内置默认值；用户可按以下完整示例创建，也可只填写要修改的字段：

```json
{
  "execution": {
    "maxRounds": 40,
    "sessionTimeoutMs": 1800000,
    "modelTimeoutMs": 120000,
    "modelMaxRetries": 2,
    "retryBaseDelayMs": 1000,
    "retryMaxDelayMs": 10000,
    "toolTimeoutMs": 120000,
    "shellMaxTimeoutMs": 600000,
    "terminationGraceMs": 2000,
    "approvalTimeoutMs": 300000
  },
  "queue": {
    "maxPendingMessages": 100,
    "maxMessageBytes": 65536
  },
  "permissions": {
    "read": "allow",
    "write": "ask",
    "edit": "ask",
    "shell": "ask"
  },
  "context": {
    "windowTokens": 32768,
    "maxOutputTokens": 8192,
    "safetyMarginTokens": 2048,
    "compactAtRatio": 0.8,
    "compactTargetRatio": 0.6,
    "recentRounds": 2,
    "summaryMaxTokens": 2048,
    "maxCompactionsPerSession": 4,
    "compactionTimeoutMs": 60000,
    "maxInputRepairsPerRound": 1
  },
  "tools": {
    "readDefaultLines": 200,
    "readMaxLines": 2000,
    "resultMaxBytes": 32768,
    "artifactMaxBytes": 10485760,
    "writeMaxBytes": 1048576
  },
  "plan": {
    "maxSteps": 10
  }
}
```

这些是产品初始默认值，不是所选模型能力的声明。用户应将 `windowTokens`、`maxOutputTokens` 配置为模型实际支持范围以内。32768 只是保守的本地预算，不能保证任意兼容端点都支持。

所有时间单位为毫秒。数字配置要求有限且在有效范围，不能用 0 或负值表示无限制。未知字段、非法枚举、错误 JSON 与矛盾预算在启动时明确报错。

校验包括：输入预算必须为正，`0 < compactTargetRatio < compactAtRatio < 1`，摘要上限小于输入预算，输出产物上限不小于单次结果上限，shell 最大超时不小于默认工具超时。

---

# 9. 工作区配置与信任

`<workspace>/.tiness/runtime.json` 可覆盖执行、队列、上下文、工具及 Plan 参数，启动时按字段与全局默认值合并。数组若引入则整体替换，不做隐式拼接。

普通运行参数优先级：

```text
内置默认值 < ~/.tiness/runtime.json < <workspace>/.tiness/runtime.json
```

权限不能按普通覆盖规则自动放宽：

```text
deny 比 ask 更严格，ask 比 allow 更严格
最终静态权限 = 全局有效权限与工作区权限中更严格的一项
```

例如全局 shell 为 `ask`，项目文件写 `allow` 仍然是 `ask`。项目可以主动收紧为 `deny`；静态 `deny` 不能在审批框中解除。需要更宽松的长期策略，由用户在全局配置中明确设置。

用户在审批界面给出的临时许可仅对当前 Session 有效，不写入任何可执行授权配置，不跨 Session 继承。排队消息开始执行时重新检查权限。

模型连接、Key、认证环境变量不能被项目配置覆盖。配置在启动时加载为只读快照，不热加载；模型通过工具改动磁盘内容不能改变当前权限与预算。日志记录有效的非敏感运行参数，用于解释当次行为。

若 Workspace 恰好是用户主目录，全局与工作区运行配置指向同一文件，只读取一次；该真实目录始终受私有目录规则保护。

---

# 10. 执行预算与超时

`maxRounds` 按 Session 重置，最后一轮无工具的回复也计入。第 40 轮若仍产生工具调用，按正常规则结算该批调用后结束为 `limit_reached`，不再启动第 41 轮；上限提示由 Harness 输出，不额外调用模型总结。

`sessionTimeoutMs` 从消息出队并开始 Session 时计时，包含权限等待、重试、工具执行与上下文压缩，不包含在 FIFO 队列中的等待。

各操作实际截止时间为自身超时与 Session 剩余时间中的较小者。取消与截止时间必须传到 Model Adapter、工具执行器及压缩器。

- 模型单次 attempt 超时由 `modelTimeoutMs` 控制。
- 暂时网络错误、429 和可重试服务端错误有限重试；最多 1 次初始请求加 `modelMaxRetries` 次重试。
- 重试采用有上限的退避，考虑服务端重试提示，但不能超过 Session 截止时间；只保留一层重试，禁用 SDK 的额外隐式重试。
- 不重试鉴权错误、无效配置或无效 schema；不能因模型重试而重复执行已经完成的工具。
- 工具默认受 `toolTimeoutMs` 限制，shell 可请求更长时间，但不超过 `shellMaxTimeoutMs` 和 Session 剩余时间。
- 单个工具超时作为工具错误交回模型；Session 总超时结束为 `limit_reached`。
- 审批等待最多 `approvalTimeoutMs`，超时拒绝该次调用；若先到 Session 截止时间则终止 Session。

进程清理允许使用额外的 `terminationGraceMs` 宽限时间。该时间用于收尾，不用于继续工作。

---

# 11. 权限模型

权限属于 Core，所有文件与 shell 操作必须经过同一个 Permission Gate，模型、Skill、Plan 和工具参数都不能跳过它。

```text
校验工具名与参数
→ 检查硬性路径/保留目录规则
→ 计算 allow / ask / deny
→ 必要时获得用户批准
→ 执行前再次校验目标与授权绑定
→ 记录执行开始
→ 执行工具
→ 记录结果
```

| 操作 | 默认策略 | 说明 |
|---|---|---|
| `read` | allow | 仅普通 Workspace 文件和明确允许的产物读取 |
| `write` / `edit` | ask | 显示目标路径、变更摘要与可展开的实际变更 |
| `shell` | ask | 显示完整命令、固定 cwd、超时，以及其使用宿主用户权限的事实 |
| `update_plan` | allow | 仅更新当前 Session 的结构化计划 |
| 越界文件访问、私有配置与日志修改 | deny | 不提供绕过硬性边界的审批选项 |

“允许一次”绑定当前 `callId`、规范化参数以及文件修改前的版本摘要。目标内容发生变化后，原批准失效，需要重新生成操作并审批。

“本 Session 允许同类操作”的范围必须直接展示：文件操作按工具类型与用户确认的目标目录授权；shell 表示允许当前 Session 的所有 shell 命令，以宿主用户权限执行。不能把它包装成仅对 Workspace 内操作的授权。

拒绝返回带原因的 `permission_denied` 工具结果。模型可改用允许的方法或回复无法继续，但不能绕过拒绝；重复请求仍消耗 Round 上限。

权限校验或审批系统异常时停止当前 Session，默认拒绝执行。不能因异常而放行。

---

# 12. 权限与 Sandbox 的边界

V0.1 提供工具调用权限与原生文件路径约束，**不提供 OS Sandbox**。

经批准的 shell 在当前 OS 用户权限下执行；cwd 只决定初始目录，不限制文件系统、网络或命令内部行为。不能通过命令关键词黑名单声称实现隔离。

因此不能承诺 shell 无法访问 Workspace 外、无法修改 Harness 文件、无法执行外部操作。`write=deny` 也不意味着“所有途径都不能写文件”：一旦批准 shell，它可能完成写入。

工具进程不主动继承 Harness 专用的 API Key 环境变量；这只是减少意外暴露，不能阻止已授权 shell 读取该用户可访问的文件。

权限说明需在 shell 审批中清晰呈现。不设计独立的命令分类器、复杂策略语言或自动危险命令推断系统。

---

# 13. 文件路径与私有数据保护

`read / write / edit` 的普通目标只能位于 Workspace Root 内。支持相对路径和落在 Workspace 内的绝对路径；不自动展开 `~`。

路径检查必须处理 `..`、路径分隔符边界、符号链接逃逸。已存在的目标解析真实路径；新文件解析最近的已存在父目录，再检查剩余路径。执行前复核，不使用单纯的 `startsWith(cwd)` 判断。

以下真实路径为 Harness 私有路径，普通文件工具不能修改，也不能常规读取：

- `~/.tiness/`，即使它落在当前 Workspace 内。
- 当前工作区 `.tiness/runtime.json` 和 `.tiness/tasks/`。
- 当前工作区 `.tiness/artifacts/` 的写入由 Harness 管理。

唯一读取例外是工具返回的、属于当前 Task 的产物引用。`read` 通过登记的产物 ID 解析真实文件并再次检查路径，不开放任意历史记录读取。

`.tiness/`、`tasks/`、`artifacts/` 及配置文件路径若通过符号链接重定向到其他位置，启动报错，避免把运行数据意外写到别处。目录与日志默认仅当前用户可访问。

上述文件检查不是对恶意并发进程的完整隔离；shell 的权限边界见第 12 节。

---

# 14. 复杂任务 Plan

Plan 是同一个 Agent 的显式工作状态，用于跨步骤任务，不是另一个 Agent 或独立规划阶段。

需要先建立 Plan 的典型情况：

- 用户明确要求计划。
- 包含多个依赖步骤、多个交付物或跨多个文件的协同修改。
- 需要“调查 → 修改 → 验证”的非简单闭环。
- 执行中发现原本简单的任务已经变成多步骤工作。

简单问答、单次读取、明确的一处小修改可以不建 Plan。复杂度由模型依据 System Prompt 判断，Harness 不引入第二个分类模型；正确使用 Plan 纳入验收。

复杂任务允许先进行必要的只读调查，但在实质修改或长时间执行前应调用 `update_plan`。每个步骤描述可检查的结果，而不是“继续思考”之类空泛活动。

```ts
update_plan({
  explanation: "先定位失败原因，再修复并验证",
  steps: [
    { id: "inspect", text: "定位项目启动失败原因", status: "in_progress" },
    { id: "fix", text: "完成必要的代码修复", status: "pending" },
    { id: "verify", text: "运行相关测试并说明结果", status: "pending" }
  ]
})
```

状态为 `pending / in_progress / completed / blocked`。步骤 ID 在 Session 内唯一，最多一个 `in_progress`，数量不超过 `plan.maxSteps`。工具接收完整的新计划，校验后替换内存投影并追加 `plan_updated`。

完成步骤、遇到阻塞或改变方法时更新 Plan。计划变更需要简短原因；测试步骤标记完成需有实际工具证据，不能把计划状态当作验证结果。

Plan 每个 Session 独立，下一条排队消息不会自动继承前一 Session 的未完成步骤。先前计划作为历史可见；当前 Plan 始终进入当前上下文。取消时保留步骤原状态，通过 Session 状态说明中断。

Plan 展示不等于执行授权；实际操作仍逐次经过 Permission Gate。

---

# 15. 上下文组成与信息层级

每轮构建当前模型输入，但不把完整 Task JSONL 原样发送给模型。

```text
System Prompt 与静态执行边界
+ 项目 AGENTS.md
+ Skill Catalog
+ 当前 Session 原始用户请求
+ 当前 Plan
+ 必要的已激活 Skill 指令
+ 已压缩历史摘要
+ 保留的近期完整交互块
```

每条原始消息只在适当位置出现一次，不能既加入“当前请求”又重复加入近期历史。Adapter 负责保持请求、响应和工具结果的合法顺序。

系统级边界与用户要求优先于项目建议；AGENTS.md 和 Skill 不能授予工具权限。文件内容、工具输出和压缩摘要是带来源的数据，不升级成系统指令。

排队但尚未开始的消息不进入上下文，也不参与当前 Session 的计划或总结。权限决策由真实权限状态计算，不从自然语言摘要恢复。

System Prompt 保持短小，明确：复杂任务使用 Plan、变更后验证、遵守权限、不绕过拒绝、工具结果可能截断、根据执行证据报告结果。

---

# 16. Token 预算与输出限制

模型输入预算定义为：

```text
inputBudget = windowTokens - maxOutputTokens - safetyMarginTokens
```

预算覆盖 instructions、历史、工具 schema、Skill 文本、协议项及必要封装开销，不只计算用户可见文本。

适配器优先使用与所配置模型匹配的 tokenizer。无法准确计数的部分按保守估计并保留余量；token 估算不是服务端保证，必须同时处理服务端输入超限。

预算受限时的优先顺序：

1. 当前用户请求、系统边界和当前 Plan 不能静默截断。
2. 保留尚未结算的调用链；不从中间裁剪协议项。
3. 压缩已完成的旧交互块。
4. 将长工具输出保存在产物文件中，只保留有边界的预览与引用。
5. 若必要内容仍放不下，明确失败并提示缩小请求或调整有效配置，不能无限压缩或直接丢失指令。

普通工具结果默认最多 `resultMaxBytes`，`read` 同时受行数限制。进入请求前还要检查 token 预算，字节上限不能替代 token 预算。

用户消息超过 `maxMessageBytes` 时不入队，保留草稿并提示分拆或使用文件。静态指令与 Skill Catalog 已超预算时在启动检查中报错，不启动一个注定无法构建上下文的 Task。

---

# 17. 历史压缩

V0.1 实现当前 Task 的上下文压缩。压缩只改变后续模型输入的投影，不删除或覆盖原始 JSONL。

当预估输入超过 `inputBudget × compactAtRatio` 时，在下一次 Agent 请求前尝试压缩，目标为不超过 `inputBudget × compactTargetRatio`。

算法：

1. 将历史划分为完整交互块：用户消息、模型协议项、对应的整批工具结果以及结算状态。
2. 优先压缩旧 Session；长 Session 内也可压缩较早且已结算的 Round，不能只等 Session 结束才处理。
3. 尽量保留最近 `recentRounds` 个完整 Round。该值是保留目标；预算不足时可继续压缩已完成的近期 Round，但不能切开调用与结果。
4. 使用同一模型发送不带工具的摘要请求，输入只包含上一份摘要与本次待折叠的历史块，不包含未消费的队列消息。
5. 摘要保留目标与约束、已完成工作、关键决定、测试证据、失败/拒绝/取消、未解决问题、文件和产物引用，并明确哪些内容是旧观察。
6. 校验摘要非空、结构可用且不超过 `summaryMaxTokens`，追加 `context_compacted` 后才替换当前历史投影。
7. 重新估算完整请求；若固定内容和未压缩块仍过大，继续有限处理或明确停止。

压缩目标是尽量达到的水位，不是必须通过反复总结才能满足的硬条件。已经没有可折叠块且输入仍在硬预算内时，允许继续；固定必要内容超过硬预算时则停止。摘要请求禁用工具，不能执行摘要中描述的行动。`summaryMaxTokens` 限制保留到上下文中的可见摘要；模型请求仍使用 `maxOutputTokens` 作为包含推理开销的生成总预算，不能把可见摘要长度直接用作推理模型的总生成上限。摘要提示明确给出可见长度目标，并在返回后校验。

一次摘要输入也必须满足同一模型窗口预算。候选历史过长时按完整交互块分批，逐批更新滚动摘要；每次模型调用都计入压缩次数限制。不能为了压缩超限输入而发送更大的摘要请求。

摘要是有损派生信息，不能证明文件仍未变化，也不能取代当前用户请求原文、权限状态和验证结果原始引用。当前请求与当前 Plan 单独保留，不靠摘要回忆；旧请求的原文仍留在 JSONL 中。

---

# 18. 压缩失败与协议完整性

每个 Session 最多执行 `maxCompactionsPerSession` 次摘要调用，每次受 `compactionTimeoutMs` 和 Session 剩余时间控制。每次调用失败也消耗该上限，摘要调用不再叠加自动模型重试。

摘要失败时保留上一份有效上下文投影：若原输入仍在硬预算内，可以继续；若已经放不下，则结束 Session 并提示原因。不能用空摘要替换历史。

如果服务端仍返回输入超限，每个 Round 最多进行 `maxInputRepairsPerRound` 次重新压缩与预算收紧后重试。修复仍失败则停止，不对同一超限请求无条件重发；相关压缩仍受 Session 压缩总次数限制。

Responses 历史中的工具调用必须有对应 `call_id` 结果。取消一批工具时，为未执行项记录明确结算结果；已完整提交的模型输出作为一个整体保留或折叠。

流式传输只展示增量，不执行未接收完整的工具参数。中途断开的部分响应作为传输诊断记录，不进入可重发的对话投影。

reasoning 等协议项由 Adapter 保留；压缩删除旧交互时按完整块一起折叠，不能只删除文本而留下孤立调用或依赖项。保留历史转为下次输入前由 Adapter 校验。

---

# 19. AGENTS.md 与 Agent Skills

启动时读取 `<workspace>/AGENTS.md`，不存在则忽略。只支持根目录文件，不搜索父目录、全局或子目录层级。启动时读取为快照，不热加载。

Skill 只发现 `<workspace>/.agents/skills/*/SKILL.md`。启动解析 frontmatter，校验规范要求的名称、描述和目录关系；有错误时指出具体文件。资源相对路径以 Skill 所在目录为基准。

渐进式加载：

```text
Catalog：name + description + location
→ read SKILL.md
→ 按需 read 资源或通过 shell 执行脚本
```

不创建 Skill 执行引擎。Skill 的脚本使用与其他 shell 命令相同的权限、超时与输出限制。格式兼容不代表已经安装 Skill 所需的外部运行环境。

`allowed-tools` 等可选元数据不会覆盖 Tiness 的权限。明确支持规范文件格式和上述发现/加载方式，不承诺执行其他产品专有字段。

为配合压缩，成功完整读取标准 Skill 路径后，Context Builder 记录本 Session 激活的 Skill 及内容摘要标识。正文仍在近期工具结果中时不重复注入；该工具结果被折叠后，才把必要正文放入已激活指令区。

若 Skill 文件需要多段读取，只有完整读取后才标记为已加载。正文超过可用预算时返回明确提示，不能把截断内容标为完整激活。下一 Session 清空激活集合，按需要重新读取。

---

# 20. 模型接口与 Responses 历史

只支持 OpenAI Responses API，使用 OpenAI SDK。保留薄 Adapter，但不建立 Provider Registry。

```ts
interface ModelAdapter {
  generate(input: ModelInput, signal: AbortSignal): Promise<ModelOutput>
}

interface ModelOutput {
  status: "completed" | "incomplete" | "failed"
  text: string
  toolCalls: ToolCall[]
  protocolItems: unknown[] // 由 Adapter 校验、序列化与重建，Loop 不解析内部字段
  usage?: { inputTokens: number; outputTokens: number }
  reason?: string
}
```

实际实现可使用 SDK 类型约束协议项。不能只保存 `text + toolCalls` 而丢掉 reasoning 或结果关联所需字段。

每轮发送当前本地上下文投影，不依赖 `previous_response_id` 或远端 Conversation。明确使用 `store: false`，保留所选模型无状态续传需要的协议数据。

只有完整接收且可验证的响应才能触发工具。`incomplete`、空的无工具响应、解析失败不能当作正常 Final Answer；V0.1 返回明确的 Session 失败结果，保留已有可见文本并标为不完整，不执行其中的工具调用。

正常无工具文本回复可结束 Session；拒绝或无法完成也需要显示真实内容。工具名称未知或参数非法时生成匹配该调用 ID 的工具错误，让模型在预算内修正。

模型与配置在进程内固定，不支持 `/model`、Model Picker 或运行时切换。

---

# 21. Tool Schema 与结果契约

使用 TypeBox 同时描述类型与 JSON Schema，并在运行时实际校验参数。适配器明确转换 Responses 支持的 schema 子集；strict 模式的必填、可空和额外属性规则必须测试，不能假设任意 schema 原样可用。

```ts
interface ToolContext {
  cwd: string
  signal: AbortSignal
  deadline: number
}

interface ToolResult {
  content: string
  isError?: boolean
  code?: string
  truncated?: boolean
  artifactId?: string
}
```

工具返回值由执行器与原始 `callId` 绑定后持久化。工具不获取可变配置、模型实例或任意 Task Store；`update_plan` 通过限定的内置处理器更新当前计划。

所有执行路径，包括参数错误、权限拒绝、超时和取消，都形成可追踪结果。真正未开始的操作标为 `not_executed`，无法核实的副作用标为 `unknown`，不编造成功或失败。

---

# 22. read / write / edit

`read({ path, offset?, limit? })`：读取文本，offset 从 1 开始，默认读取 200 行，最多 2000 行，同时受结果字节上限限制。返回实际行范围、是否到文件尾和继续读取位置。

对于单行超过结果上限的文本，返回产物引用，并支持 `read({ artifactId, byteOffset, maxBytes })` 分段读取；两种参数形态互斥。产物读取处理 UTF-8 边界并返回下一字节位置，避免因行级分页无法读取超长单行。非文本文件明确返回不支持，不把二进制直接放入上下文。

`write({ path, content })`：创建或完整覆盖文本文件，可在 Workspace 内创建父目录，写入量不超过 `writeMaxBytes`。审批后通过同目录临时文件与原子替换提交，提交前复核原文件版本；失败清理临时文件。

`edit({ path, oldText, newText })`：精确字符串替换，拒绝空 `oldText`。0 次匹配报错，1 次匹配替换，多次匹配报错并要求提供更大上下文。不支持模糊匹配、AST 或 Diff Patch。

`edit` 同样在审批与提交之间复核原文件版本，原子提交。文件已变化时返回冲突，模型重新读取后再提出修改，不能以旧内容覆盖新变化。

文件操作的取消检查位于读取、审批、提交前等边界；已经发生的原子提交通过结果报告，不尝试自动回滚。

---

# 23. shell 与过程产物

`shell({ command, timeoutMs? })` 通过 `Bun.spawn()` 或等价底层进程 API 执行固定 `/bin/bash -c <command>`。启动检查 bash 存在；不随用户 zsh、fish 等配置切换。

cwd 固定为 Workspace Root，stdin 关闭，不支持交互式密码输入、全屏终端程序或后台任务托管。工具不能占用用户的消息输入区域。

父进程持续读取 stdout/stderr，避免管道阻塞；结果带退出码或信号、超时/取消标记和有限预览。终端展示过滤控制序列，不能让命令输出伪造输入或审批界面。

超长输出保存在 `.tiness/artifacts/<task-id>/`，通过产物 ID 返回，供当前 Task 的 `read` 分页读取。单次产物最多 `artifactMaxBytes`，达到后记录截断并继续排空、丢弃后续超量输出，不能阻塞或无限写盘。

shell 在独立受管进程组执行。取消或超时先发终止信号，宽限后强制结束并等待回收；shell 主进程正常退出也需清理其残留受管后代。下一 Session 必须等清理结束后才能开始。

不支持 daemonize 或主动逃离进程组的命令，且无 Sandbox 时不承诺控制恶意逃逸进程。不能完成受管进程清理时停止队列消费并报告错误。

原生工具不依赖 rg、fd、jq。环境已经安装的 git、grep、find、python 等可以通过 shell 使用；程序缺失作为工具错误反馈。

---

# 24. JSONL 事件与写入语义

每个 Task 使用一个追加式 JSONL，统一事件信封：

```ts
interface TaskEvent {
  version: 1
  seq: number
  time: string
  taskId: string
  type: string
  sessionId?: string
  round?: number
  messageId?: string
  callId?: string
  data: unknown
}
```

基础事件包括：

```text
 task_start / task_end
 message_queued / message_dequeued / message_abandoned
 session_start / session_end
 round_start / round_end
 model_request / model_response / model_error
 tool_call / permission_decision / tool_started / tool_result
 plan_updated / context_compacted / runtime_error
```

事件是记录，不是可注册回调的接口。记录模型用途、attempt、响应状态、用量、实际操作参数和结果；不记录 API Key。

JSONL 由单一串行写入器追加，避免输入入队事件和执行事件交错破坏行。消息被确认接收、工具开始执行、Session 结束和退出前有明确的写入确认与刷新边界。

在 `tool_started` 成功持久化前不执行有副作用的操作。操作完成后立即记录结果；若此时日志失败，停止继续执行，提示该操作可能已生效但未完整记录。

原始模型协议输出只保存一次，`tool_call` 通过索引或调用 ID 关联，不再复制整份模型响应。大输出文件是原始输出载体，JSONL 保存引用与预览；计划和压缩摘要则直接保存事件内容。

崩溃或断电可能留下尾部残行，也可能出现有开始记录而无结果的操作。文档不承诺 exactly-once 或自动恢复；用户查阅时应将这类调用视为状态不确定。进程重启创建新 Task，绝不重跑未完成记录。

---

# 25. Runtime State 与 Agent Loop

使用小型运行状态和一个串行调度器，不引入通用 State Framework。

```text
Runtime State
= 固定 cwd 与只读配置
+ 当前 Task ID 与事件写入器
+ FIFO 待处理消息
+ 当前 Session / Round / AbortController / 截止时间
+ 当前 Plan、权限临时许可、上下文投影
```

运行流程：

```text
消息入队并持久化
→ 唯一消费者取队首
→ Session Start，初始化预算、Plan 与临时权限
→ 检查取消 / 截止时间 / Round 上限
→ 构建与校验上下文，必要时有限压缩
→ Round Start
→ 模型请求，完整接收并保存协议输出
→ 检查响应状态
   ├── 正常无工具回复 → Session 正常结束
   ├── 不完整或失败 → Session 失败
   └── 工具调用 → 按顺序校验、审批、执行、记录
→ Round End
→ 继续下一轮或到达上限
→ finally：结算待执行调用、清理进程、关闭审批、写 Session End
→ 自动取下一条消息
```

只有调度器能够开始和结束 Session。模型的工具调用不能修改队列、控制命令和全局配置。

清理与记录完成前不启动下一 Session；开始下一 Session 时还需确认进程没有收到退出请求。先前 Session 的异步回调不能改写当前 Session。

---

# 26. 启动与终端责任

启动顺序：

```text
解析并固定 Workspace 真实路径
→ 加载全局模型配置、全局与工作区运行配置
→ 校验预算、权限与必需运行条件
→ 创建并检查工作区私有目录
→ 读取 AGENTS.md，发现 Skills，预检静态上下文容量
→ 初始化固定工具与权限处理器
→ 创建新 Task JSONL，记录非敏感配置快照
→ 启动终端输入与单消费者队列
```

终端至少展示当前 Session、Round/上限、正在执行的工具、当前 Plan、等待审批、排队数量、截断提示和终结状态。模型文本可流式展示，工具必须等完整模型响应后再执行。

轻量终端库的选择以能可靠支持中文输入、粘贴、输出与编辑区共存、Esc 和独立审批焦点为准；不能因为只有一个输入框就把同步 readline 当成完整运行期交互方案。

不提供旧 Task 列表、搜索、恢复或历史 UI。当前进程的输出通过滚轮、方向键和翻页键查看，Home/End 在无草稿时跳到最早/最新消息。查看历史期间新输出不强制跳回底部。工具结果默认折叠，F2 展开详情；计划保留在消息流，底部仅保留输入与快捷键提示。审批面板显示三个可选操作，支持键盘确认和鼠标点击，F2 展开完整操作与授权范围。小于 40 列 × 16 行时提示扩大窗口并暂停审批确认。

---

# 27. 错误分类

| 情况 | 行为 |
|---|---|
| 文件不存在、匹配错误、命令退出非零、工具参数错误 | 返回工具错误，让模型在预算内继续 |
| 用户拒绝或审批超时 | 不执行该调用，返回权限错误 |
| 单个工具超时 | 清理后返回工具错误 |
| Esc | 当前 Session 取消，清理后执行队列下一条 |
| Session 超时或 Round 用完 | `limit_reached`，清理后执行下一条 |
| 暂时模型故障重试耗尽、不完整响应、上下文无法容纳 | 当前 Session 失败，记录原因后执行下一条 |
| 配置错误、鉴权失败、日志不可写、内部状态损坏、清理失败 | 停止队列，退出并报告未执行消息 |

不能把“没有异常”当成任务成功，也不能把工具错误统一升级为进程崩溃。最终显示明确说明是否完成、是否验证、已知限制及已经发生的修改。

---

# 28. Bun、依赖与发行

V0.1 只支持 Bun 与 TypeScript，不兼容 Node.js Runtime。开发流程：

```bash
bun install
bun run src/cli.ts
bun test
```

主要依赖为 OpenAI SDK、TypeBox、必要的轻量终端组件；YAML 和 tokenizer 根据实际格式与模型匹配需要选择实现。不为零依赖重复编写复杂基础设施，也不引入完整 Agent 框架。

独立二进制构建：

```bash
bun build src/cli.ts --compile --outfile tiness
```

分别发布并验证 macOS/Linux 的 arm64、x64 产物。用户无需预装 Bun 或 Node，但仍需 bash、网络、模型访问凭据及任务本身依赖的外部程序。

不动态加载项目代码。启动时明确控制 Bun 对项目环境文件与配置的自动加载行为，避免隐式覆盖模型凭据和运行配置。

---

# 29. 推荐源码结构

```text
src/
├── cli.ts
├── terminal.ts
├── config.ts
├── runtime/
│   ├── agent.ts
│   ├── queue.ts
│   ├── task.ts
│   └── limits.ts
├── context/
│   ├── builder.ts
│   ├── compact.ts
│   └── budget.ts
├── model/
│   ├── types.ts
│   └── openai-responses.ts
├── permissions.ts
├── plan.ts
├── tools/
│   ├── types.ts
│   ├── registry.ts
│   ├── paths.ts
│   ├── read.ts
│   ├── write.ts
│   ├── edit.ts
│   └── shell.ts
├── skills.ts
└── storage/
    ├── task-jsonl.ts
    └── artifacts.ts
```

Plan 与 Permission 是当前闭环的固定组件。Registry 只是固定工具表，不提供运行时注册 API。文件划分可在实现时合并，不为目录形式继续拆层。

---

# 30. V0.1 验收标准

成功示例：用户请求定位项目启动失败原因并修复，Agent 在必要调查后建立 Plan，经权限许可修改代码、运行测试、根据失败继续处理，最后根据验证结果回复。所有消息、步骤、模型调用和工具结果可在工作区 JSONL 中追踪。

必须覆盖以下正常与异常路径：

| 领域 | 必须验证的行为 |
|---|---|
| 基础闭环 | 多轮读取、修改、测试失败后继续；无工具回复正确结束 |
| FIFO | 执行 A 时输入 B/C，A 清理完成后依次执行 B/C；新输入不泄漏到 A 的上下文 |
| 队列边界 | 并发输入不重复出队；队列满保留草稿；退出记录未执行消息；重启不恢复队列 |
| Esc | 模型、shell、审批、压缩、退避等待均可取消；不误取消下一 Session |
| 进程 | 超时与取消清理受管子进程；后台残留不跨 Session；清理失败停止队列 |
| 权限 | ask/deny 生效；项目配置不能降级全局权限；普通输入不被当成审批 |
| 授权绑定 | 参数或文件变化使一次批准失效；临时许可不跨 Session；校验异常不放行 |
| Plan | 复杂任务创建并更新；简单任务不强制；步骤上限、状态与验证证据正确 |
| 执行预算 | Round、总超时、单次超时、重试与压缩次数均有限且可配置 |
| 上下文 | 长 Task 与长 Session 都可压缩；摘要调用本身不超限；失败不丢历史 |
| 协议 | 多调用按 call_id 配对；reasoning 项保留；取消与截断不产生孤立调用 |
| 输入保护 | 原始当前请求和 Plan 不被静默裁剪；排队内容不进入摘要 |
| 长输出 | 字节与行数限制生效，产物能分页，超长单行有读取路径，输出不会阻塞 |
| 文件 | 符号链接逃逸、新文件父目录、保留目录、修改冲突、原子写入正确 |
| JSONL | 单写入器顺序正确，开始/结果可关联，日志失败不继续副作用操作 |
| Skills | 元数据与相对资源处理正确；激活正文不重复；权限不被 Skill 绕过 |
| 发行 | 目标平台独立运行，中文输入与 Esc 正确，无需预装 Bun/Node |

单元测试使用可控假模型验证队列、权限、预算和上下文边界；进程测试验证取消与清理；最后使用实际 Responses API 完成一次集成闭环。不以一条成功演示替代异常路径验证。

---

# 31. 设计判断原则

每项能力进入 Core 前应回答：

1. 它是否属于当前明确需要的执行闭环？
2. 能否用现有工具、文件和少量状态解决？
3. 正常、拒绝、失败、取消和超限时，行为是否都明确？
4. 它有没有引入第二份事实、隐式权限或无上限循环？
5. 用户能否从终端与 JSONL 理解实际发生了什么？

`tiness` 的极简来自固定范围与清楚契约：一个模型、一个串行执行器、一组固定工具、一套权限规则、一个有预算的上下文投影，以及当前工作区中的运行记录。

---

# 32. 协议参考

以下文档用于实现时核对协议，不代表 Tiness 提供其全部能力：

- [OpenAI Responses function calling](https://developers.openai.com/api/docs/guides/function-calling)：工具 schema、调用 ID 和结果配对。
- [OpenAI reasoning](https://developers.openai.com/api/docs/guides/reasoning)：不完整响应与无状态 reasoning 项续传。
- [Agent Skills Specification](https://agentskills.io/specification)：SKILL.md 格式与元数据。
- [Bun standalone executables](https://bun.sh/docs/bundler/executables)：独立发行与运行配置行为。
