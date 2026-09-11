import stringWidth from 'string-width';
import type { AgentUI } from './runtime/agent';
import type { ApprovalRequest, ApprovalChoice } from './permissions';
import type { Plan, ToolCall, ToolResult } from './tools/types';
import { check, plain, redact } from './errors';
import { basename } from 'node:path';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const graphemes = (text: string) => [...segmenter.segment(text)].map(s => s.segment);
export function wrap(text: string, width: number): string[] {
  width = Math.max(1, width);
  const result: string[] = [];
  for (const line of text.split('\n')) {
    let current = '', columns = 0;
    for (const part of graphemes(line.replace(/\t/g, '    '))) {
      const size = stringWidth(part);
      if (columns + size > width && current) { result.push(current); current = ''; columns = 0; }
      // Very narrow terminals cannot display a double-width glyph in one column.
      if (size > width) { current += '?'; columns++; continue; }
      current += part; columns += size;
    }
    result.push(current);
  }
  return result;
}
function fit(text: string, width: number): string {
  if (width < 1) return '';
  if (stringWidth(text) <= width) return text;
  let result = '';
  for (const part of graphemes(text)) { if (stringWidth(result + part) > width - 1) break; result += part; }
  return result + '…';
}
const padded = (text: string, width: number) => fit(text, width) + ' '.repeat(Math.max(0, width - stringWidth(fit(text, width))));
type Tone = 'normal' | 'muted' | 'user' | 'accent' | 'warning' | 'error' | 'success' | 'selected';
const tones: Record<Tone, string> = { normal: '', muted: '\x1b[2m', user: '\x1b[1;36m', accent: '\x1b[1m', warning: '\x1b[1;33m', error: '\x1b[31m', success: '\x1b[32m', selected: '\x1b[7m' };
export interface ScreenLine { text: string; tone?: Tone; dialog?: { x: number; text: string; tone?: Tone } }
interface Hitbox { x: number; y: number; width: number; choice: number }
export interface TerminalScreen { lines: ScreenLine[]; cursor?: { row: number; column: number }; compact: boolean }
interface Entry { kind: 'user' | 'assistant' | 'tool' | 'system' | 'plan'; title: string; body: string; detail?: string; error?: boolean }
export interface TerminalActions { submit(text: string): Promise<boolean>; cancel(): void; newTask(): Promise<boolean>; quit(): Promise<void> }

