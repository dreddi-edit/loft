/**
 * Gift vouchers / prepaid cards.
 *
 * A voucher is money the salon has already been paid for and still owes in service, so
 * every operation here is written against the two failure modes that actually cost money:
 * a code that is mis-transcribed off a paper card, and a balance that is spent twice.
 *
 * The code is designed to survive being read aloud over the phone in German and Italian
 * and written by hand on a card; see VOUCHER_CODE_ALPHABET. The balance is defended by a
 * single conditional UPDATE inside a serializable transaction, never by a read followed by
 * a write.
 */

import { randomInt } from "node:crypto";
import { prisma } from "@hair-simo/db";
import type { Voucher } from "@hair-simo/db";
import { z } from "zod";
import { withSerializationRetry } from "./repositories";
import { endOfSalonDay, parseSalonDay, salonDayKey } from "./time";

/**
 * 23 symbols, deliberately not 32 or 36.
 *
 * Removed for handwriting: `0`/`O`, `1`/`I`/`L`, `2`/`Z`, `5`/`S`, `6`/`G`, `8`/`B`,
 * `U`/`V`, `Q` (reads as `O` or `2` in a hurried hand). Of each pair only one member
 * survives, so a slip of the pen has a defined correct reading rather than two.
 *
 * Removed for speech: `N` (indistinguishable from `M` on a phone line in every one of the
 * four locales) and `E` — spoken bare it is the vowel sitting inside "be/ce/de/ge/pe/te"
 * in German and "bi/ci/di/gi/pi/ti" in Italian, which is the single worst listening
 * cluster this salon has.
 *
 * Two properties fall out of the result and both are wanted. The alphabet has 23 members,
 * a prime, which makes the check character below provably catch every single-character
 * substitution and every adjacent transposition. And the only vowels left are `A` and `Y`,
 * so a randomly generated code cannot spell a word in any of the four languages — nobody
 * ever has to hand a customer an accidentally obscene card.
 *
 * The residual risk is `3` against `B` in a very sloppy hand. That is exactly what the
 * check character is for.
 */
export const VOUCHER_CODE_ALPHABET = "3479ABCDFGHJKMPRSTVWXYZ";

/**
 * Characters that cannot be part of a code but have exactly one plausible intended
 * reading, applied before validation. The check character then verifies the guess, so an
 * aggressive repair is safe: a wrong repair fails the checksum instead of silently
 * resolving to somebody else's voucher.
 */
const VOUCHER_CODE_REPAIRS: Readonly<Record<string, string>> = {
  "2": "Z",
  "5": "S",
  "6": "G",
  "8": "B",
  U: "V",
  N: "M",
};

export const VOUCHER_CODE_DATA_LENGTH = 11;
export const VOUCHER_CODE_LENGTH = VOUCHER_CODE_DATA_LENGTH + 1;
export const VOUCHER_CODE_GROUP_SIZE = 4;

/** How many fresh codes are tried before giving up on a unique-constraint collision. */
const VOUCHER_CODE_ATTEMPTS = 8;

export const VOUCHER_MIN_CENTS = 500;
export const VOUCHER_MAX_CENTS = 200_000;

/**
 * Five years. Long enough that a card found in a drawer is still honoured, short enough
 * that the liability on the books does not run forever.
 */
export const VOUCHER_DEFAULT_VALIDITY_MONTHS = 60;

/**
 * Floor on any expiry the salon sets by hand. This is a business guard rail, NOT a legal
 * opinion: Italian law constrains how short a gift-voucher expiry may be and the owner
 * must confirm the actual minimum with their commercialista. Until then nothing shorter
 * than three years can be issued without passing `overrideMinimumValidity`, which forces
 * whoever does it to mean it.
 */
export const VOUCHER_MINIMUM_VALIDITY_MONTHS = 36;

const MONTHS_PER_YEAR = 12;
const MAX_VALIDITY_MONTHS = 1_200;

const alphabetIndex = new Map<string, number>(
  [...VOUCHER_CODE_ALPHABET].map((character, index) => [character, index]),
);

if (alphabetIndex.size !== VOUCHER_CODE_ALPHABET.length) {
  throw new Error("VOUCHER_CODE_ALPHABET contains a duplicate character.");
}

const VOUCHER_CODE_RADIX = VOUCHER_CODE_ALPHABET.length;

export type VoucherStatus = "active" | "spent" | "expired" | "inactive";

