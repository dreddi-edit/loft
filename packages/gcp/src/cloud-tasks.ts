import { getGcpAccessToken } from "./access-token";
import { getGcpConfig, isGcpConfigured } from "./config";

export type TaskPayload = {
  type: string;
  data: Record<string, unknown>;
};

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

  const token = await getGcpAccessToken();
  const parent = `projects/${config.projectId}/locations/${config.region}/queues/${config.cloudTasksQueue}`;
  const taskSecret = process.env.GCP_CLOUD_TASKS_SECRET;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (taskSecret) {
    headers.Authorization = `Bearer ${taskSecret}`;
  }

  const body: Record<string, unknown> = {
    task: {
      httpRequest: {
        httpMethod: "POST",
        url: handlerUrl,
        headers,
        body: Buffer.from(JSON.stringify(payload)).toString("base64"),
      },
    },
  };

  if (scheduleSeconds > 0) {
    (body.task as Record<string, unknown>).scheduleTime = {
      seconds: Math.floor(Date.now() / 1000) + scheduleSeconds,
    };
  }

  const response = await fetch(
    `https://cloudtasks.googleapis.com/v2/${parent}/tasks`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`CLOUD_TASKS_FAILED:${response.status}:${errorText.slice(0, 300)}`);
  }

  const data = (await response.json()) as { name?: string };
  return { enqueued: true, taskName: data.name };
}
