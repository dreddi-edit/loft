import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { PricingService } from "@hair-simo/core";
import { prisma } from "@hair-simo/db";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "sk_test_placeholder");
const pricingService = new PricingService();

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const pricing = await pricingService.getPricing({
      serviceSlug: String(body.serviceSlug),
      depositPercentage: Number(body.depositPercentage ?? 30),
    });

    const paymentMode = body.mode === "full" ? "full" : "deposit";
    const amount = paymentMode === "full" ? pricing.fullPayment.amountCents : pricing.deposit.amountCents;
    const intent = await stripe.paymentIntents.create({
      amount,
      currency: "eur",
      automatic_payment_methods: { enabled: true },
      metadata: {
        appointmentId: String(body.appointmentId ?? ""),
        mode: paymentMode,
      },
    });

    if (body.appointmentId) {
      await prisma.payment.create({
        data: {
          appointmentId: String(body.appointmentId),
          provider: "stripe",
          providerIntentId: intent.id,
          amountCents: amount,
          mode: paymentMode,
          status: "pending",
        },
      });
    }

    return NextResponse.json({
      data: {
        clientSecret: intent.client_secret,
        paymentIntentId: intent.id,
        amountCents: amount,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: "PAYMENT_INTENT_FAILED", message: error instanceof Error ? error.message : "unknown error" },
      { status: 400 },
    );
  }
}