export type VoucherSummary = {
  id: string;
  code: string;
  displayCode: string;
  initialCents: number;
  remainingCents: number;
  currency: string;
  status: VoucherStatus;
  active: boolean;
  expiresAt: Date | null;
  issuedToCustomerId: string | null;
  note: string | null;
  createdAt: Date;
};

/**
 * What a customer-facing balance lookup is allowed to see. Deliberately a different shape
 * from {@link VoucherSummary}: no internal id, no `issuedToCustomerId`, no staff `note`.
 */
export type VoucherBalance = {
  code: string;
  displayCode: string;
  initialCents: number;
  remainingCents: number;
  currency: string;
  status: VoucherStatus;
  expiresAt: Date | null;
};

export type VoucherRedemptionEntry = {
  id: string;
  amountCents: number;
  appointmentId: string | null;
  paymentId: string | null;
  createdAt: Date;
};

export type VoucherDetail = VoucherSummary & {
  redeemedCents: number;
  redemptions: VoucherRedemptionEntry[];
};

export type RedemptionContext = {
  appointmentId?: string;
  paymentId?: string;
  currency?: string;
};

export type RedemptionResult = {
  redemptionId: string;
  voucherId: string;
  code: string;
  displayCode: string;
  amountCents: number;
  remainingCents: number;
  currency: string;
  /** True when this call matched an earlier redemption and changed nothing. */
  idempotent: boolean;
};

export type VoucherLiabilityRow = {
  currency: string;
  voucherCount: number;
  issuedCents: number;
  redeemedCents: number;
  outstandingCents: number;
  outstandingVoucherCount: number;
  lapsedCents: number;
};

export type VoucherLiabilityReport = {
  asOf: Date;
  rows: VoucherLiabilityRow[];
  outstandingCents: number;
};

export type VoucherExpiryPolicy = {
  defaultValidityMonths: number;
  minimumValidityMonths: number;
  description: string;
};

const issueSchema = z
  .object({
    initialCents: z.number().int().min(VOUCHER_MIN_CENTS).max(VOUCHER_MAX_CENTS),
    currency: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{3}$/)
      .default("EUR"),
    expiresAt: z.union([z.date(), z.string().datetime({ offset: true })]).nullish(),
    validityMonths: z.number().int().min(1).max(MAX_VALIDITY_MONTHS).optional(),
    issuedToCustomerId: z.string().trim().min(1).max(64).optional(),
    note: z.string().trim().max(500).optional(),
    overrideMinimumValidity: z.boolean().default(false),
  })
  .strict()
  .refine((value) => value.expiresAt === undefined || value.validityMonths === undefined, {
    message: "Pass either expiresAt or validityMonths, not both.",
  });

export type VoucherIssueInput = z.input<typeof issueSchema>;

const redemptionContextSchema = z
  .object({
    appointmentId: z.string().trim().min(1).max(64).optional(),
    paymentId: z.string().trim().min(1).max(64).optional(),
    currency: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{3}$/)
      .default("EUR"),
  })
  .strict()
  .refine((value) => value.appointmentId !== undefined || value.paymentId !== undefined, {
    message: "A redemption needs an appointmentId or a paymentId to be idempotent.",
  });

const amountSchema = z.number().int().min(1).max(VOUCHER_MAX_CENTS);

function toInstant(value: Date | string): Date {
  const instant = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(instant.getTime())) throw new Error("VOUCHER_EXPIRY_INVALID");
  return instant;
}

/**
 * Weighted checksum over a prime-sized alphabet.
 *
 * With distinct non-zero weights and a prime modulus, a substitution at position i shifts
 * the sum by `w_i * delta` which is non-zero mod 23 for any `delta != 0`, and swapping
 * neighbours shifts it by `(w_i - w_i+1) * delta` which is non-zero because the weights
 * differ by one. So every single-character typo and every adjacent transposition — the
 * two things that happen when a code is copied off a card — is caught, and a typo can
 * never turn one live voucher into another live voucher.
 */
function checksumCharacter(dataCharacters: string): string {
  let sum = 0;
  for (let index = 0; index < dataCharacters.length; index += 1) {
    const value = alphabetIndex.get(dataCharacters[index] as string);
    if (value === undefined) throw new Error("VOUCHER_CODE_MALFORMED");
    sum += (index + 2) * value;
  }
  const check = (VOUCHER_CODE_RADIX - (sum % VOUCHER_CODE_RADIX)) % VOUCHER_CODE_RADIX;
  return VOUCHER_CODE_ALPHABET[check] as string;
}

