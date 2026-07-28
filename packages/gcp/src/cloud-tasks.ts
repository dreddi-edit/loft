import { CloudTasksClient } from "@google-cloud/tasks";
import { getGcpConfig, isGcpConfigured } from "./config";

export type TaskPayload = {
  type: string;
  data: Record<string, unknown>;
};

let tasksClient: CloudTasksClient | null = null;

function getClient(): CloudTasksClient {
  if (!tasksClient) {
    tasksClient = new CloudTasksClient();
  }
  return tasksClient;
}

export async function enqueueTask(payload: TaskPayload, scheduleSeconds = 0): Promise<{ enqueued: boolean; taskName?: string }> {
  if (!isGcpConfigured()) {
    console.info("[cloud-tasks:local]", payload);
    return { enqueued: true, taskName: `local-${Date.now()}` };
  }

  const config = getGcpConfig();
  const handlerUrl = config.cloudTasksHandlerUrl;
  if (!handlerUrl) {
    console.info("[cloud-tasks:no-handler]", payload);
    return { enqueued: false };
  }

  const parent = getClient().queuePath(config.projectId, config.region, config.cloudTasksQueue);
  const taskSecret = process.env.GCP_CLOUD_TASKS_SECRET;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (taskSecret) {
    headers.Authorization = `Bearer ${taskSecret}`;
  }

  const [task] = await getClient().createTask({
    parent,
    task: {
      httpRequest: {
        httpMethod: "POST",
        url: handlerUrl,
        headers,
        body: Buffer.from(JSON.stringify(payload)).toString("base64"),
      },
      scheduleTime: scheduleSeconds
        ? { seconds: Math.floor(Date.now() / 1000) + scheduleSeconds }
        : undefined,
    },
  });

  return { enqueued: true, taskName: task.name ?? undefined };
}
