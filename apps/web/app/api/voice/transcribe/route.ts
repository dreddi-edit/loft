import { z } from "zod";
import { apiRoute } from "../../../../lib/api-handler";

/**
 * Speech-to-Text `recognize` only accepts short utterances anyway, so one megabyte is
 * already generous for a salon question. The cap matters because it is enforced while the
 * body streams in: the previous version called `Buffer.from(await blob.arrayBuffer())` on
 * whatever arrived, which lets one request exhaust the Cloud Run instance memory.
 */
const MAX_AUDIO_UPLOAD_BYTES = 1_048_576;

const transcribeSchema = z.object({
  audio: z.instanceof(Blob),
  encoding: z.enum(["LINEAR16", "OGG_OPUS", "MP3", "WEBM_OPUS"]).default("WEBM_OPUS"),
  sampleRateHertz: z.coerce.number().int().min(8_000).max(48_000).default(48_000),
});

export const POST = apiRoute<z.infer<typeof transcribeSchema>>(
  {
    route: "/api/voice/transcribe",
    methods: ["POST"],
    policy: "voice",
    accept: ["form"],
    uploadLimitBytes: MAX_AUDIO_UPLOAD_BYTES,
    schema: transcribeSchema,
  },
  async ({ body }) => {
    const audioContent = Buffer.from(await body.audio.arrayBuffer());
    const { transcribeAudio } = await import("@hair-simo/gcp/speech-to-text");
    return {
      data: await transcribeAudio({
        audioContent,
        encoding: body.encoding,
        sampleRateHertz: body.sampleRateHertz,
      }),
    };
  },
);
