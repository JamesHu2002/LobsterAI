/**
 * Tech-briefing → paper-research chain provisioning.
 *
 * Auto-provisions a "科技早报论文转发" scheduled task that targets the
 * `tech-briefing-dispatcher` agent (see `createTechBriefingDispatcherAgent` in
 * main.ts). The task is disabled by default so it never fires on its own
 * schedule; it is only triggered via the completion-triggered task chain when
 * the user's tech-briefing task runs successfully.
 *
 * OpenClaw job ids are gateway-generated, so idempotency is keyed on the
 * dispatcher agent id plus a stable description marker.
 */
import {
  DeliveryMode,
  PayloadKind,
  SessionTarget,
  TechBriefingDispatcherAgentId,
  TechBriefingForwarderMarker,
  WakeMode,
} from '../../scheduledTask/constants';
import type { CronJobService } from '../../scheduledTask/cronJobService';
import type { ScheduledTaskInput } from '../../scheduledTask/types';

export const TECH_BRIEFING_DISPATCHER_AGENT_ID = TechBriefingDispatcherAgentId;

/** Stable marker embedded in the description so provisioning and UI lookups survive renames. */
export const TECH_BRIEFING_FORWARDER_MARKER = TechBriefingForwarderMarker;

export const TECH_BRIEFING_FORWARDER_NAME = '科技早报论文转发';

/** Display-only schedule; the job stays disabled so it never self-fires. */
const TECH_BRIEFING_FORWARDER_SCHEDULE: ScheduledTaskInput['schedule'] = {
  kind: 'cron',
  expr: '35 8 * * 1-5',
};

const TECH_BRIEFING_FORWARDER_MESSAGE =
  '读取今日科技早报文件（workspace 的 reports/ 目录下「科技早报-<今天日期>.md」），' +
  '提取其中提到的论文，构建提示词并交付给「论文研究协调者」（paper-coordinator）完成研究流水线。';

/**
 * Any scheduled task bound to the tech-briefing dispatcher agent counts as the
 * forwarding task (the agent is only used for this role), so provisioning never
 * creates a duplicate next to a user-created task such as 「早报论文加工」. The
 * marker is kept in the description of the auto-provisioned default for UI lookup.
 */
function isTechBriefingForwarderTask(task: {
  agentId?: string | null;
  description?: string;
}): boolean {
  return (task.agentId ?? '').trim() === TECH_BRIEFING_DISPATCHER_AGENT_ID;
}

function buildForwarderInput(): ScheduledTaskInput {
  return {
    name: TECH_BRIEFING_FORWARDER_NAME,
    description: `${TECH_BRIEFING_FORWARDER_MARKER} 早报生成后自动触发的论文转发任务：读取当日早报，提取论文并交付论文研究协调者。`,
    enabled: false,
    schedule: TECH_BRIEFING_FORWARDER_SCHEDULE,
    sessionTarget: SessionTarget.Isolated,
    wakeMode: WakeMode.Now,
    payload: { kind: PayloadKind.AgentTurn, message: TECH_BRIEFING_FORWARDER_MESSAGE },
    delivery: { mode: DeliveryMode.None },
    agentId: TECH_BRIEFING_DISPATCHER_AGENT_ID,
  };
}

/**
 * Ensure the tech-briefing forwarding task exists. Idempotent: creates it on
 * first call, then leaves the user's edits alone. Should be invoked once the
 * OpenClaw gateway client is usable (cron.add requires the gateway).
 */
export async function ensureTechBriefingForwarderTask(
  getCronJobService: () => CronJobService,
): Promise<void> {
  const cronJobService = getCronJobService();
  try {
    const jobs = await cronJobService.listJobs();
    if (jobs.some(isTechBriefingForwarderTask)) {
      return;
    }
    const task = await cronJobService.addJob(buildForwarderInput());
    console.log(
      '[TechBriefingChain] provisioned tech-briefing forwarding task:',
      JSON.stringify({ id: task.id, name: task.name, agentId: task.agentId }),
    );
  } catch (error) {
    console.warn('[TechBriefingChain] failed to provision tech-briefing forwarding task:', error);
  }
}
