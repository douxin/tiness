import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { FatalError } from './errors';
import { Paths } from './tools/paths';
export interface Skill { name: string; description: string; path: string }
export async function discoverSkills(paths: Paths): Promise<{ agents: string; skills: Skill[] }> {
  let agents = '';
  try {
    const path = await paths.target('AGENTS.md');
    if ((await stat(path)).size > 1024 * 1024) throw new FatalError('AGENTS.md 超过 1 MiB，请精简后启动');
    agents = await readFile(path, 'utf8');
  } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
  let entries;
  try { entries = await readdir(join(paths.cwd, '.agents/skills'), { withFileTypes: true }); }
  catch (e: any) { if (e.code === 'ENOENT') return { agents, skills: [] }; throw e; }
  const skills: Skill[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const input = join('.agents/skills', entry.name, 'SKILL.md');
    let content: string, path: string;
    try {
      path = await paths.target(input);
      if ((await stat(path)).size > 1024 * 1024) throw new Error('SKILL.md 超过 1 MiB');
      content = await readFile(path, 'utf8');
    } catch (e: any) { if (e.code === 'ENOENT') continue; throw new FatalError(`Skill 文件不可读：${input}`); }
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
    if (!frontmatter) throw new FatalError(`Skill 缺少 frontmatter：${input}`);
    let metadata: any;
    try { metadata = parse(frontmatter[1]!, { maxAliasCount: 10 }); } catch { throw new FatalError(`Skill YAML 无效：${input}`); }
    if (typeof metadata?.name !== 'string' || metadata.name !== entry.name || metadata.name.length > 64
      || !/^[\p{Ll}\p{Lo}\p{N}]+(?:-[\p{Ll}\p{Lo}\p{N}]+)*$/u.test(metadata.name)
      || typeof metadata.description !== 'string' || !metadata.description.trim() || metadata.description.length > 1024)
      throw new FatalError(`Skill name/description 无效：${input}`);
    if (metadata.compatibility !== undefined && (typeof metadata.compatibility !== 'string' || metadata.compatibility.length < 1 || metadata.compatibility.length > 500))
      throw new FatalError(`Skill compatibility 无效：${input}`);
    if (metadata.metadata !== undefined && (!metadata.metadata || typeof metadata.metadata !== 'object' || Array.isArray(metadata.metadata) || Object.values(metadata.metadata).some(v => typeof v !== 'string')))
      throw new FatalError(`Skill metadata 必须是字符串映射：${input}`);
    skills.push({ name: metadata.name, description: metadata.description, path });
  }
  return { agents, skills };
}
export class ActiveSkills {
  private parts = new Map<string, { hash: string; text: string; next: number }>();
  private active = new Map<string, { text: string; blockIds: Set<string> }>();
  constructor(private catalog: Skill[]) {}
  read(path: string, slice: { text: string; offset: number; end: number; eof: boolean; hash: string }, blockId: string): void {
    if (!this.catalog.some(s => s.path === path)) return;
    if (slice.offset === 1) this.parts.set(path, { hash: slice.hash, text: '', next: 1 });
    const part = this.parts.get(path);
    if (!part || part.hash !== slice.hash || part.next !== slice.offset) { this.parts.delete(path); this.active.delete(path); return; }
    if (slice.offset === 1) this.active.delete(path);
    part.text += slice.text; part.next = slice.end + 1;
    if (Buffer.byteLength(part.text) > 1024 * 1024) { this.parts.delete(path); this.active.delete(path); return; }
    const item = this.active.get(path) ?? { text: '', blockIds: new Set<string>() };
    item.blockIds.add(blockId);
    // Keep locations for all pages, but activate only after reaching EOF.
    item.text = slice.eof ? part.text : '';
    this.active.set(path, item);
    if (slice.eof) this.parts.delete(path);
  }
  pinned(retainedIds: Set<string>): string {
    return [...this.active].filter(([, s]) => s.text && [...s.blockIds].some(id => !retainedIds.has(id)))
      .map(([path, s]) => `Skill ${path} (resource paths relative to its directory):\n${s.text}`).join('\n\n');
  }
}
