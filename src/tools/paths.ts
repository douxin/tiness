import { lstat, realpath, readFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import { check, ToolError } from '../errors';

export function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..' + '/') && rel !== '..' && !isAbsolute(rel));
}
async function canonical(path: string): Promise<string> {
  try { await lstat(path); return await realpath(path); }
  catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
    // A dangling symlink is not a new-file target.
    try { if ((await lstat(path)).isSymbolicLink()) throw new ToolError('invalid_path', '符号链接目标不存在'); }
    catch (s: any) { if (s.code !== 'ENOENT') throw s; }
    const parent = dirname(path);
    if (parent === path) throw e;
    return join(await canonical(parent), path.slice(parent.length + (parent === '/' ? 0 : 1)));
  }
}
export class Paths {
  constructor(readonly cwd: string, readonly home: string) {}
  async target(input: string): Promise<string> {
    if (!input || input.includes('\0') || input.startsWith('~')) throw new ToolError('invalid_path', '无效路径');
    const lexical = resolve(this.cwd, input);
    const target = await canonical(lexical);
    const privatePaths = [join(this.home, '.tiness'), join(this.cwd, '.tiness')];
    if (!within(this.cwd, lexical) || !within(this.cwd, target)
      || privatePaths.some(p => within(p, lexical) || within(p, target)))
      throw new ToolError('path_denied', '路径越界或属于 Harness 私有目录');
    if (target === this.cwd) throw new ToolError('invalid_path', '必须指定文件');
    return target;
  }
}
export interface Snapshot { content: string; hash: string; mode: number; exists: boolean }
export async function snapshot(path: string, maxBytes: number): Promise<Snapshot> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new ToolError('invalid_file', '只支持普通文本文件');
    if (stat.size > maxBytes) throw new ToolError('file_too_large', '文件超过可编辑大小，请通过其他明确授权的方法处理');
    const content = await readFile(path, 'utf8');
    if (content.includes('\0')) throw new ToolError('binary_file', '不支持二进制文件');
    return { content, hash: createHash('sha256').update(content).digest('hex'), mode: stat.mode & 0o777, exists: true };
  } catch (e: any) {
    if (e.code === 'ENOENT') return { content: '', hash: 'missing', mode: 0o644, exists: false };
    throw e;
  }
}
export async function commit(paths: Paths, input: string, expectedPath: string, before: Snapshot, content: string, maxBytes: number, signal: AbortSignal) {
  check(signal);
  if (Buffer.byteLength(content) > maxBytes) throw new ToolError('write_too_large', '写入超过大小上限');
  if (await paths.target(input) !== expectedPath) throw new ToolError('conflict', '审批后目标路径变化');
  await mkdir(dirname(expectedPath), { recursive: true });
  if (await paths.target(input) !== expectedPath) throw new ToolError('conflict', '目标父目录变化');
  const current = await snapshot(expectedPath, maxBytes);
  if (current.hash !== before.hash) throw new ToolError('conflict', '审批后文件已变化，请重新读取并申请修改');
  const temp = join(dirname(expectedPath), `.tiness-${crypto.randomUUID()}.tmp`);
  const handle = await open(temp, 'wx', before.mode);
  try {
    await handle.writeFile(content); await handle.sync(); await handle.close();
    check(signal);
    if (await paths.target(input) !== expectedPath || (await snapshot(expectedPath, maxBytes)).hash !== before.hash)
      throw new ToolError('conflict', '提交前文件或路径已变化');
    check(signal);
    await rename(temp, expectedPath);
    return { content: `已写入 ${input}（${Buffer.byteLength(content)} bytes）` };
  } finally { await handle.close().catch(() => {}); await unlink(temp).catch(() => {}); }
}