/**
 * Canonicalise anything a human might type: lower case, spaces, hyphens, and the handful
 * of characters that are not in the alphabet but have one obvious intended reading.
 */
function canonicaliseVoucherCode(raw: string): string {
  const stripped = String(raw ?? "")
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "");
  let repaired = "";
  for (const character of stripped) {
    repaired += VOUCHER_CODE_REPAIRS[character] ?? character;
  }
  return repaired;
}

/** Groups of four separated by hyphens: what goes on the printed card. */
export function formatVoucherCode(code: string): string {
  const groups: string[] = [];
  for (let index = 0; index < code.length; index += VOUCHER_CODE_GROUP_SIZE) {
    groups.push(code.slice(index, index + VOUCHER_CODE_GROUP_SIZE));
  }
  return groups.join("-");
}

/**
 * Normalise and verify a code typed by a human. Throws `VOUCHER_CODE_MALFORMED` when the
 * shape is wrong and `VOUCHER_CODE_CHECKSUM_FAILED` when the shape is right but a
 * character is wrong, which lets the UI say "check the code" instead of "unknown code".
 */
export function parseVoucherCode(raw: string): string {
  const code = canonicaliseVoucherCode(raw);
  if (code.length !== VOUCHER_CODE_LENGTH) throw new Error("VOUCHER_CODE_MALFORMED");
  for (const character of code) {
    if (!alphabetIndex.has(character)) throw new Error("VOUCHER_CODE_MALFORMED");
  }
  const data = code.slice(0, VOUCHER_CODE_DATA_LENGTH);
  if (checksumCharacter(data) !== code[VOUCHER_CODE_DATA_LENGTH]) {
    throw new Error("VOUCHER_CODE_CHECKSUM_FAILED");
  }
  return code;
}

export function isValidVoucherCode(raw: string): boolean {
  try {
    parseVoucherCode(raw);
    return true;
  } catch {
    return false;
  }
}

/**
 * `randomInt` draws uniformly from the CSPRNG with rejection sampling built in, so no
 * modulo bias creeps into the alphabet. Eleven data characters is ~49.8 bits, which is
 * what makes the public balance lookup in {@link VoucherService.balance} non-enumerable.
 */
export function generateVoucherCode(random: (max: number) => number = randomInt): string {
  let data = "";
  for (let index = 0; index < VOUCHER_CODE_DATA_LENGTH; index += 1) {
    data += VOUCHER_CODE_ALPHABET[random(VOUCHER_CODE_RADIX)] as string;
  }
  return data + checksumCharacter(data);
}

function readPositiveEnvInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_VALIDITY_MONTHS) {
    throw new Error(`Invalid ${name} "${raw}". Expected a whole number of months.`);
  }
  return parsed;
}

/** The expiry rule in force, resolved from the environment so the owner can move it. */
export function voucherExpiryPolicy(): VoucherExpiryPolicy {
  const defaultValidityMonths = readPositiveEnvInt(
    "VOUCHER_VALIDITY_MONTHS",
    VOUCHER_DEFAULT_VALIDITY_MONTHS,
  );
  const minimumValidityMonths = readPositiveEnvInt(
    "VOUCHER_MIN_VALIDITY_MONTHS",
    VOUCHER_MINIMUM_VALIDITY_MONTHS,
  );
  return {
    defaultValidityMonths,
    minimumValidityMonths,
    description:
      `Vouchers are valid for ${defaultValidityMonths} months by default and never less ` +
      `than ${minimumValidityMonths} months unless explicitly overridden. Validity ends ` +
      `at the close of the salon day, in the salon's own time zone.`,
  };
}

function daysInSalonMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Add whole months to the salon calendar day of `instant` and return the first instant at
 * which the voucher is no longer valid, i.e. the salon midnight after the anniversary day.
 * Doing the arithmetic on the salon day key rather than on the instant keeps a voucher
 * issued in July from expiring an hour early when the anniversary lands in winter time.
 */
function expiryAfterMonths(instant: Date, months: number): Date {
  const [year, month, day] = salonDayKey(instant).split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const total = year * MONTHS_PER_YEAR + (month - 1) + months;
  const targetYear = Math.floor(total / MONTHS_PER_YEAR);
  const targetMonth = (total % MONTHS_PER_YEAR) + 1;
  const targetDay = Math.min(day, daysInSalonMonth(targetYear, targetMonth));
  const key = `${String(targetYear).padStart(4, "0")}-${String(targetMonth).padStart(2, "0")}-${String(targetDay).padStart(2, "0")}`;
  return endOfSalonDay(parseSalonDay(key));
}

