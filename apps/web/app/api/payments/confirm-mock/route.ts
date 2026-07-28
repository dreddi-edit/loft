import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { PaymentService } from "@hair-simo/core";
import { isPaymentsMockAllowed } from "../../../../lib/public-config";

const schema = z.object({
  paymentId: z.string().min(1),
});

const paymentService = new PaymentService();

export async function POST(request: NextRequest) {
  if (!isPaymentsMockAllowed()) {
    return NextResponse.json({ error: "MOCK_PAYMENTS_DISABLED" }, { status: 403 });
  }

  try {
    const body = schema.parse(await request.json());
    const payment = await paymentService.confirmPayment(body.paymentId, `mock_token_${Date.now()}`);
    return NextResponse.json({
      data: {
        paymentId: payment.id,
        status: payment.status,
        provider: "mock",
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: "MOCK_PAYMENT_FAILED", message: error instanceof Error ? error.message : "unknown error" },
      { status: 400 },
    );
  }
}
