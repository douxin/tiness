import type { Plan } from './tools/types';
import { ToolError } from './errors';
export function validatePlan(plan: Plan, maxSteps: number): void {
  if (!plan.steps.length || plan.steps.length > maxSteps) throw new ToolError('invalid_plan', `计划需要 1–${maxSteps} 个步骤`);
  if (new Set(plan.steps.map(s => s.id)).size !== plan.steps.length) throw new ToolError('invalid_plan', '步骤 ID 必须唯一');
  if (plan.steps.filter(s => s.status === 'in_progress').length > 1) throw new ToolError('invalid_plan', '只能有一个进行中的步骤');
}
