import type { Config } from '../config';
import type { TaskStore, EventContext } from '../storage/task-jsonl';
import type { Artifacts } from '../storage/artifacts';
import type { Permissions } from '../permissions';
import type { ActiveSkills } from '../skills';
import { Paths, snapshot, commit } from './paths';
import { argumentsFor } from './schemas';
import { readText } from './read';
import { shell } from './shell';
import type { Plan, ToolCall, ToolResult } from './types';
import { validatePlan } from '../plan';
import { check, FatalError, message, scopedSignal, ToolError } from '../errors';

export class ToolExecutor {
  constructor(private config: Config, private store: TaskStore, private artifacts: Artifacts, private permissions: Permissions,
    private skills: ActiveSkills, private onPlan: (plan: Plan) => void) {}
  async execute(call: ToolCall, event: EventContext, blockId: string, signal: AbortSignal, onStarted: () => void = () => {}): Promise<ToolResult> {
    const c = this.config.runtime;
    const paths = new Paths(this.config.cwd, this.config.home);
    let args: any, target = '', before: Awaited<ReturnType<typeof snapshot>> | undefined, next = '';
    try {
      check(signal); args = argumentsFor(call.name, call.arguments);
      if (call.name === 'update_plan') {
        validatePlan(args, c.plan.maxSteps);
        await this.store.append('permission_decision', { operation: 'update_plan', allowed: true, choice: 'allow' }, event);
        await this.store.append('tool_started', { name: call.name, args }, event);
        check(signal); onStarted();
        await this.store.append('plan_updated', args, event); this.onPlan(args);
        return { content: '计划已更新' };
      }
      if (call.name === 'read') {
        const file = args.path !== null, artifact = args.artifactId !== null;
        if (file === artifact || (file && (args.byteOffset !== null || args.maxBytes !== null)) || (artifact && (args.offset !== null || args.limit !== null)))
          throw new ToolError('invalid_arguments', '请选择文件行读取或产物字节读取，不能混用');
      }
      if (['read', 'write', 'edit'].includes(call.name) && args.path) target = await paths.target(args.path);
      if (call.name === 'write' || call.name === 'edit') {
        before = await snapshot(target, c.tools.writeMaxBytes);
        if (call.name === 'edit') {
          if (!before.exists) throw new ToolError('file_not_found', '文件不存在');
          const first = before.content.indexOf(args.oldText);
          if (first < 0 || before.content.indexOf(args.oldText, first + 1) >= 0) throw new ToolError('match_error', 'oldText 必须恰好匹配一次');
          next = before.content.slice(0, first) + args.newText + before.content.slice(first + args.oldText.length);
        } else next = args.content;
        if (Buffer.byteLength(next) > c.tools.writeMaxBytes) throw new ToolError('write_too_large', '写入超过大小上限');
      }
    } catch (e) { check(signal); if (e instanceof FatalError) throw e; return { content: message(e), isError: true, code: e instanceof ToolError ? e.code : 'invalid_arguments' }; }
    const operation = call.name as 'read' | 'write' | 'edit' | 'shell';
    const detail = call.name === 'shell' ? `cwd=${this.config.cwd}\ntimeoutMs=${Math.min(args.timeoutMs ?? c.execution.toolTimeoutMs, c.execution.shellMaxTimeoutMs)}\n${args.command}\n无沙箱：命令可访问宿主用户权限允许的文件和网络。`
      : before ? `目标：${target}\n修改前 SHA256：${before.hash}\n--- 修改前完整内容 ---\n${before.content}\n--- 修改后完整内容 ---\n${next}` : `读取 ${target || `产物 ${args.artifactId}`}`;
    // Approval failures are Session failures, never converted to executable permission.
    const decision = await this.permissions.decide({ callId: call.id, operation, target: target || this.config.cwd, detail }, signal);
    await this.store.append('permission_decision', { operation, ...decision }, event);
    if (!decision.allowed) return { content: '操作未获许可', isError: true, code: 'permission_denied' };
    check(signal);
    const scope = scopedSignal(signal, call.name === 'shell' ? Math.min(args.timeoutMs ?? c.execution.toolTimeoutMs, c.execution.shellMaxTimeoutMs) : c.execution.toolTimeoutMs);
    try {
      if (target && await paths.target(args.path) !== target) throw new ToolError('conflict', '执行前目标路径已变化');
      check(scope.signal);
      await this.store.append('tool_started', { name: call.name, args }, event);
      check(scope.signal); onStarted();
      if (call.name === 'write' || call.name === 'edit') return await commit(paths, args.path, target, before!, next, c.tools.writeMaxBytes, scope.signal);
      if (call.name === 'shell') {
        const result = await shell(args.command, this.config.cwd, c, this.artifacts, scope.signal);
        if (scope.signal.aborted) result.code = signal.aborted ? 'interrupted' : 'tool_timeout';
        return result;
      }
      if (args.artifactId) {
        const result = await this.artifacts.read(args.artifactId, args.byteOffset ?? 0, Math.min(args.maxBytes ?? c.tools.resultMaxBytes - 512, c.tools.resultMaxBytes - 512));
        check(scope.signal);
        return { content: `产物 ${args.artifactId}；nextByteOffset=${result.nextByteOffset}；eof=${result.eof}；size=${result.size}\n${result.content}`, artifactId: args.artifactId, truncated: !result.eof };
      }
      const result = await readText(target, args.offset ?? 1, Math.min(args.limit ?? c.tools.readDefaultLines, c.tools.readMaxLines), c, this.artifacts, scope.signal);
      if (result.slice) this.skills.read(target, result.slice, blockId);
      const { slice: _, ...output } = result;
      return output;
    } catch (e) {
      if (e instanceof FatalError) throw e;
      return { content: message(e), isError: true, code: scope.signal.aborted ? (signal.aborted ? 'interrupted' : 'tool_timeout') : e instanceof ToolError ? e.code : 'tool_error' };
    } finally { scope.dispose(); }
  }
}
