export { getGcpConfig, getTtsVoiceForLocale, isGcpConfigured, type GcpConfig } from "./config";
export { runGeminiAssistant, synthesizeGeminiResponse, type GeminiResult, type GeminiToolCall } from "./vertex-ai";
export { transcribeAudio, transcribeFromGcs, type TranscriptionResult } from "./speech-to-text";
export { synthesizeSpeech, synthesizeSpeechBase64, type SynthesisResult } from "./text-to-speech";
export { publishNotificationEvent, type NotificationEvent } from "./pubsub";
export { enqueueTask, type TaskPayload } from "./cloud-tasks";
export {
  parseDialogflowWebhook,
  buildDialogflowResponse,
  buildDialogflowPlayAudioResponse,
  type DialogflowWebhookRequest,
  type DialogflowWebhookResponse,
} from "./dialogflow";

export type { IdentitySession } from "./identity-platform";

export async function verifyIdToken(...args: Parameters<(typeof import("./identity-platform"))["verifyIdToken"]>) {
  const mod = await import("./identity-platform");
  return mod.verifyIdToken(...args);
}

export async function setUserRole(...args: Parameters<(typeof import("./identity-platform"))["setUserRole"]>) {
  const mod = await import("./identity-platform");
  return mod.setUserRole(...args);
}

export async function createIdentityUser(...args: Parameters<(typeof import("./identity-platform"))["createIdentityUser"]>) {
  const mod = await import("./identity-platform");
  return mod.createIdentityUser(...args);
}

export function isIdentityPlatformConfigured() {
  return process.env.GCP_IDENTITY_PLATFORM_ENABLED === "true" && Boolean(process.env.GCP_PROJECT_ID);
}
