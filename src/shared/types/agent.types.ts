export type TaskMode = 'explain' | 'plan' | 'implement';
export type AgentRunStatus = 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled';
export type FileOperationKind = 'create' | 'edit' | 'delete' | 'rename';
export type RiskLevel = 'low' | 'medium' | 'high';

export interface AgentTask { id: string; workspaceUri: string; prompt: string; mode: TaskMode; sessionId?: string; }
export interface ToolCall { id: string; name: 'read_file' | 'search_files' | 'query_index' | 'propose_changes' | 'propose_command'; arguments: Record<string, unknown>; }
export interface ToolResult { toolCallId: string; ok: boolean; content: string; }
export interface FileOperation {
  id: string; kind: FileOperationKind; path: string; newPath?: string; content?: string;
  baseHash?: string; beforeContent?: string; risk: RiskLevel; reason?: string;
}
export interface ChangeSet { id: string; runId: string; workspaceUri: string; summary: string; operations: FileOperation[]; status: 'proposed' | 'approved' | 'rejected' | 'applied' | 'reverted' | 'failed'; createdAt: number; }
export interface CommandRequest { id: string; runId: string; workspaceUri: string; command: string; args: string[]; cwd: string; reason: string; risk: RiskLevel; status: 'pending' | 'approved' | 'rejected' | 'running' | 'completed' | 'failed' | 'cancelled'; }
export interface ApprovalDecision { id: string; subjectType: 'change_set' | 'command'; subjectId: string; approved: boolean; createdAt: number; }
export interface ValidationResult { commandId: string; exitCode: number | null; output: string; durationMs: number; }
export interface AgentRun { id: string; task: AgentTask; status: AgentRunStatus; response?: string; createdAt: number; updatedAt: number; }
export interface ModelClient { chatComplete(messages: Array<{ role: string; content: string }>): Promise<string>; }
