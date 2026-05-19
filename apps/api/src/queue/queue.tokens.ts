export const QUEUE = Symbol('QUEUE');
export const REDIS_CONNECTION = Symbol('REDIS_CONNECTION');
export const QUEUE_NAME = 'dejavas';
export const EXPIRY_JOB = 'approval.expiry_sweep';
export const AGENT_RUN_JOB = 'agent.run';

export interface AgentRunJobData {
  // The run row's UUID; the worker loads everything else from the row.
  run_id: string;
  // 'start' means the run is pending and the worker should call
  // runtime.runJob. 'resume' means it's paused and the resolved action's
  // result is already attached to the row.
  mode: 'start' | 'resume';
}
