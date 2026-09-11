# Tiness

一个极简的终端 Agent Harness，探索如何用清晰的设计构建可靠的 AI 执行系统。

支持 macOS 和 Linux（arm64 / x64）。Windows 用户需安装 WSL，在 Linux 环境中编译和运行。**目前不提供预编译二进制下载，请自行编译安装。**

## 编译与安装

先安装 [Bun](https://bun.sh/docs/installation)（本项目使用 1.4.2 验证），获取源码后在项目根目录执行：

```bash
bun install --frozen-lockfile
bun run build
mkdir -p "$HOME/.local/bin"
cp dist/tiness "$HOME/.local/bin/tiness"
chmod 755 "$HOME/.local/bin/tiness"
```

将下面一行加入 `~/.zshrc` 或 `~/.bashrc`，重新打开终端：

```bash
export PATH="$HOME/.local/bin:$PATH"
```

运行 `tiness --version` 确认安装成功。编译后的程序不需要另装 Bun 或 Node.js；更新源码后重新编译、安装即可。

**Windows：**以管理员身份打开 PowerShell，执行 `wsl --install`，按提示重启并完成 Linux 用户设置。随后在 WSL 的 Linux 终端中完成上述安装和下方配置。详见 [WSL 安装说明](https://learn.microsoft.com/en-us/windows/wsl/install)。

## 配置模型

创建 `~/.tiness/` 目录，在其中新建 `config.json`：

```json
{
  "baseUrl": "https://api.openai.com/v1",
  "apiKey": "你的 API Key",
  "model": "端点支持的模型名称"
}
```

模型端点需支持 Responses API、函数调用和 strict schema。环境变量 `OPENAI_API_KEY` 可覆盖配置中的 Key。

轮次、超时、上下文预算和权限均有默认值，可在 `~/.tiness/runtime.json` 中调整，参考 [配置示例](config/runtime.example.json)。项目可通过 `.tiness/runtime.json` 覆盖运行设置，但权限只能收紧。

**默认运行预算较保守**，例如上下文窗口 `context.windowTokens` 为 32768。复杂或长时间任务可能因上下文不足、轮次上限或超时而报错或提前结束。遇到这类限制，可修改 `~/.tiness/runtime.json` 中的上下文、轮次和超时参数，适当提高后重启 Tiness；上下文窗口和输出上限应与实际模型能力匹配。

## 运行

进入要操作的项目目录后启动：

```bash
cd /path/to/your/project
tiness
```

当前目录就是工作区。任务记录和工具产物保存在 `.tiness/`，建议将其加入 `.gitignore`；暂不支持旧会话恢复。

| 操作 | 用途 |
|---|---|
| Enter | 提交消息；执行中的新消息按顺序排队 |
| Esc | 中断当前请求，清理后继续处理排队消息 |
| Tab | 在消息输入与授权面板之间切换 |
| 授权面板中的方向键或 1/2/3，再按 Enter | 选择并确认授权；也可鼠标点击 |
| 滚轮 / PgUp / PgDn | 翻阅历史消息 |
| F2 | 查看工具输出或授权详情 |
| `/new` | 空闲时开始新任务 |
| `/quit` / Ctrl+C | 退出 |

默认允许读取，写入、修改和 shell 命令需要授权。**shell 没有沙箱，获准命令使用当前用户权限。**

## 开发与文档

```bash
bun run start      # 在源码目录运行
bun run typecheck  # 类型检查
bun test           # 本地测试
```

- [从零开发极简 Harness：教材与示例](教材/从零开发极简Harness/README.md)
- [设计文档](Tiness%20设计文档.md)
- [测试报告](TESTING.md)
