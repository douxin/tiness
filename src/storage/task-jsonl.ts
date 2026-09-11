import { mkdir, lstat, open, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { FatalError, redact } from '../errors';

export async function privateDirectory(path: string): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }); } catch (e: any) { if (e.code !== 'EEXIST') throw e; }
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== resolve(path))
    throw new FatalError(`私有目录无效或包含符号链接：${path}`);
}
export interface EventContext { sessionId?: string; round?: number; messageId?: string; callId?: string }
export class TaskStore {
  readonly id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`;
  private handle!: FileHandle;
  private tail: Promise<unknown> = Promise.resolve();
  private seq = 0;
  private failed = false;
  private closed = false;
  constructor(readonly cwd: string, private secrets: string[] = []) {}
  get artifactDirectory() { return join(this.cwd, '.tiness/artifacts', this.id); }
  get file() { return join(this.cwd, '.tiness/tasks', `${this.id}.jsonl`); }
  async init(config: unknown): Promise<void> {
    for (const dir of ['.tiness', '.tiness/tasks', '.tiness/artifacts']) await privateDirectory(join(this.cwd, dir));
    await privateDirectory(this.artifactDirectory);
    this.handle = await open(this.file, 'ax', 0o600);
    await this.append('task_start', { config });
  }
  append(type: string, data: unknown = {}, context: EventContext = {}): Promise<void> {
    const event = { version: 1, seq: ++this.seq, time: new Date().toISOString(), taskId: this.id, type, ...context, data };
    const write = this.tail.then(async () => {
      if (this.failed || this.closed) throw new FatalError('Task 日志不可写，已停止执行');
      try {
        await this.handle.writeFile(redact(JSON.stringify(event), this.secrets) + '\n');
        await this.handle.sync();
      } catch { this.failed = true; throw new FatalError('Task 日志写入失败，已停止执行；记录可能不完整'); }
    });
    this.tail = write.catch(() => {});
    return write;
  }
  async close(reason: string): Promise<void> {
    if (this.closed) return;
    try { await this.append('task_end', { reason }); }
    finally { await this.tail; this.closed = true; await this.handle?.close(); }
  }
}
