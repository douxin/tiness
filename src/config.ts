import { readFile, realpath, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import defaults from './defaults.json';
import { FatalError } from './errors';

export type Policy = 'allow' | 'ask' | 'deny';
export type Operation = 'read' | 'write' | 'edit' | 'shell';
export type RuntimeConfig = Omit<typeof defaults, 'permissions'> & { permissions: Record<Operation, Policy> };
export interface Connection { baseUrl: string; apiKey: string; model: string }
export interface Config { cwd: string; home: string; connection: Connection; runtime: RuntimeConfig }
export const defaultRuntime = (): RuntimeConfig => structuredClone(defaults) as RuntimeConfig;

async function jsonFile(path: string): Promise<Record<string, unknown>> {
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new FatalError(`配置不能为符号链接：${path}`);
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('必须是 JSON 对象');
    return value;
  } catch (e: any) {
    if (e.code === 'ENOENT') return {};
    // Do not include parser excerpts: the file may contain credentials.
    throw new FatalError(`无法读取或解析配置：${path}`);
  }
}
export function mergeRuntime(global: Record<string, unknown> = {}, local: Record<string, unknown> = {}): RuntimeConfig {
  const result = defaultRuntime();
  const rank: Record<Policy, number> = { allow: 0, ask: 1, deny: 2 };
  for (const [index, layer] of [global, local].entries()) {
    for (const [section, values] of Object.entries(layer)) {
      if (!Object.hasOwn(result, section) || !values || Array.isArray(values) || typeof values !== 'object')
        throw new FatalError(`未知或无效配置分组：${section}`);
      for (const [key, value] of Object.entries(values)) {
        const target = (result as any)[section];
        if (!Object.hasOwn(target, key)) throw new FatalError(`未知配置：${section}.${key}`);
        if (section === 'permissions') {
          if (typeof value !== 'string' || !Object.hasOwn(rank, value)) throw new FatalError(`无效权限：${key}`);
          if (index === 0 || rank[value as Policy] > rank[target[key] as Policy]) target[key] = value;
        } else {
          const zeroAllowed = key === 'modelMaxRetries' || key === 'maxInputRepairsPerRound';
          const ratio = key.endsWith('Ratio');
          if (typeof value !== 'number' || !Number.isFinite(value) || value < (zeroAllowed ? 0 : Number.MIN_VALUE)
            || (!ratio && !Number.isSafeInteger(value)) || (!ratio && value > 2147483647))
            throw new FatalError(`无效数值：${section}.${key}`);
          target[key] = value;
        }
      }
    }
  }
  const c = result.context, t = result.tools, e = result.execution;
  const budget = c.windowTokens - c.maxOutputTokens - c.safetyMarginTokens;
  if (budget <= 0 || c.summaryMaxTokens >= budget || c.compactTargetRatio <= 0
    || c.compactTargetRatio >= c.compactAtRatio || c.compactAtRatio >= 1
    || t.resultMaxBytes < 1024 || t.artifactMaxBytes < t.resultMaxBytes || t.readDefaultLines > t.readMaxLines
    || e.shellMaxTimeoutMs < e.toolTimeoutMs || e.retryBaseDelayMs > e.retryMaxDelayMs)
    throw new FatalError('运行配置存在矛盾：请检查上下文预算、输出上限与超时范围');
  return result;
}
function freeze<T>(object: T): T {
  if (object && typeof object === 'object') { Object.freeze(object); for (const value of Object.values(object)) freeze(value); }
  return object;
}
export async function loadConfig(cwd = process.cwd(), home = homedir(), env = process.env): Promise<Config> {
  cwd = await realpath(cwd); home = await realpath(home);
  for (const dir of [join(home, '.tiness'), join(cwd, '.tiness')]) {
    try { if ((await lstat(dir)).isSymbolicLink()) throw new FatalError(`私有目录不能为符号链接：${dir}`); }
    catch (e: any) { if (e.code !== 'ENOENT') throw e; }
  }
  const raw = await jsonFile(join(home, '.tiness/config.json'));
  for (const key of Object.keys(raw)) if (!['baseUrl', 'apiKey', 'model'].includes(key)) throw new FatalError(`未知模型配置字段：${key}`);
  const connection = { baseUrl: raw.baseUrl ?? 'https://api.openai.com/v1', apiKey: env.OPENAI_API_KEY || raw.apiKey || '', model: raw.model || '' };
  if (Object.values(connection).some(v => typeof v !== 'string' || !v.trim()))
    throw new FatalError('请先配置 ~/.tiness/config.json 中的 model 和 apiKey（或 OPENAI_API_KEY）');
  const url = new URL(connection.baseUrl as string);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new FatalError('baseUrl 必须是不包含认证信息、查询参数或 fragment 的 HTTP(S) URL');
  const globalPath = resolve(home, '.tiness/runtime.json');
  const localPath = resolve(cwd, '.tiness/runtime.json');
  const runtime = mergeRuntime(await jsonFile(globalPath), globalPath === localPath ? {} : await jsonFile(localPath));
  return freeze({ cwd, home, runtime, connection: connection as Connection });
}