function voucherStatus(
  voucher: Pick<Voucher, "active" | "remainingCents" | "expiresAt">,
  now: Date,
): VoucherStatus {
  if (!voucher.active) return "inactive";
  if (voucher.expiresAt !== null && voucher.expiresAt <= now) return "expired";
  if (voucher.remainingCents <= 0) return "spent";
  return "active";
}

function toSummary(voucher: Voucher, now: Date): VoucherSummary {
  return {
    id: voucher.id,
    code: voucher.code,
    displayCode: formatVoucherCode(voucher.code),
    initialCents: voucher.initialCents,
    remainingCents: voucher.remainingCents,
    currency: voucher.currency,
    status: voucherStatus(voucher, now),
    active: voucher.active,
    expiresAt: voucher.expiresAt,
    issuedToCustomerId: voucher.issuedToCustomerId,
    note: voucher.note,
    createdAt: voucher.createdAt,
  };
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002"
  );
}

function assertRedeemable(
  voucher: Pick<Voucher, "active" | "expiresAt" | "currency" | "remainingCents">,
  amountCents: number,
  currency: string,
  now: Date,
): void {
  if (!voucher.active) throw new Error("VOUCHER_INACTIVE");
  if (voucher.expiresAt !== null && voucher.expiresAt <= now) throw new Error("VOUCHER_EXPIRED");
  if (voucher.currency.toUpperCase() !== currency) throw new Error("VOUCHER_CURRENCY_MISMATCH");
  if (voucher.remainingCents < amountCents) throw new Error("VOUCHER_INSUFFICIENT_BALANCE");
}

const SERIALIZABLE_TX_OPTIONS = {
  isolationLevel: "Serializable",
  maxWait: 5_000,
  timeout: 10_000,
} as const;

export class VoucherService {
  /**
   * Create a voucher. The code is generated, not chosen, and uniqueness comes from the
   * database's own unique index rather than from a SELECT: two tills issuing at the same
   * millisecond cannot both win, the loser sees P2002 and draws a new code.
   */
  async issue(rawInput: unknown, now = new Date()): Promise<VoucherSummary> {
    const input = issueSchema.parse(rawInput);
    const currency = input.currency.toUpperCase();
    const policy = voucherExpiryPolicy();

    let expiresAt: Date | null;
    if (input.expiresAt === null) {
      expiresAt = null;
    } else if (input.expiresAt !== undefined) {
      expiresAt = toInstant(input.expiresAt);
      if (expiresAt <= now) throw new Error("VOUCHER_EXPIRY_IN_THE_PAST");
    } else {
      expiresAt = expiryAfterMonths(now, input.validityMonths ?? policy.defaultValidityMonths);
    }

    if (expiresAt !== null && !input.overrideMinimumValidity) {
      const floor = expiryAfterMonths(now, policy.minimumValidityMonths);
      if (expiresAt < floor) throw new Error("VOUCHER_VALIDITY_TOO_SHORT");
    }

    for (let attempt = 0; attempt < VOUCHER_CODE_ATTEMPTS; attempt += 1) {
      const code = generateVoucherCode();
      try {
        const voucher = await prisma.voucher.create({
          data: {
            code,
            initialCents: input.initialCents,
            remainingCents: input.initialCents,
            currency,
            expiresAt,
            active: true,
            issuedToCustomerId: input.issuedToCustomerId ?? null,
            note: input.note ?? null,
          },
        });
        return toSummary(voucher, now);
      } catch (error) {
        if (!isUniqueConstraintViolation(error)) throw error;
      }
    }
    throw new Error("VOUCHER_CODE_GENERATION_FAILED");
  }

