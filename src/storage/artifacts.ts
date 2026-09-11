import { open, lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { ToolError } from '../errors';
import type { TaskStore } from './task-jsonl';

export class Artifacts {
  private ids = new Map<string, string>();
  constructor(private store: TaskStore, readonly maxBytes: number, private secrets: string[] = []) {}
  async create() {
    const id = crypto.randomUUID();
    const path = join(this.store.artifactDirectory, `${id}.txt`);
    if (await realpath(this.store.artifactDirectory) !== this.store.artifactDirectory) throw new ToolError('invalid_artifact', '产物目录已变化');
    const handle = await open(path, 'wx', 0o600);
    this.ids.set(id, path);
    let bytes = 0, truncated = false;
    let writes: Promise<void> = Promise.resolve();
    let finished = false;
    let pending = Buffer.alloc(0);
    const patterns = this.secrets.filter(Boolean).map(value => Buffer.from(value));
    const reserve = Math.max(0, ...patterns.map(value => value.length - 1));
    const persist = async (chunk: Uint8Array) => {
      const accepted = chunk.subarray(0, Math.max(0, this.maxBytes - bytes));
      if (accepted.length) { await handle.writeFile(accepted); bytes += accepted.length; }
      if (accepted.length < chunk.length) truncated = true;
    };
    const flush = async (final: boolean) => {
      const end = final ? pending.length : Math.max(0, pending.length - reserve);
      let cursor = 0;
      while (cursor < end) {
        let match = -1, length = 0;
        for (const pattern of patterns) {
          const index = pending.indexOf(pattern, cursor);
          if (index >= 0 && index < end && (match < 0 || index < match)) { match = index; length = pattern.length; }
        }
        if (match < 0) { await persist(pending.subarray(cursor, end)); cursor = end; }
        else { await persist(pending.subarray(cursor, match)); await persist(Buffer.from('[REDACTED]')); cursor = match + length; }
      }
      pending = Buffer.from(pending.subarray(cursor));
    };
    return {
      id,
      write: (chunk: Uint8Array) => writes = writes.then(async () => {
        pending = Buffer.concat([pending, chunk]);
        await flush(false);
      }),
      finish: async () => { try { await writes; if (!finished) { await flush(true); await handle.sync(); } } finally { if (!finished) { finished = true; await handle.close(); } } return { id, bytes, truncated }; },
    };
  }
  async save(text: string): Promise<string> {
    const artifact = await this.create(); await artifact.write(Buffer.from(text)); await artifact.finish(); return artifact.id;
  }
  async read(id: string, offset: number, limit: number) {
    if (limit < 4) throw new ToolError('invalid_limit', '产物 maxBytes 至少为 4，以容纳完整 UTF-8 字符');
    const path = this.ids.get(id);
    if (!path) throw new ToolError('invalid_artifact', '只可读取当前 Task 已登记的产物 ID');
    if ((await lstat(path)).isSymbolicLink() || await realpath(path) !== path)
      throw new ToolError('invalid_artifact', '产物路径已发生变化');
    const handle = await open(path, 'r');
    try {
      const size = (await handle.stat()).size;
      if (offset > size) throw new ToolError('invalid_offset', '偏移超出产物末尾');
      const buffer = Buffer.alloc(limit + 4);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      let start = 0;
      while (start < bytesRead && (buffer[start]! & 0xc0) === 0x80) start++;
      let end = Math.min(bytesRead, limit);
      if (end < bytesRead) while (end > start && (buffer[end]! & 0xc0) === 0x80) end--;
      if (end <= start && bytesRead) throw new ToolError('invalid_offset', '请使用上次返回的 UTF-8 字节位置');
      return { content: buffer.subarray(start, end).toString('utf8'), nextByteOffset: offset + end, eof: offset + end >= size, size };
    } finally { await handle.close(); }
  }
}
