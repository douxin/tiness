export interface ToolCall { id: string; name: string; arguments: string }
export interface ToolResult { content: string; isError?: boolean; code?: string; truncated?: boolean; artifactId?: string }
export interface Step { id: string; text: string; status: 'pending' | 'in_progress' | 'completed' | 'blocked' }
export interface Plan { explanation: string; steps: Step[] }