  /**
   * Spend part or all of a voucher.
   *
   * Why this cannot overdraw: the balance is never computed in application code and
   * written back. The only write is one statement,
   * `UPDATE Voucher SET remainingCents = remainingCents - n WHERE id = ? AND active AND
   * remainingCents >= n`, and Postgres re-evaluates that WHERE against the row it has
   * actually locked. Two concurrent redemptions of a 100 EUR voucher for 65 EUR each are
   * therefore serialised by the row lock: the first commits at 35, the second re-checks
   * `35 >= 65`, matches nothing, reports `count === 0`, and is rejected. There is no
   * window between the check and the decrement because they are the same statement.
   *
   * Serializable on top of that protects the second invariant — the idempotency lookup.
   * Reading "no redemption for this payment yet" and then inserting one is a phantom read;
   * at Serializable two racing retries conflict on the voucher row they both update and
   * one is aborted with 40001, which `withSerializationRetry` replays. The replay then
   * sees the committed redemption and returns it instead of spending again.
   */
  async redeem(
    rawCode: string,
    amountCents: number,
    context: RedemptionContext,
    now = new Date(),
  ): Promise<RedemptionResult> {
    const code = parseVoucherCode(rawCode);
    const amount = amountSchema.parse(amountCents);
    const ctx = redemptionContextSchema.parse(context);
    const currency = ctx.currency.toUpperCase();
    const idempotencyScope = ctx.paymentId
      ? { paymentId: ctx.paymentId }
      : { appointmentId: ctx.appointmentId as string };

    return withSerializationRetry(() =>
      prisma.$transaction(async (tx) => {
        const voucher = await tx.voucher.findUnique({ where: { code } });
        if (!voucher) throw new Error("VOUCHER_NOT_FOUND");

        const existing = await tx.voucherRedemption.findFirst({
          where: { voucherId: voucher.id, ...idempotencyScope },
        });
        if (existing) {
          if (existing.amountCents !== amount) {
            throw new Error("VOUCHER_REDEMPTION_AMOUNT_MISMATCH");
          }
          return {
            redemptionId: existing.id,
            voucherId: voucher.id,
            code: voucher.code,
            displayCode: formatVoucherCode(voucher.code),
            amountCents: amount,
            remainingCents: voucher.remainingCents,
            currency: voucher.currency,
            idempotent: true,
          } satisfies RedemptionResult;
        }

        assertRedeemable(voucher, amount, currency, now);

        const { count } = await tx.voucher.updateMany({
          where: { id: voucher.id, active: true, remainingCents: { gte: amount } },
          data: { remainingCents: { decrement: amount } },
        });
        if (count === 0) {
          const fresh = await tx.voucher.findUnique({
            where: { id: voucher.id },
            select: { active: true, remainingCents: true },
          });
          if (!fresh) throw new Error("VOUCHER_NOT_FOUND");
          if (!fresh.active) throw new Error("VOUCHER_INACTIVE");
          throw new Error("VOUCHER_INSUFFICIENT_BALANCE");
        }

        const redemption = await tx.voucherRedemption.create({
          data: {
            voucherId: voucher.id,
            appointmentId: ctx.appointmentId ?? null,
            paymentId: ctx.paymentId ?? null,
            amountCents: amount,
          },
        });
        const updated = await tx.voucher.findUniqueOrThrow({
          where: { id: voucher.id },
          select: { remainingCents: true, currency: true },
        });

        return {
          redemptionId: redemption.id,
          voucherId: voucher.id,
          code: voucher.code,
          displayCode: formatVoucherCode(voucher.code),
          amountCents: amount,
          remainingCents: updated.remainingCents,
          currency: updated.currency,
          idempotent: false,
        } satisfies RedemptionResult;
      }, SERIALIZABLE_TX_OPTIONS),
    );
  }

  /**
   * Customer-facing "how much is left on this card".
   *
   * Knowing a code is the whole of the bearer's claim, so the lookup cannot ask for more
   * than the code — but it must not turn into an oracle either. Three things keep it
   * closed. Malformed and checksum-failing codes are rejected in memory, so a scanner
   * never reaches the database and a per-IP limiter at the route sees the load it should.
   * A guess has to hit one live code out of 23^11 (~9.5e14) even with the checksum known,
   * because the check character is derived, not random. And the projection below carries
   * no identity: not the internal id, not `issuedToCustomerId`, not the staff `note`, so
   * a lucky guess reveals a balance and nothing about the person it was bought for.
   */
  async balance(rawCode: string, now = new Date()): Promise<VoucherBalance> {
    const code = parseVoucherCode(rawCode);
    const voucher = await prisma.voucher.findUnique({
      where: { code },
      select: {
        code: true,
        initialCents: true,
        remainingCents: true,
        currency: true,
        expiresAt: true,
        active: true,
      },
    });
    if (!voucher) throw new Error("VOUCHER_NOT_FOUND");
    return {
      code: voucher.code,
      displayCode: formatVoucherCode(voucher.code),
      initialCents: voucher.initialCents,
      remainingCents: voucher.remainingCents,
      currency: voucher.currency,
      status: voucherStatus(voucher, now),
      expiresAt: voucher.expiresAt,
    };
  }

