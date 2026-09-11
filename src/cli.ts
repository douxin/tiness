#!/usr/bin/env bun
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { loadConfig, defaultRuntime } from './config';
import { OpenAIResponsesAdapter } from './model/openai-responses';
import { Runtime } from './runtime/queue';
import { Terminal } from './terminal';
import { message, plain, redact } from './errors';

const args = process.argv.slice(2);
const help = `Tiness 0.1.0 — minimal terminal agent harness

Usage: tiness
       tiness --help | --version | --print-defaults

Configure ~/.tiness/config.json with {"baseUrl":"https://api.openai.com/v1","apiKey":"...","model":"..."}.
OPENAI_API_KEY overrides apiKey. Runtime defaults: ~/.tiness/runtime.json.
Workspace overrides: .tiness/runtime.json (permissions can only be tightened).

Enter submits or queues a message; Esc cancels the active request.
Tab switches approval focus; arrows or 1/2/3 select, Enter confirms.
Mouse wheel or Up/Down scroll history; F2 toggles details.
/new starts an empty Task when idle. /quit or Ctrl+C exits.
No session restoration. Records are in .tiness/tasks/. Shell has no sandbox.
`;
if (args.length) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) console.log(help);
  else if (args.length === 1 && args[0] === '--version') console.log('0.1.0');
  else if (args.length === 1 && args[0] === '--print-defaults') console.log(JSON.stringify(defaultRuntime(), null, 2));
  else { console.error('未知参数。使用 --help 查看说明。'); process.exitCode = 1; }
} else {
  let terminal: Terminal | undefined, runtime: Runtime | undefined, secrets: string[] = [];
  let exiting: Promise<void> | undefined;
  const quit = () => exiting ??= (async () => {
    try { await runtime?.quit(); }
    finally {
      terminal?.stop();
      if (runtime?.fatalError) { console.error(plain(redact(runtime.fatalError, secrets))); process.exitCode = 1; }
      if (runtime) console.log(`本次记录：${runtime.taskFile}`);
    }
  })();
  try {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('请在交互式终端运行 Tiness；--help 不需要配置。');
    await access('/bin/bash', constants.X_OK);
    const config = await loadConfig(); secrets = [config.connection.apiKey];
    terminal = new Terminal(secrets, config.runtime.queue.maxMessageBytes, config.cwd);
    runtime = new Runtime(config, new OpenAIResponsesAdapter(config.connection), terminal, n => terminal!.setQueue(n), () => { void quit(); });
    await runtime.init();
    terminal.start({ submit: text => runtime!.submit(text), cancel: () => runtime!.cancel(), newTask: () => runtime!.newTask(), quit });
    terminal.report('建议将 .tiness/ 加入当前项目 .gitignore；Tiness 不会自动修改它。');
    process.once('SIGTERM', () => { void quit(); });
    process.once('SIGINT', () => { void quit(); });
  } catch (e) {
    await quit(); console.error(plain(redact(message(e), secrets))); process.exitCode = 1;
  }
}
