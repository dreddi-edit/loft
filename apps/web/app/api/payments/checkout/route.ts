import { NextRequest, NextResponse } from "next/server";
import { PaymentService, PricingService } from "@hair-simo/core";

const pricingService = new PricingService();
const paymentService = new PaymentService();

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const pricing = await pricingService.getPricing({
      serviceSlug: String(body.serviceSlug),
      depositPercentage: Number(body.depositPercentage ?? 30),
    });

    const checkout = await paymentService.createCheckout(body, pricing);

    return NextResponse.json({
      data: {
        paymentId: checkout.paymentId,
        amountCents: checkout.amountCents,
        googlePayRequest: checkout.googlePayRequest,
        provider: checkout.provider,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: "PAYMENT_CHECKOUT_FAILED", message: error instanceof Error ? error.message : "unknown error" },
      { status: 400 },
    );
  }
}