export class Terminal implements AgentUI {
  private history: Entry[] = [];
  private streaming = '';
  private streamTimer?: ReturnType<typeof setTimeout>;
  private draft = '';
  private cursor = 0;
  private buffer = '';
  private paste = false;
  private pasted = '';
  private pasteOverflow = false;
  private escapeTimer?: ReturnType<typeof setTimeout>;
  private active = false;
  private statusText = '就绪';
  private queue = 0;
  private viewportTop: number | null = null;
  private unread = 0;
  private lastViewport = { top: 0, total: 0, height: 1 };
  private details = false;
  private planEntry?: Entry;
  private focus: 'input' | 'approval' = 'input';
  private selected = 2;
  private approvalDetails = false;
  private detailTop = 0;
  private detailRows = 0;
  private detailHeight = 1;
  private dialogBounds?: { x: number; y: number; width: number; height: number };
  private hitboxes: Hitbox[] = [];
  private lastScreen?: TerminalScreen;
  private approval?: { request: ApprovalRequest; resolve: (choice: ApprovalChoice) => void; reject: (reason: unknown) => void; dispose: () => void };
  private actions!: TerminalActions;
  constructor(private secrets: string[], private maxMessageBytes: number, private workspace = process.cwd()) {}
  private clean(text: string) { return plain(redact(text, this.secrets)); }
  private push(entry: Entry) {
    this.history.push(entry);
    if (this.viewportTop !== null) this.unread++;
    // Retain all messages in this process. Tool payloads are already bounded by Core.
    this.render();
  }
  report(text: string): void {
    text = this.clean(text).trim();
    if (!text) return;
    if (text.startsWith('Task 已创建：')) {
      this.planEntry = undefined;
      this.push({ kind: 'system', title: '新任务已就绪', body: '', detail: text }); return;
    }
    this.push({ kind: 'system', title: '提示', body: text });
  }
  message(role: 'user' | 'assistant', text: string, requestNumber?: number): void {
    this.push({ kind: role, title: role === 'user' ? `你${requestNumber ? ` · 请求 ${requestNumber}` : ''}` : 'Tiness', body: this.clean(text).trim() });
  }
  tool(call: ToolCall, result: ToolResult): void {
    let args: any = {};
    try { args = JSON.parse(call.arguments); } catch { /* Core reports malformed arguments. */ }
    const names: Record<string, string> = { read: '读取', write: '写入', edit: '修改', shell: '运行命令', update_plan: '更新计划' };
    if (call.name === 'update_plan' && !result.isError) return;
    const target = this.clean(String(args.path ?? args.command ?? args.artifactId ?? ''));
    const detail = this.clean(result.content);
    const first = detail.split('\n')[0] ?? '';
    this.push({ kind: 'tool', title: `${result.isError ? '✗' : '✓'} ${names[call.name] ?? call.name} ${target}`, error: result.isError,
      body: result.isError ? detail.split('\n').slice(0, 4).join('\n') : call.name === 'shell' ? first.replace('cancelled=false', '').trim() : first,
      detail: target + '\n' + detail + (result.truncated ? '\n（工具结果有截断；完整保留部分可通过产物引用读取）' : '') });
  }
  complete(status: string, text: string): void {
    const labels: Record<string, string> = { completed: '本次请求已完成', cancelled: '已中断当前请求', limit_reached: '已达到执行限制', failed: '本次请求未完成' };
    this.push({ kind: 'system', title: labels[status] ?? status, body: status === 'completed' ? '' : this.clean(text), error: status === 'failed' });
  }
  stream(text: string, reset = false) {
    if (reset) { this.streaming = ''; clearTimeout(this.streamTimer); this.streamTimer = undefined; this.render(); return; }
    this.streaming += text;
    this.streamTimer ??= setTimeout(() => { this.streamTimer = undefined; this.render(); }, 40);
  }
  status(text: string) {
    this.statusText = this.clean(text).replace(/Session (\d+)/g, '请求 $1').replace(/Round (\d+)\/(\d+)/g, '第 $1/$2 轮')
      .replace('空闲', '就绪').replace(' · Tab 切换审批焦点', '')
      .replace(/ · read$/, ' · 读取文件').replace(/ · write$/, ' · 写入文件').replace(/ · edit$/, ' · 修改文件').replace(/ · shell$/, ' · 运行命令').replace(/ · update_plan$/, ' · 更新计划');
    this.render();
  }
  plan(plan?: Plan) {
    if (!plan) { this.planEntry = undefined; this.render(); return; }
    const states = { pending: '○', in_progress: '→', completed: '✓', blocked: '!' };
    const body = plan.steps.map(s => `${states[s.status]} ${s.text}`).join('\n');
    if (this.planEntry) { this.planEntry.title = `工作计划 · ${this.clean(plan.explanation)}`; this.planEntry.body = this.clean(body); this.render(); }
    else { this.planEntry = { kind: 'plan', title: `工作计划 · ${this.clean(plan.explanation)}`, body: this.clean(body) }; this.push(this.planEntry); }
  }
  setQueue(length: number) { this.queue = length; this.render(); }
  approve = async (request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalChoice> => {
    check(signal);
    if (this.approval) throw new Error('已有活动审批');
    return new Promise((resolve, reject) => {
      const abort = () => { this.closeApproval(); reject(signal.reason); };
      this.approval = { request, resolve, reject, dispose: () => signal.removeEventListener('abort', abort) };
      // Preserve a draft already being typed. Otherwise bring the decision to the foreground.
      this.focus = this.draft ? 'input' : 'approval'; this.selected = 2;
      this.approvalDetails = false; this.detailTop = 0;
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      this.render();
    });
  };
  private closeApproval() {
    this.approval?.dispose(); this.approval = undefined; this.focus = 'input'; this.hitboxes = []; this.dialogBounds = undefined; this.render();
  }
  private choose(index: number) {
    if (!this.approval || this.lastScreen?.compact) return;
    const approval = this.approval;
    const choice = (['once', 'session', 'deny'] as const)[index]!;
    this.closeApproval();
    this.push({ kind: 'system', title: ['已允许本次操作', '已允许本请求中的同类操作', '已拒绝本次操作'][index]!, body: this.clean(approval.request.target) });
    approval.resolve(choice);
  }
  start(actions: TerminalActions): void {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Tiness 需要交互式终端');
    this.actions = actions; this.active = true;
    process.stdin.setEncoding('utf8'); process.stdin.setRawMode(true); process.stdin.resume();
    process.stdout.write('\x1b[?1049h\x1b[?2004h\x1b[?1000h\x1b[?1006h');
    process.stdin.on('data', this.data); process.stdout.on('resize', this.resize);
    this.render();
  }
  stop(): void {
    if (!this.active) return;
    this.active = false; clearTimeout(this.escapeTimer); clearTimeout(this.streamTimer);
    process.stdin.off('data', this.data); process.stdout.off('resize', this.resize);
    process.stdin.setRawMode(false); process.stdin.pause();
    process.stdout.write('\x1b[?1000l\x1b[?1006l\x1b[?2004l\x1b[?25h\x1b[?1049l');
  }
  private resize = () => this.render();
  private data = (chunk: string | Buffer) => {
    this.buffer += chunk.toString(); clearTimeout(this.escapeTimer);
    while (this.buffer.length) {
      if (this.paste) {
        const end = this.buffer.indexOf('\x1b[201~');
        if (end < 0) {
          const keep = Math.min(5, this.buffer.length);
          this.pasted += this.buffer.slice(0, -keep || undefined); this.buffer = this.buffer.slice(-keep);
          if (Buffer.byteLength(this.pasted) > this.maxMessageBytes) { this.pasted = ''; this.report('粘贴内容过大，未加入输入'); this.pasteOverflow = true; }
          break;
        }
        this.pasted += this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 6);
        if (!this.pasteOverflow) { this.focus = 'input'; this.insert(plain(this.pasted.replace(/\r\n?/g, '\n'))); }
        this.pasted = ''; this.paste = false; this.pasteOverflow = false; continue;
      }
      if (this.buffer.startsWith('\x1b[200~')) { this.paste = true; this.buffer = this.buffer.slice(6); continue; }
      if (this.buffer[0] === '\x1b') {
        const match = /^\x1b(?:\[[0-?]*[ -/]*[@-~]|O[A-DHFPQRS])/.exec(this.buffer);
        if (match) { this.buffer = this.buffer.slice(match[0].length); this.key(match[0]); continue; }
        if (this.buffer === '\x1b' || /^\x1b(?:\[[0-?]*[ -/]*|O)$/.test(this.buffer)) {
          this.escapeTimer = setTimeout(() => { const independent = this.buffer === '\x1b'; this.buffer = ''; if (independent) this.actions.cancel(); }, 60); break;
        }
        this.buffer = this.buffer.slice(1); this.actions.cancel(); continue;
      }
      const part = String.fromCodePoint(this.buffer.codePointAt(0)!); this.buffer = this.buffer.slice(part.length); this.key(part);
    }
    this.render();
  };
  private insert(text: string) {
    if (Buffer.byteLength(this.draft + text) > this.maxMessageBytes) { this.report('输入超过消息大小上限，新增内容未接收'); return; }
    const parts = graphemes(this.draft), before = parts.slice(0, this.cursor).join('') + text;
    this.draft = before + parts.slice(this.cursor).join(''); this.cursor = graphemes(before).length;
  }
  private scrollHistory(delta: number) {
    const v = this.lastViewport;
    const end = Math.max(0, v.total - v.height);
    const top = Math.max(0, Math.min(end, (this.viewportTop ?? end) + delta));
    this.viewportTop = top >= end ? null : top;
    if (this.viewportTop === null) this.unread = 0;
  }
  private latest() { this.viewportTop = null; this.unread = 0; }
  private mouse(key: string): boolean {
    const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(key);
    if (!match) return false;
    const button = Number(match[1]), x = Number(match[2]) - 1, y = Number(match[3]) - 1;
    if (button & 64) {
      const delta = (button & 1) ? 3 : -3;
      const d = this.dialogBounds;
      if (this.approval && this.approvalDetails && d && x >= d.x && x < d.x + d.width && y >= d.y && y < d.y + d.height)
        this.detailTop = Math.max(0, Math.min(Math.max(0, this.detailRows - this.detailHeight), this.detailTop + delta));
      else this.scrollHistory(delta);
    } else if (button === 0 && match[4] === 'M') {
      const hit = this.hitboxes.find(h => y === h.y && x >= h.x && x < h.x + h.width);
      if (hit) this.choose(hit.choice);
    }
    return true;
  }
  private key(key: string) {
    if (key === '\x03') { void this.actions.quit(); return; }
    if (this.mouse(key)) return;
    if (key === '\t' && this.approval) { this.focus = this.focus === 'input' ? 'approval' : 'input'; return; }
    if (key === '\x1bOQ' || key === '\x1b[12~') {
      if (this.approval) { this.approvalDetails = !this.approvalDetails; this.detailTop = 0; }
      else this.details = !this.details;
      return;
    }
    if (key === '\x1b[5~' || key === '\x1b[6~') {
      const direction = key === '\x1b[5~' ? -1 : 1;
      if (this.approvalDetails && this.focus === 'approval') this.detailTop = Math.max(0, Math.min(Math.max(0, this.detailRows - this.detailHeight), this.detailTop + direction * this.detailHeight));
      else this.scrollHistory(direction * Math.max(1, this.lastViewport.height - 2));
      return;
    }
    if (key === '\x1b[1;5H') { this.viewportTop = 0; return; }
    if (key === '\x1b[1;5F') { this.latest(); return; }
    if (this.focus === 'approval' && this.approval) {
      if (['1', '2', '3'].includes(key)) { this.selected = Number(key) - 1; return; }
      if (key === '\x1b[A' || key === '\x1b[B' || key === '\x1b[C' || key === '\x1b[D') {
        const delta = key === '\x1b[A' || key === '\x1b[D' ? -1 : 1;
        if (this.approvalDetails && (key === '\x1b[A' || key === '\x1b[B')) this.detailTop = Math.max(0, Math.min(Math.max(0, this.detailRows - this.detailHeight), this.detailTop + delta));
        else this.selected = (this.selected + delta + 3) % 3;
        return;
      }
      if (key === '\r' || key === '\n') { this.choose(this.selected); return; }
      // Typing ordinary text starts a queued message rather than eating the keystroke.
      if (!key.startsWith('\x1b') && !/[\x00-\x1f\x7f]/.test(key)) this.focus = 'input';
      else return;
    }
    const parts = graphemes(this.draft);
    if (key === '\r' || key === '\n') { this.submit(); return; }
    if (key === '\x1b[A' || key === '\x1b[B') { this.scrollHistory(key === '\x1b[A' ? -1 : 1); return; }
    if (!this.draft && (key === '\x1b[H' || key === '\x1bOH' || key === '\x1b[1~')) { this.viewportTop = 0; return; }
    if (!this.draft && (key === '\x1b[F' || key === '\x1bOF' || key === '\x1b[4~')) { this.latest(); return; }
    if (key === '\x7f' || key === '\b') { if (this.cursor) parts.splice(--this.cursor, 1); }
    else if (key === '\x1b[3~') parts.splice(this.cursor, 1);
    else if (key === '\x1b[D') this.cursor = Math.max(0, this.cursor - 1);
    else if (key === '\x1b[C') this.cursor = Math.min(parts.length, this.cursor + 1);
    else if (key === '\x01' || key === '\x1b[H') this.cursor = 0;
    else if (key === '\x05' || key === '\x1b[F') this.cursor = parts.length;
    else if (key === '\x15') { parts.splice(0, this.cursor); this.cursor = 0; }
    else if (key === '\x0b') parts.splice(this.cursor);
    else if (!key.startsWith('\x1b') && !/[\x00-\x1f\x7f]/.test(key)) { this.insert(key); return; }
    this.draft = parts.join('');
  }
  private submit() {
    const text = this.draft; if (!text.trim()) return;
    this.draft = ''; this.cursor = 0; this.latest();
    const restore = () => { this.draft = text + (this.draft ? '\n' + this.draft : ''); this.cursor = graphemes(this.draft).length; this.render(); };
    if (text.trim() === '/quit') { void this.actions.quit(); return; }
    if (text.trim() === '/new') { void this.actions.newTask(); return; }
    if (text.startsWith('/')) { this.report('未知命令，只支持 /new 和 /quit'); restore(); return; }
    void this.actions.submit(text).then(ok => { if (!ok) restore(); }).catch(e => { this.report(String(e)); restore(); });
  }
  private historyLines(width: number): ScreenLine[] {
    const lines: ScreenLine[] = [];
    const append = (text: string, tone: Tone = 'normal') => { for (const line of wrap(text, width - 2)) lines.push({ text: ' ' + line, tone }); };
    for (const entry of this.history) {
      if (entry.kind === 'tool') {
        append(fit(entry.title.split('\n')[0]!, width - 2), entry.error ? 'error' : 'muted');
        const body = this.details ? entry.detail ?? entry.body : entry.body;
        if (body) append('  ' + body, entry.error ? 'error' : 'muted');
        if (!this.details) append('  F2 展开工具输出', 'muted');
      } else {
        append(entry.title, entry.kind === 'user' ? 'user' : entry.kind === 'system' ? entry.error ? 'error' : 'muted' : 'accent');
        if (entry.body) append(entry.body, entry.kind === 'system' ? 'muted' : 'normal');
        if (this.details && entry.detail) append(entry.detail, 'muted');
      }
      lines.push({ text: '' });
    }
    if (this.streaming) { append('Tiness · 正在回复', 'accent'); append(this.clean(this.streaming)); }
    if (!lines.length) { append('开始一个任务', 'accent'); append('描述你希望完成的工作。执行中仍可输入下一条消息。', 'muted'); }
    return lines;
  }
  /** Pure screen layout shared by rendering and terminal acceptance tests. Coordinates are zero based. */
  screen(columns: number, rows: number): TerminalScreen {
    const width = Math.max(1, columns - 1), height = Math.max(1, rows);
    const lines: ScreenLine[] = Array.from({ length: height }, () => ({ text: '' }));
    this.hitboxes = []; this.dialogBounds = undefined;
    if (width < 38 || height < 16) {
      const warning = ['Tiness', this.approval ? '等待授权，尚未执行' : this.statusText, '请扩大窗口至至少 40 列 × 16 行', 'Esc 中断 · Ctrl+C 退出'];
      warning.slice(0, height).forEach((text, i) => { lines[i] = { text: fit(text, width), tone: 'warning' }; });
      return this.lastScreen = { lines, compact: true };
    }
    const left = ` Tiness  ·  ${this.clean(basename(this.workspace))}`;
    const right = this.approval ? `等待授权${this.queue ? ` · ${this.queue} 条排队` : ''}` : `${this.statusText}${this.queue ? ` · ${this.queue} 条排队` : ''}`;
    const rightWidth = Math.min(stringWidth(right), Math.floor(width * 0.6));
    lines[0] = { text: padded(left, width - rightWidth - 2) + '  ' + fit(right, rightWidth), tone: this.approval ? 'warning' : 'user' };
    lines[1] = { text: '─'.repeat(width), tone: 'muted' };
    const inner = width - 4;
    const prefix = '› ';
    const before = prefix + graphemes(this.draft).slice(0, this.cursor).join('');
    const inputLines = wrap(prefix + this.draft + ' ', inner), cursorLines = wrap(before, inner);
    let inputRow = cursorLines.length - 1, inputColumn = stringWidth(cursorLines.at(-1)!);
    if (inputColumn >= inner) { inputRow++; inputColumn = 0; if (inputLines.length <= inputRow) inputLines.push(''); }
    const inputStart = Math.max(0, inputRow - 2), inputCount = Math.min(3, Math.max(1, inputLines.length));
    const footerHeight = inputCount + 4, footerTop = height - footerHeight;
    const historyHeight = footerTop - 2;
    const history = this.historyLines(width - 1);
    const end = Math.max(0, history.length - historyHeight);
    const top = this.viewportTop === null ? end : Math.min(this.viewportTop, end);
    this.lastViewport = { top, total: history.length, height: historyHeight };
    for (let i = 0; i < historyHeight; i++) {
      const content = history[top + i] ?? { text: '' };
      const thumb = history.length > historyHeight && i === Math.round((top / Math.max(1, end)) * (historyHeight - 1));
      lines[2 + i] = { ...content, text: padded(content.text, width - 1) + (thumb ? '┃' : history.length > historyHeight ? '│' : ' ') };
    }
    const indicator = this.viewportTop === null
      ? this.approval && this.focus === 'input' ? ' 正在输入新消息 · Enter 排队，Tab 返回授权 ' : this.queue ? ` ${this.queue} 条消息等待执行 ` : ' 输入消息 '
      : ` 查看历史${this.unread ? ` · ${this.unread} 条新消息` : ''} · End 回到最新 `;
    lines[footerTop] = { text: fit('─' + indicator + '─'.repeat(width), width), tone: this.viewportTop === null ? 'muted' : 'warning' };
    for (let i = 0; i < inputCount; i++) {
      const text = inputLines[inputStart + i] ?? '';
      lines[footerTop + 1 + i] = { text: '│ ' + padded(text, inner) + ' │', tone: this.focus === 'input' ? 'normal' : 'muted' };
    }
    lines[footerTop + 1 + inputCount] = { text: '└' + '─'.repeat(width - 2) + '┘', tone: 'muted' };
    lines[height - 1] = { text: fit(' Enter 提交 · Esc 中断 · ↑↓/滚轮 翻阅 · F2 详情', width), tone: 'muted' };
    let cursor = this.focus === 'input' ? { row: footerTop + 1 + inputRow - inputStart, column: 2 + inputColumn } : undefined;
    if (this.approval) {
      this.drawApproval(lines, width, footerTop);
      if (this.focus === 'approval') cursor = undefined;
    }
    return this.lastScreen = { lines, cursor, compact: false };
  }
  private drawApproval(lines: ScreenLine[], width: number, availableHeight: number) {
    const request = this.approval!.request;
    const boxWidth = Math.min(84, width - 2), inside = boxWidth - 4;
    const x = Math.floor((width - boxWidth) / 2);
    const op: Record<string, string> = { read: '读取文件', write: '写入文件', edit: '修改文件', shell: '运行命令' };
    const summary = request.operation === 'shell'
      ? this.clean(request.detail).split('\n').slice(2, -1).join('\n') || this.clean(request.detail)
      : this.clean(request.target);
    const heading = this.focus === 'approval' ? '需要你的授权' : '等待授权 · 你正在输入新消息';
    const detail = this.approvalDetails ? this.clean(request.detail) + '\n\n授权范围：' + this.clean(request.scope)
      : `${op[request.operation] ?? request.operation}\n${summary}\n${request.operation === 'shell' ? '命令使用当前用户权限，无沙箱。' : '确认后才会修改或读取上述文件。'}`;
    const body = wrap(detail, inside);
    const boxHeight = Math.min(23, availableHeight, body.length + 10);
    const y = Math.max(0, Math.floor((availableHeight - boxHeight) / 2));
    // On short terminals every option remains visible; details have their own viewport.
    const bodyHeight = Math.max(1, boxHeight - 10);
    this.detailRows = body.length; this.detailHeight = bodyHeight;
    this.detailTop = Math.min(this.detailTop, Math.max(0, body.length - bodyHeight));
    const content: { text: string; tone: Tone; choice?: number }[] = [
      { text: heading, tone: 'warning' },
      { text: '', tone: 'normal' },
      ...Array.from({ length: bodyHeight }, (_, i) => ({ text: body[this.detailTop + i] ?? '', tone: 'normal' as Tone })),
      { text: fit(this.approvalDetails ? `详情 ${this.detailTop + 1}–${Math.min(body.length, this.detailTop + bodyHeight)}/${body.length} · 滚轮/PgUp/PgDn` : body.length > bodyHeight ? '内容未完全显示 · F2 查看完整操作' : 'F2 查看完整操作与授权范围', inside), tone: 'muted' },
      ...['允许这一次', '本请求内允许同类操作', '拒绝，不执行'].map((label, index) => ({ text: `${this.selected === index ? '›' : ' '} ${index + 1}  ${label}`, tone: this.focus === 'approval' && this.selected === index ? 'selected' as Tone : 'normal' as Tone, choice: index })),
      { text: fit(this.focus === 'approval' ? '↑↓或1/2/3选择 · Enter确认 · Tab输入' : 'Enter只提交消息 · Tab返回授权', inside), tone: 'muted' },
    ];
    const actualHeight = content.length + 2;
    this.dialogBounds = { x, y, width: boxWidth, height: actualHeight };
    const set = (row: number, text: string, tone: Tone) => {
      const target = lines[row]; if (target) target.dialog = { x, text, tone };
    };
    set(y, '┌' + '─'.repeat(boxWidth - 2) + '┐', 'warning');
    content.forEach((line, i) => {
      set(y + i + 1, '│ ' + padded(line.text, inside) + ' │', line.tone);
      if (line.choice !== undefined) this.hitboxes.push({ x: x + 2, y: y + i + 1, width: inside, choice: line.choice });
    });
    set(y + content.length + 1, '└' + '─'.repeat(boxWidth - 2) + '┘', 'warning');
  }
  private render() {
    if (!this.active) return;
    const frame = this.screen(process.stdout.columns || 80, process.stdout.rows || 24);
    const rows = frame.lines.map(line => `${tones[line.tone ?? 'normal']}${line.dialog ? '' : line.text}\x1b[0m\x1b[K`);
    let output = '\x1b[?25l\x1b[H' + rows.join('\r\n');
    frame.lines.forEach((line, i) => { if (line.dialog) output += `\x1b[${i + 1};${line.dialog.x + 1}H${tones[line.dialog.tone ?? 'normal']}${line.dialog.text}\x1b[0m`; });
    if (frame.cursor) output += `\x1b[${frame.cursor.row + 1};${frame.cursor.column + 1}H\x1b[?25h`;
    process.stdout.write(output);
  }
}
