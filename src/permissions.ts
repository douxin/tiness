import { dirname } from 'node:path';
import type { Operation, RuntimeConfig } from './config';
import { abortable, check, scopedSignal, TimeoutError } from './errors';
import { within } from './tools/paths';

export interface ApprovalRequest { callId: string; operation: Operation; target: string; detail: string; scope: string }
export type ApprovalChoice = 'once' | 'session' | 'deny';
export type Approver = (request: ApprovalRequest, signal: AbortSignal) => Promise<ApprovalChoice>;
export class Permissions {
  private grants: { operation: Operation; directory: string }[] = [];
  constructor(private config: RuntimeConfig, private approve: Approver) {}
  async decide(request: Omit<ApprovalRequest, 'scope'>, signal: AbortSignal): Promise<{ allowed: boolean; choice: string; scope: string }> {
    check(signal);
    const policy = this.config.permissions[request.operation];
    const directory = request.operation === 'shell' ? '*' : dirname(request.target);
    const scope = request.operation === 'shell'
      ? '本 Session 的所有 shell 命令，使用宿主用户权限（无沙箱）'
      : `本 Session 的 ${request.operation} 操作：${directory} 及子目录`;
    if (policy === 'deny') return { allowed: false, choice: 'deny', scope };
    if (policy === 'allow' || this.grants.some(g => g.operation === request.operation && (g.directory === '*' || within(g.directory, request.target))))
      return { allowed: true, choice: policy === 'allow' ? 'allow' : 'session_grant', scope };
    const timeout = scopedSignal(signal, this.config.execution.approvalTimeoutMs, new TimeoutError('审批超时'));
    try {
      const choice = await abortable(this.approve({ ...request, scope }, timeout.signal), timeout.signal);
      check(signal);
      if (!['once', 'session', 'deny'].includes(choice)) throw new Error('无效的审批结果');
      if (choice === 'session') this.grants.push({ operation: request.operation, directory });
      return { allowed: choice !== 'deny', choice, scope };
    } catch (error) {
      check(signal);
      if (timeout.signal.aborted) return { allowed: false, choice: 'approval_timeout', scope };
      throw error;
    } finally { timeout.dispose(); }
  }
}
