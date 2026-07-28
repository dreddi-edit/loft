import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@hair-simo/db";
import { PaymentService } from "@hair-simo/core";

const webhookSchema = z.object({
  paymentId: z.string().min(1),
  status: z.enum(["succeeded", "failed", "refunded"]),
  googlePayToken: z.string().optional(),
  providerReference: z.string().optional(),
});

const paymentService = new PaymentService();

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const expectedSecret = process.env.GCP_PAYMENT_WEBHOOK_SECRET;
  if (expectedSecret && authHeader !== `Bearer ${expectedSecret}`) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }

  try {
    const body = webhookSchema.parse(await request.json());

    if (body.status === "succeeded" && body.googlePayToken) {
      await paymentService.confirmPayment(body.paymentId, body.googlePayToken);
    } else {
      await prisma.payment.update({
        where: { id: body.paymentId },
        data: {
          status: body.status === "succeeded" ? "paid" : body.status,
          providerIntentId: body.providerReference ?? undefined,
        },
      });
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    return NextResponse.json(
      { error: "WEBHOOK_FAILED", message: error instanceof Error ? error.message : "unknown error" },
      { status: 400 },
    );
  }
}
