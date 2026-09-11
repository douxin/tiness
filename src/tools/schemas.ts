import { Type, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { ToolError } from '../errors';
const optional = (s: TSchema) => Type.Union([s, Type.Null()]);
const object = (properties: Record<string, TSchema>) => Type.Object(properties, { additionalProperties: false });
const integer = Type.Integer({ minimum: 1 });
export const schemas: Record<string, { description: string; parameters: TSchema }> = {
  read: {
    description: 'Read a workspace text file by 1-based lines, or a registered artifact by byte offset. For file reads set artifactId/byteOffset/maxBytes to null. For artifacts set path/offset/limit to null. All optional fields must be present as null.',
    parameters: object({ path: optional(Type.String({ minLength: 1 })), offset: optional(integer), limit: optional(integer), artifactId: optional(Type.String()), byteOffset: optional(Type.Integer({ minimum: 0 })), maxBytes: optional(integer) }),
  },
  write: { description: 'Create or replace a workspace text file. Requires permission. Existing content is checked again before atomic commit.', parameters: object({ path: Type.String({ minLength: 1 }), content: Type.String() }) },
  edit: { description: 'Replace exactly one occurrence of oldText in a workspace file. Re-read if the file changed. Requires permission.', parameters: object({ path: Type.String({ minLength: 1 }), oldText: Type.String({ minLength: 1 }), newText: Type.String() }) },
  shell: { description: 'Run noninteractive /bin/bash -c in the workspace. Requires permission; no sandbox. Do not launch daemons or background jobs. timeoutMs null uses default.', parameters: object({ command: Type.String({ minLength: 1 }), timeoutMs: optional(integer) }) },
  update_plan: { description: 'Create or replace the current Session plan for complex work. Update steps as work progresses; mark verification complete only with actual evidence.', parameters: object({ explanation: Type.String({ minLength: 1, maxLength: 2000 }), steps: Type.Array(object({ id: Type.String({ minLength: 1, maxLength: 100 }), text: Type.String({ minLength: 1, maxLength: 1000 }), status: Type.Union(['pending', 'in_progress', 'completed', 'blocked'].map(s => Type.Literal(s))) }), { minItems: 1 }) }) },
};
export const definitions = () => Object.entries(schemas).map(([name, spec]) => ({ type: 'function' as const, name, description: spec.description, parameters: spec.parameters as Record<string, unknown>, strict: true }));
export function argumentsFor(name: string, raw: string): any {
  const spec = schemas[name];
  if (!spec) throw new ToolError('unknown_tool', `未知工具：${name}`);
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new ToolError('invalid_arguments', '工具参数必须是合法 JSON'); }
  if (!Value.Check(spec.parameters, value)) throw new ToolError('invalid_arguments', [...Value.Errors(spec.parameters, value)].slice(0, 5).map(e => `${e.path}: ${e.message}`).join('; '));
  return value;
}