  /** Admin view: everything on the voucher plus what it has been spent on. */
  async getVoucher(rawCode: string, now = new Date()): Promise<VoucherDetail> {
    const code = parseVoucherCode(rawCode);
    const voucher = await prisma.voucher.findUnique({
      where: { code },
      include: { redemptions: { orderBy: { createdAt: "asc" } } },
    });
    if (!voucher) throw new Error("VOUCHER_NOT_FOUND");
    const redemptions = voucher.redemptions.map((entry) => ({
      id: entry.id,
      amountCents: entry.amountCents,
      appointmentId: entry.appointmentId,
      paymentId: entry.paymentId,
      createdAt: entry.createdAt,
    }));
    return {
      ...toSummary(voucher, now),
      redeemedCents: redemptions.reduce((sum, entry) => sum + entry.amountCents, 0),
      redemptions,
    };
  }

  /**
   * Block a lost or stolen card. The balance is left untouched so the same voucher can be
   * reissued to the customer, and the reason is appended to the note because that column
   * is the only durable record on the row; the actor belongs in an AuditLog written by
   * the caller, which knows who is logged in.
   */
  async deactivate(rawCode: string, reason?: string, now = new Date()): Promise<VoucherSummary> {
    const code = parseVoucherCode(rawCode);
    const voucher = await prisma.voucher.findUnique({ where: { code } });
    if (!voucher) throw new Error("VOUCHER_NOT_FOUND");
    const trimmed = reason?.trim();
    const stamped = trimmed ? `${salonDayKey(now)} deactivated: ${trimmed}` : null;
    const note = stamped
      ? [voucher.note, stamped].filter((part): part is string => Boolean(part)).join(" | ")
      : voucher.note;
    const updated = await prisma.voucher.update({
      where: { id: voucher.id },
      data: { active: false, note },
    });
    return toSummary(updated, now);
  }

  async reactivate(rawCode: string, now = new Date()): Promise<VoucherSummary> {
    const code = parseVoucherCode(rawCode);
    const voucher = await prisma.voucher.findUnique({ where: { code } });
    if (!voucher) throw new Error("VOUCHER_NOT_FOUND");
    const updated = await prisma.voucher.update({
      where: { id: voucher.id },
      data: { active: true },
    });
    return toSummary(updated, now);
  }

  /**
   * Outstanding liability: money taken but not yet worked off, which is what the owner
   * owes at any moment and what their accountant asks for.
   *
   * `outstandingCents` counts only vouchers that are still redeemable right now. Value on
   * expired or blocked cards is reported separately as `lapsedCents` — it is no longer a
   * liability but it is not nothing either, so it stays visible rather than vanishing from
   * the report the day a card lapses.
   */
  async outstandingLiability(asOf = new Date()): Promise<VoucherLiabilityReport> {
    const [totals, live] = await Promise.all([
      prisma.voucher.groupBy({
        by: ["currency"],
        _sum: { initialCents: true, remainingCents: true },
        _count: { _all: true },
      }),
      prisma.voucher.groupBy({
        by: ["currency"],
        where: {
          active: true,
          remainingCents: { gt: 0 },
          OR: [{ expiresAt: null }, { expiresAt: { gt: asOf } }],
        },
        _sum: { remainingCents: true },
        _count: { _all: true },
      }),
    ]);

    const liveByCurrency = new Map(live.map((row) => [row.currency, row]));
    const rows = totals
      .map((row) => {
        const liveRow = liveByCurrency.get(row.currency);
        const issuedCents = row._sum.initialCents ?? 0;
        const unspentCents = row._sum.remainingCents ?? 0;
        const outstandingCents = liveRow?._sum.remainingCents ?? 0;
        return {
          currency: row.currency,
          voucherCount: row._count._all,
          issuedCents,
          redeemedCents: issuedCents - unspentCents,
          outstandingCents,
          outstandingVoucherCount: liveRow?._count._all ?? 0,
          lapsedCents: unspentCents - outstandingCents,
        } satisfies VoucherLiabilityRow;
      })
      .sort((a, b) => a.currency.localeCompare(b.currency));

    return {
      asOf,
      rows,
      outstandingCents: rows.reduce((sum, row) => sum + row.outstandingCents, 0),
    };
  }
}
