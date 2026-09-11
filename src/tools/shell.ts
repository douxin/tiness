import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type { RuntimeConfig } from '../config';
import type { Artifacts } from '../storage/artifacts';
import { FatalError, check } from '../errors';
import type { ToolResult } from './types';

function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    if (process.platform === 'linux') {
      // An orphaned zombie cannot execute; container PID 1 may reap it late.
      let found = false;
      try {
        for (const entry of readdirSync('/proc')) {
          if (!/^\d+$/.test(entry)) continue;
          try {
            const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
            const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
            if (Number(fields[2]) === pid) { found = true; if (fields[0] !== 'Z' && fields[0] !== 'X') return true; }
          } catch { /* The process may have exited during the scan. */ }
        }
        if (found) return false;
      } catch { /* Fall back to the kernel group check. */ }
    }
    return true;
  } catch (e: any) { return e.code !== 'ESRCH'; }
}
function killGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); } catch (e: any) { if (e.code !== 'ESRCH') throw new FatalError('无法清理工具进程组'); }
}
export async function shell(command: string, cwd: string, config: RuntimeConfig, artifacts: Artifacts, signal: AbortSignal): Promise<ToolResult> {
  check(signal);
  const artifact = await artifacts.create();
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(OPENAI_API_KEY|OPENAI_ADMIN_KEY|TINESS_.*KEY|BUN_BE_BUN)$/.test(key)) delete env[key];
  const child = spawn('/bin/bash', ['-c', command], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let preview = '', previewBytes = 0, outputBytes = 0, processError: Error | undefined;
  let cleanupError: unknown;
  const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => {
    child.once('error', e => { processError = e; resolve({ code: null, signal: null }); });
    child.once('exit', (code, sig) => resolve({ code, signal: sig }));
  });
  let stopPromise: Promise<void> | undefined;
  const stop = () => stopPromise ??= (async () => {
    const pid = child.pid; if (!pid || !groupExists(pid)) return;
    killGroup(pid, 'SIGTERM');
    const end = Date.now() + config.execution.terminationGraceMs;
    while (Date.now() < end && groupExists(pid)) await new Promise(r => setTimeout(r, 25));
    if (groupExists(pid)) killGroup(pid, 'SIGKILL');
  })();
  let forcedTimer: ReturnType<typeof setTimeout> | undefined;
  let rejectStuck!: (reason: unknown) => void;
  const stuck = new Promise<never>((_, reject) => { rejectStuck = reject; });
  const abort = () => {
    void stop().catch(e => { cleanupError = e; });
    forcedTimer ??= setTimeout(() => rejectStuck(new FatalError('工具进程未能在取消宽限期内退出')), config.execution.terminationGraceMs * 2 + 1000);
  };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const consume = async (stream: Readable, label: string) => {
    const decoder = new StringDecoder('utf8');
    for await (const raw of stream) {
      const chunk = Buffer.from(raw);
      outputBytes += chunk.length;
      const room = Math.max(0, config.tools.resultMaxBytes - previewBytes);
      if (room) { const part = chunk.subarray(0, room); preview += `[${label}] ${decoder.write(part)}`; previewBytes += part.length; }
      await artifact.write(chunk);
    }
  };
  const drains = Promise.all([consume(child.stdout!, 'stdout'), consume(child.stderr!, 'stderr')]);
  // A write failure must also stop the process, rather than leave a blocked pipe.
  void drains.catch(() => { void stop().catch(e => { cleanupError = e; }); });
  let info: Awaited<ReturnType<typeof artifact.finish>> | undefined;
  try {
    const result = await Promise.race([exited, stuck]);
    await stop();
    const drainDeadline = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy(); reject(new FatalError('工具输出管道未能关闭')); }, config.execution.terminationGraceMs + 1000);
      void drains.finally(() => clearTimeout(timer)).catch(() => {});
    });
    await Promise.race([drains, drainDeadline]);
    info = await artifact.finish();
    if (cleanupError) throw cleanupError;
    if (processError) throw processError;
    // After reaping our child, ensure no live member of the managed group remains.
    if (child.pid && groupExists(child.pid)) {
      const end = Date.now() + config.execution.terminationGraceMs;
      while (Date.now() < end && groupExists(child.pid)) await new Promise(r => setTimeout(r, 25));
      if (groupExists(child.pid)) throw new FatalError('受管进程组仍存在，停止后续任务');
    }
    return {
      content: `exit=${result.code} signal=${result.signal ?? 'none'} cancelled=${signal.aborted}\n${preview}\n产物 ${info.id}（${info.bytes} bytes${info.truncated ? '，已截断' : ''}）`,
      artifactId: info.id,
      truncated: outputBytes > config.tools.resultMaxBytes || info.truncated,
      isError: result.code !== 0 || signal.aborted,
      code: signal.aborted ? 'interrupted' : result.code !== 0 ? 'command_failed' : undefined,
    };
  } finally {
    signal.removeEventListener('abort', abort); clearTimeout(forcedTimer);
    await stop();
    if (!info) await artifact.finish().catch(() => {});
  }
}
