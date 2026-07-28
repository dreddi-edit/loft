import { z } from "zod";

const gcpConfigSchema = z.object({
  projectId: z.string().min(1),
  region: z.string().default("europe-west6"),
  vertexLocation: z.string().default("europe-west1"),
  geminiModel: z.string().default("gemini-2.5-flash"),
  dialogflowAgentId: z.string().optional(),
  dialogflowLocation: z.string().default("europe-west1"),
  pubsubTopicNotifications: z.string().default("hair-simo-notifications"),
  cloudTasksQueue: z.string().default("hair-simo-tasks"),
  cloudTasksHandlerUrl: z.string().optional(),
  firebaseProjectId: z.string().optional(),
  ttsVoiceDe: z.string().default("de-DE-Chirp3-HD-Charon"),
  ttsVoiceIt: z.string().default("it-IT-Chirp3-HD-Charon"),
  ttsVoiceFr: z.string().default("fr-FR-Chirp3-HD-Charon"),
  ttsVoiceEn: z.string().default("en-US-Chirp3-HD-Charon"),
  sttLanguageCodes: z.array(z.string()).default(["de-DE", "it-IT", "fr-FR", "en-US"]),
});

export type GcpConfig = z.infer<typeof gcpConfigSchema>;

let cachedConfig: GcpConfig | null = null;

export function isGcpConfigured(): boolean {
  return Boolean(process.env.GCP_PROJECT_ID);
}

export function getGcpConfig(): GcpConfig {
  if (cachedConfig) return cachedConfig;
  const projectId = process.env.GCP_PROJECT_ID;
  if (!projectId) {
    throw new Error("GCP_PROJECT_ID_MISSING");
  }
  cachedConfig = gcpConfigSchema.parse({
    projectId,
    region: process.env.GCP_REGION,
    vertexLocation: process.env.GCP_VERTEX_LOCATION,
    geminiModel: process.env.GCP_GEMINI_MODEL,
    dialogflowAgentId: process.env.GCP_DIALOGFLOW_AGENT_ID,
    dialogflowLocation: process.env.GCP_DIALOGFLOW_LOCATION,
    pubsubTopicNotifications: process.env.GCP_PUBSUB_TOPIC_NOTIFICATIONS,
    cloudTasksQueue: process.env.GCP_CLOUD_TASKS_QUEUE,
    cloudTasksHandlerUrl: process.env.GCP_CLOUD_TASKS_HANDLER_URL,
    firebaseProjectId: process.env.GCP_FIREBASE_PROJECT_ID ?? projectId,
    ttsVoiceDe: process.env.GCP_TTS_VOICE_DE,
    ttsVoiceIt: process.env.GCP_TTS_VOICE_IT,
    ttsVoiceFr: process.env.GCP_TTS_VOICE_FR,
    ttsVoiceEn: process.env.GCP_TTS_VOICE_EN,
    sttLanguageCodes: process.env.GCP_STT_LANGUAGE_CODES?.split(",").map((code) => code.trim()),
  });
  return cachedConfig;
}

export function getTtsVoiceForLocale(locale: "de" | "it" | "fr" | "en"): string {
  const config = isGcpConfigured() ? getGcpConfig() : null;
  const defaults = {
    de: "de-DE-Chirp3-HD-Charon",
    it: "it-IT-Chirp3-HD-Charon",
    fr: "fr-FR-Chirp3-HD-Charon",
    en: "en-US-Chirp3-HD-Charon",
  };
  if (!config) return defaults[locale];
  return (
    {
      de: config.ttsVoiceDe,
      it: config.ttsVoiceIt,
      fr: config.ttsVoiceFr,
      en: config.ttsVoiceEn,
    }[locale] ?? defaults[locale]
  );
}
