/** 教学实验：无网络、无磁盘写入，演示模型请求 → 工具 → 观察 → 下一轮。 */
type Item = { kind: 'user' | 'observation'; text: string };
type Decision = { kind: 'call'; name: string; args: unknown } | { kind: 'answer'; text: string };
interface Model { generate(items: readonly Item[]): Promise<Decision> }

// 确定性替身：先请求读取，再根据观察给出答案。不是语言模型实现。
const model: Model = {
  async generate(items) {
    const observation = items.findLast(item => item.kind === 'observation');
    return observation
      ? { kind: 'answer', text: `我实际读取到：${observation.text}` }
      : { kind: 'call', name: 'read_demo', args: { path: 'demo.txt' } };
  }
};

async function execute(name: string, args: unknown): Promise<string> {
  if (name !== 'read_demo') throw new Error('未知工具');
  if (!args || typeof args !== 'object' || !('path' in args) || args.path !== 'demo.txt')
    throw new Error('仅支持读取内存中的 demo.txt');
  return 'Hello Harness';
}

async function run(text: string, maxRounds: number): Promise<string> {
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 1) throw new Error('轮次必须为正整数');
  const items: Item[] = [{ kind: 'user', text }];
  for (let round = 1; round <= maxRounds; round++) {
    const decision = await model.generate(items);
    console.log(`Round ${round}: ${decision.kind}`);
    if (decision.kind === 'answer') return decision.text;
    const output = await execute(decision.name, decision.args);
    console.log(`工具观察：${output}`);
    items.push({ kind: 'observation', text: output });
  }
  throw new Error('达到轮次上限；已执行工具，但没有获得最终回答');
}

// 参数 1 用于观察达到上限；默认 2 可以完成闭环。
try {
  console.log(await run('读取 demo.txt 并告诉我内容', Number(process.argv[2] ?? 2)));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
