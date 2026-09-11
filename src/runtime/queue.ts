import type { Config } from '../config';
import type { ModelAdapter } from '../model/types';
import { TaskStore } from '../storage/task-jsonl';
import { Agent, type AgentUI, type QueuedMessage } from './agent';
import { Paths } from '../tools/paths';
import { discoverSkills } from '../skills';
import { CancelledError, FatalError, message } from '../errors';

export class Runtime {
  private queue: QueuedMessage[] = [];
  private sequence = 0;
  private admission: Promise<unknown> = Promise.resolve();
  private pumping?: Promise<void>;
  private controller?: AbortController;
  private stopping = false;
  private switching = false;
  private closing?: Promise<void>;
  private store!: TaskStore;
  private agent!: Agent;
  private knowledge!: Awaited<ReturnType<typeof discoverSkills>>;
  fatalError?: string;
  constructor(private config: Config, private model: ModelAdapter, private ui: AgentUI, private onQueue: (length: number) => void = () => {}, private onFatal: () => void = () => {}) {}
  get busy() { return !!this.pumping || !!this.controller || this.switching; }
  get pending() { return this.queue.length; }
  get taskFile() { return this.store?.file ?? '(Task 尚未创建)'; }
  async init(): Promise<void> {
    this.knowledge = await discoverSkills(new Paths(this.config.cwd, this.config.home));
    await this.createTask();
  }
  private async createTask(): Promise<void> {
    this.store = new TaskStore(this.config.cwd, [this.config.connection.apiKey]);
    await this.store.init(this.config.runtime);
    try { this.agent = new Agent(this.config, this.model, this.store, this.knowledge.skills, this.knowledge.agents, this.ui); }
    catch (e) { await this.store.close('startup_failed'); throw e; }
    this.ui.report(`Task 已创建：${this.store.file}`);
  }
  submit(text: string): Promise<boolean> {
    const operation = this.admission.then(async () => {
      if (!text.trim()) return false;
      if (this.stopping || this.switching) { this.ui.report('正在关闭或切换 Task，消息未接收'); return false; }
      if (this.queue.length >= this.config.runtime.queue.maxPendingMessages || Buffer.byteLength(text) > this.config.runtime.queue.maxMessageBytes) {
        this.ui.report('消息未提交：队列已满或消息超过大小上限。输入草稿已保留。'); return false;
      }
      const entry = { id: crypto.randomUUID(), seq: ++this.sequence, text };
      await this.store.append('message_queued', { queueSeq: entry.seq, content: text }, { messageId: entry.id });
      if (this.stopping) { await this.store.append('message_abandoned', { reason: 'shutdown', content: text }, { messageId: entry.id }); return false; }
      this.queue.push(entry); this.onQueue(this.queue.length);
      if (this.controller || this.pumping) this.ui.report(`已排队 #${entry.seq}（等待 ${this.queue.length} 条）`);
      this.kick(); return true;
    });
    this.admission = operation.catch(e => this.fail(e));
    return operation.catch(() => false);
  }
  private fail(error: unknown) {
    this.fatalError = message(error); this.stopping = true;
    this.controller?.abort(new FatalError(this.fatalError));
    this.ui.report(`运行停止：${this.fatalError}`); this.onFatal();
  }
  private kick() {
    if (this.pumping || this.stopping) return;
    const work = this.pump();
    this.pumping = work;
    void work.catch(e => this.fail(e)).finally(() => {
      if (this.pumping === work) this.pumping = undefined;
      if (this.queue.length && !this.stopping) this.kick();
    });
  }
  private async pump(): Promise<void> {
    while (this.queue.length && !this.stopping) {
      const item = this.queue.shift()!; this.onQueue(this.queue.length);
      this.controller = new AbortController();
      try {
        await this.store.append('message_dequeued', { queueSeq: item.seq }, { messageId: item.id });
        await this.agent.run(item, this.controller);
      } finally { this.controller = undefined; }
    }
  }
  cancel(): void {
    if (this.controller && !this.controller.signal.aborted) {
      this.ui.status('正在取消当前请求并清理工具…'); this.controller.abort(new CancelledError('用户按 Esc 取消了当前请求'));
    }
  }
  async newTask(): Promise<boolean> {
    if (this.stopping || this.busy || this.queue.length) { this.ui.report('/new 仅在空闲且队列为空时可用'); return false; }
    this.switching = true;
    try {
      await this.admission;
      if (this.stopping || this.pumping || this.controller || this.queue.length) { this.ui.report('/new 未执行：仍有已接收的请求'); return false; }
      await this.store.close('new_task'); await this.createTask(); return true;
    }
    catch (e) { this.fail(e); return false; }
    finally { this.switching = false; }
  }
  async idle(): Promise<void> {
    await this.admission;
    while (this.pumping) { const current = this.pumping; await current.catch(() => {}); await Promise.resolve(); }
  }
  quit(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopping = true;
    this.controller?.abort(new CancelledError('退出程序，当前请求已取消'));
    this.closing = (async () => {
      await this.admission;
      await this.pumping?.catch(() => {});
      for (const item of this.queue.splice(0)) {
        this.ui.report(`未执行 #${item.seq}：${item.text}`);
        try { await this.store.append('message_abandoned', { content: item.text, queueSeq: item.seq }, { messageId: item.id }); }
        catch (e) { this.fatalError = message(e); }
      }
      this.onQueue(0);
      try { await this.store?.close('quit'); } catch (e) { this.fatalError = message(e); }
    })();
    return this.closing;
  }
}
