import { z } from "zod";
import { apiRoute } from "../../../../lib/api-handler";

/**
 * Cloud Text-to-Speech is billed per synthesised character and this endpoint is public,
 * so the cap is the length of a spoken salon answer, not the API maximum. The previous
 * 5000 characters at the `voice` rate limit would still be a five figure character bill
 * per hour from a single address.
 */
const MAX_SYNTHESIS_CHARS = 500;
const SYNTHESIZE_BODY_LIMIT_BYTES = 4_096;

const synthesizeSchema = z.object({
  text: z.string().trim().min(1).max(MAX_SYNTHESIS_CHARS),
  locale: z.enum(["de", "it", "fr", "en"]).default("en"),
});

export const POST = apiRoute<z.infer<typeof synthesizeSchema>>(
  {
    route: "/api/voice/synthesize",
    methods: ["POST"],
    policy: "voice",
    bodyLimitBytes: SYNTHESIZE_BODY_LIMIT_BYTES,
    schema: synthesizeSchema,
  },
  async ({ body }) => {
    const { synthesizeSpeechBase64 } = await import("@hair-simo/gcp/text-to-speech");
    return { data: await synthesizeSpeechBase64(body) };
  },
);
