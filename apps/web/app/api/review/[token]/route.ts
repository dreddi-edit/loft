import { ReviewRequestService } from "@hair-simo/core";
import { NextResponse } from "next/server";
import { z } from "zod";
import { HttpError } from "../../../../lib/api-errors";
import { apiRoute, type RouteParams } from "../../../../lib/api-handler";

const reviewService = new ReviewRequestService();

const paramsSchema = z.object({
  token: z.string().trim().min(1).max(256),
});

type ReviewParams = RouteParams & { token: string };

const REVIEW_ERRORS: Record<string, string> = {
  INVALID_REVIEW_TOKEN: "This review link is invalid or has expired.",
  REVIEW_REQUEST_NOT_FOUND: "This review request no longer exists.",
};

export const GET = apiRoute<unknown, undefined, ReviewParams>(
  {
    route: "/api/review/[token]",
    methods: ["GET"],
    policy: "publicRead",
  },
  async ({ params, log }) => {
    const { token } = paramsSchema.parse(params);

    try {
      const result = await reviewService.recordClick(token);
      if (result.firstClick) {
        log.info("review link opened", {
          requestId: result.requestId,
          appointmentId: result.appointmentId,
        });
      }
      return NextResponse.redirect(result.redirectUrl, { status: 302 });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      const message = REVIEW_ERRORS[error.message];
      if (!message) throw error;
      throw new HttpError("NOT_FOUND", {
        message,
        cause: error,
        logMessage: error.message,
      });
    }
  },
);
