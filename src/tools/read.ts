import { open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { RuntimeConfig } from '../config';
import type { Artifacts } from '../storage/artifacts';
import { check, ToolError } from '../errors';
import type { ToolResult } from './types';

export interface ReadSlice { text: string; offset: number; end: number; eof: boolean; hash: string }
export async function readText(path: string, offset: number, limit: number, config: RuntimeConfig, artifacts: Artifacts, signal: AbortSignal): Promise<ToolResult & { slice?: ReadSlice }> {
  if (!(await lstat(path)).isFile()) throw new ToolError('invalid_file', '只支持普通文件');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const max = config.tools.resultMaxBytes - 256;
  let artifact: Awaited<ReturnType<Artifacts['create']>> | undefined;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new ToolError('invalid_file', '只支持普通文件');
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let line = 1, pending = Buffer.alloc(0), selected = '', selectedBytes = 0, end = offset - 1;
    let position = 0, eof = false, stopped = false, omitted = false;
    const finishLine = (bytes: Buffer) => {
      if (line >= offset) {
        if (selectedBytes + bytes.length > max) return false;
        selected += decoder.decode(bytes); selectedBytes += bytes.length; end = line;
      }
      line++; return true;
    };
    while (!stopped) {
      check(signal);
      const chunk = Buffer.alloc(8192);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      position += bytesRead;
      if (!bytesRead) {
        eof = true;
        if (pending.length && !finishLine(pending)) { stopped = true; omitted = true; }
        break;
      }
      const data = chunk.subarray(0, bytesRead);
      if (data.includes(0)) throw new ToolError('binary_file', '不支持二进制文件');
      let cursor = 0;
      while (cursor < data.length) {
        const newline = data.indexOf(10, cursor);
        const to = newline < 0 ? data.length : newline + 1;
        const part = data.subarray(cursor, to);
        // Lines preceding the requested offset are scanned without retaining their text.
        if (line >= offset) pending = Buffer.concat([pending, part]);
        cursor = to;
        if (pending.length > max) {
          if (selected) { stopped = true; break; }
          artifact = await artifacts.create();
          await artifact.write(pending);
          if (cursor < data.length) await artifact.write(data.subarray(cursor));
          let saved = pending.length + data.length - cursor;
          while (saved < config.tools.artifactMaxBytes) {
            check(signal);
            const rest = Buffer.alloc(Math.min(8192, config.tools.artifactMaxBytes - saved));
            const n = await handle.read(rest, 0, rest.length, position);
            if (!n.bytesRead) break;
            position += n.bytesRead; saved += n.bytesRead;
            await artifact.write(rest.subarray(0, n.bytesRead));
          }
          const info = await artifact.finish(); artifact = undefined;
          return { content: `第 ${line} 行过长。从该行起的有限片段保存在产物 ${info.id}，请用 artifactId/byteOffset 分页读取。最多保留 ${config.tools.artifactMaxBytes} bytes，可能不含全部剩余文件。`, truncated: true, artifactId: info.id };
        }
        if (newline >= 0) {
          if (!finishLine(pending)) { stopped = true; break; }
          pending = Buffer.alloc(0);
          if (line >= offset + limit) { stopped = true; eof = position === stat.size && cursor === data.length; break; }
        }
      }
    }
    if (!selected && offset > 1 && eof && line <= offset) throw new ToolError('invalid_offset', '行号超出文件范围');
    const after = await handle.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new ToolError('file_changed', '读取期间文件发生变化，请重新读取');
    const atEnd = eof && !omitted;
    return { content: `行 ${offset}–${Math.max(offset, end)}；${atEnd ? 'EOF' : `下次 offset=${Math.max(offset, end + 1)}`}\n${selected}`,
      truncated: !atEnd, slice: { text: selected, offset, end, eof: atEnd, hash: `${stat.size}:${stat.mtimeMs}` } };
  } catch (e) {
    if (e instanceof TypeError) throw new ToolError('binary_file', '文件不是有效 UTF-8 文本');
    throw e;
  } finally { await artifact?.finish().catch(() => {}); await handle.close(); }
}
