/**
 * GDPR subject-rights tooling for a salon established in Bressanone / Brixen (IT).
 *
 * Three duties collide here and the resolution is deliberate:
 *
 * - Art. 15 / Art. 20 (access and portability) requires a complete, machine-readable
 *   copy of everything the salon holds about one person. "Complete" is enumerated from
 *   the Prisma schema, relation by relation, not guessed.
 * - Art. 17 (erasure) requires the personal data to go. It does NOT require the salon's
 *   accounting records to go, and Art. 17(3)(b) explicitly preserves processing needed
 *   to comply with a legal obligation. Italian law imposes one: Codice Civile art. 2220
 *   and DPR 633/1972 art. 39 keep invoices and accounting entries for ten years. So the
 *   implementation ANONYMISES rather than deletes — identifiers are destroyed, the
 *   financial and appointment skeleton survives without them.
 * - Art. 7(1) requires the controller to be able to demonstrate consent. Consent records
 *   therefore survive erasure too, stripped of any free-form metadata.
 *
 * Everything the erasure promises is verifiable: {@link GdprService.verifyErasure} scans
 * the database for the identifiers again and reports whatever is left.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma } from "@hair-simo/db";
import type { Prisma } from "@hair-simo/db";
import { getServiceTranslationName, resolveLocale } from "@hair-simo/i18n";
import { SALON_TIME_ZONE, formatInSalonZone, salonDayKey } from "./time";
import type {
  AppointmentStatus,
  Channel,
  CustomerNoteKind,
  DataRequest,
  DataRequestStatus,
  DataRequestType,
  NotificationStatus,
  PaymentStatus,
  WaitlistStatus,
} from "@hair-simo/db";
import type { AppLocale } from "@hair-simo/i18n";

export const CUSTOMER_EXPORT_SCHEMA_VERSION = "hair-simo.gdpr.customer-export/1";
export const ERASURE_RECEIPT_SCHEMA_VERSION = "hair-simo.gdpr.erasure-receipt/2";
export const MARKETING_CONSENT_TYPE = "marketing";

/** Written over every free-text column that erasure cannot simply drop to NULL. */
export const ERASURE_REDACTION_MARKER = "[redacted:gdpr-erasure]";

/**
 * Accountability columns have to keep recording that it was the data subject who acted
 * or asked, without recording who the data subject is. Erasure requests routinely arrive
 * from the person themselves, and `DataRequest.requestedBy` / `AuditLog.actorEmail` are
 * retained under Art. 5(2) — so without this the erasure would leave, or even freshly
 * write, a copy of the very address it just destroyed.
 */
export const ERASURE_SUBJECT_ACTOR = "data-subject";
const ERASED_FIRST_NAME = "Erased";
const ERASED_LAST_NAME_PREFIX = "Customer";
const SYSTEM_ACTOR_EMAIL = "system@hairsimo.it";
const MAX_SCAN_RESIDUES = 200;

/**
 * The placeholder must not be derived from the erased values in any way. A hash of the
 * email would still be a pseudonym: anyone holding the address could recompute it and
 * re-identify the row, which is exactly what Art. 17 forbids.
 */
function erasurePlaceholder(): string {
  return randomUUID().replace(/-/g, "").slice(0, 8);
}

function redactedJson(): { redacted: string } {
  return { redacted: "gdpr-erasure" };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Free text supplied by the caller ("reason", "requestedBy") regularly quotes the
 * subject's own address or number. Those two values are known exactly at erasure time,
 * so they can be removed without guessing at prose.
 */
function scrubContacts(value: string, contacts: string[]): string {
  return contacts.reduce(
    (text, contact) =>
      text.replace(new RegExp(escapeRegExp(contact), "gi"), ERASURE_REDACTION_MARKER),
    value,
  );
}

export class GdprError extends Error {
  readonly code: string;

  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = "GdprError";
    this.code = code;
  }
}

/**
 * Every instant is exported twice: `iso` is the unambiguous absolute instant a receiving
 * system should import, `salon` is the wall clock the person actually experienced in
 * Bressanone. Exporting only one of the two makes the document either unreadable or
 * unimportable.
 */
export type ExportTimestamp = { iso: string; salon: string };

export type ExportedCustomer = {
  id: string;
  email: string | null;
  phone: string | null;
  firstName: string;
  lastName: string;
  locale: string;
  sourceChannel: Channel;
  marketingOptIn: boolean;
  deletedAt: ExportTimestamp | null;
  anonymizedAt: ExportTimestamp | null;
  createdAt: ExportTimestamp;
  updatedAt: ExportTimestamp;
};

export type ExportedCustomerNote = {
  id: string;
  note: string;
  kind: CustomerNoteKind;
  pinned: boolean;
  createdAt: ExportTimestamp;
};

export type ExportedStatusChange = {
  id: string;
  appointmentId: string;
  status: AppointmentStatus;
  reason: string | null;
  changedAt: ExportTimestamp;
};

export type ExportedRefund = {
  id: string;
  paymentId: string;
  amountCents: number;
  reason: string | null;
  createdAt: ExportTimestamp;
};

export type ExportedPayment = {
  id: string;
  appointmentId: string;
  provider: string;
  amountCents: number;
  tipCents: number;
  refundedCents: number;
  currency: string;
  mode: string;
  status: PaymentStatus;
  createdAt: ExportTimestamp;
  refunds: ExportedRefund[];
};

export type ExportedAppointment = {
  id: string;
  seriesId: string | null;
  status: AppointmentStatus;
  sourceChannel: Channel;
  locale: string;
  startsAt: ExportTimestamp;
  endsAt: ExportTimestamp;
  createdAt: ExportTimestamp;
  service: {
    id: string;
    slug: string;
    category: string;
    name: string;
    durationMin: number;
    priceCents: number;
    currency: string;
  } | null;
  staffDisplayName: string | null;
  notes: string | null;
  cancellationReason: string | null;
  depositRequired: boolean;
  noShowFeeCents: number;
  googleEventId: string | null;
};

export type ExportedMessage = {
  id: string;
  role: string;
  content: string;
  metadata: unknown;
  createdAt: ExportTimestamp;
};

export type ExportedConversation = {
  id: string;
  channel: Channel;
  locale: string;
  externalRef: string | null;
  createdAt: ExportTimestamp;
  messages: ExportedMessage[];
};

export type ExportedCallLog = {
  id: string;
  locale: string;
  fromNumber: string | null;
  toNumber: string | null;
  summary: string;
  actionTaken: string;
  fallback: boolean;
  createdAt: ExportTimestamp;
};

export type ExportedNotification = {
  id: string;
  appointmentId: string | null;
  channel: Channel;
  recipient: string;
  templateKey: string;
  payload: unknown;
  status: NotificationStatus;
  sentAt: ExportTimestamp | null;
  createdAt: ExportTimestamp;
};

export type ExportedConsentRecord = {
  id: string;
  type: string;
  granted: boolean;
  source: string;
  metadata: unknown;
  recordedAt: ExportTimestamp;
};

export type ExportedWaitlistEntry = {
  id: string;
  serviceId: string;
  serviceName: string | null;
  staffDisplayName: string | null;
  earliestAt: ExportTimestamp;
  latestAt: ExportTimestamp;
  locale: string;
  channel: Channel;
  status: WaitlistStatus;
  notifiedAt: ExportTimestamp | null;
  convertedAppointmentId: string | null;
  createdAt: ExportTimestamp;
};

export type ExportedRecurringSeries = {
  id: string;
  serviceId: string;
  serviceName: string | null;
  staffDisplayName: string | null;
  intervalWeeks: number;
  nextAt: ExportTimestamp;
  endsAt: ExportTimestamp | null;
  active: boolean;
  locale: string;
  channel: Channel;
  createdAt: ExportTimestamp;
};

/**
 * A voucher issued to this person can legitimately be redeemed on somebody else's
 * appointment (it is a gift card). The redemption amount is the subject's data; the
 * other customer's appointment is not, so the identifier is withheld unless the
 * appointment belongs to the subject.
 */
export type ExportedVoucherRedemption = {
  id: string;
  voucherId: string;
  amountCents: number;
  appointmentId: string | null;
  appointmentBelongsToSubject: boolean;
  redeemedAt: ExportTimestamp;
};

export type ExportedVoucher = {
  id: string;
  code: string;
  initialCents: number;
  remainingCents: number;
  currency: string;
  expiresAt: ExportTimestamp | null;
  active: boolean;
  note: string | null;
  createdAt: ExportTimestamp;
  redemptions: ExportedVoucherRedemption[];
};

export type ExportedReviewRequest = {
  id: string;
  appointmentId: string;
  platform: string;
  sentAt: ExportTimestamp | null;
  clickedAt: ExportTimestamp | null;
  createdAt: ExportTimestamp;
};

/** The token hash is a credential, never a subject-access disclosure. */
export type ExportedBookingVerification = {
  id: string;
  appointmentId: string;
  expiresAt: ExportTimestamp;
  verifiedAt: ExportTimestamp | null;
  sentCount: number;
  createdAt: ExportTimestamp;
};

export type ExportedDataRequest = {
  id: string;
  type: DataRequestType;
  status: DataRequestStatus;
  requestedBy: string | null;
  completedAt: ExportTimestamp | null;
  resultLocation: string | null;
  error: string | null;
  createdAt: ExportTimestamp;
};

/**
 * Audit entries describe what STAFF did to this customer's record. The action and the
 * before/after state concern the subject, but `actorEmail`, `actorId`, `ip` and
 * `userAgent` are a salon employee's personal data — disclosing them to the customer
 * would be a fresh breach, so only the coarse role survives.
 */
export type ExportedAuditEntry = {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  actorRole: string;
  before: unknown;
  after: unknown;
  createdAt: ExportTimestamp;
};

export type CustomerDataExport = {
  schemaVersion: string;
  generatedAt: ExportTimestamp;
  timeZone: string;
  locale: AppLocale;
  subjectId: string;
  counts: Record<string, number>;
  customer: ExportedCustomer;
  customerNotes: ExportedCustomerNote[];
  appointments: ExportedAppointment[];
  appointmentStatusHistory: ExportedStatusChange[];
  payments: ExportedPayment[];
  conversations: ExportedConversation[];
  callLogs: ExportedCallLog[];
  notifications: ExportedNotification[];
  consentRecords: ExportedConsentRecord[];
  waitlistEntries: ExportedWaitlistEntry[];
  recurringSeries: ExportedRecurringSeries[];
  vouchers: ExportedVoucher[];
  reviewRequests: ExportedReviewRequest[];
  bookingVerifications: ExportedBookingVerification[];
  dataRequests: ExportedDataRequest[];
  auditTrail: ExportedAuditEntry[];
};

export type ExportOptions = {
  locale?: AppLocale;
  requestedBy?: string;
  dataRequestId?: string;
  recordRequest?: boolean;
  now?: Date;
};

export type CustomerDataExportResult = {
  document: CustomerDataExport;
  dataRequestId: string | null;
};

export type ErasureOptions = {
  requestedBy?: string;
  reason?: string;
  dataRequestId?: string;
  recordRequest?: boolean;
  locale?: AppLocale;
  now?: Date;
};

export type ErasureCounts = {
  customerNotesDeleted: number;
  bookingVerificationsDeleted: number;
  messagesRedacted: number;
  conversationsRedacted: number;
  callLogsRedacted: number;
  notificationLogsRedacted: number;
  appointmentsRedacted: number;
  statusHistoryRedacted: number;
  voucherNotesRedacted: number;
  refundReasonsRedacted: number;
  consentMetadataRedacted: number;
  auditEntriesRedacted: number;
  recurringSeriesStopped: number;
  waitlistEntriesCancelled: number;
};

export type RetainedDataClass = {
  dataClass: string;
  records: number;
  legalBasis: string;
  retainedFor: string;
};

export type ErasureReceipt = {
  schemaVersion: string;
  customerId: string;
  erasedAt: ExportTimestamp;
  timeZone: string;
  alreadyErased: boolean;
  requestedBy: string | null;
  reason: string | null;
  identifiers: {
    emailCleared: boolean;
    phoneCleared: boolean;
    nameReplaced: boolean;
    placeholderSuffix: string | null;
  };
  removed: ErasureCounts;
  retained: RetainedDataClass[];
};

export type ErasureResult = {
  receipt: ErasureReceipt;
  dataRequestId: string | null;
  alreadyErased: boolean;
};

export type ErasureIdentifiers = {
  email?: string | null;
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  extra?: string[];
};

export type ErasureResidue = {
  dataClass: string;
  recordId: string;
  field: string;
  identifier: string;
};

export type ErasureVerification = {
  customerId: string;
  clean: boolean;
  checkedAt: ExportTimestamp;
  identifiersChecked: string[];
  residues: ErasureResidue[];
  truncated: boolean;
};

export type ConsentHistoryEntry = {
  id: string;
  type: string;
  granted: boolean;
  source: string;
  metadata: unknown;
  recordedAt: ExportTimestamp;
};

export type ConsentStateEntry = {
  type: string;
  granted: boolean;
  source: string;
  since: ExportTimestamp;
};

export type ConsentHistory = {
  customerId: string;
  marketingOptIn: boolean;
  /** True when `Customer.marketingOptIn` disagrees with the newest marketing consent. */
  marketingFlagDrift: boolean;
  current: ConsentStateEntry[];
  entries: ConsentHistoryEntry[];
};

export type MarketingConsentResult = {
  customerId: string;
  granted: boolean;
  changed: boolean;
  consentRecordId: string;
  recordedAt: ExportTimestamp;
};

export type LiveCustomer = {
  id: string;
  email: string | null;
  phone: string | null;
  firstName: string;
  lastName: string;
  locale: string;
  marketingOptIn: boolean;
};

/**
 * What a "normal read" means everywhere in the product: a customer who was soft deleted
 * or anonymised is not a customer any more. Subject-rights reads (export, consent
 * history) deliberately bypass this — the duty to answer an access request outlives the
 * soft delete.
 */
export const LIVE_CUSTOMER_WHERE = { deletedAt: null, anonymizedAt: null } as const;

const customerIdSchema = z.string().trim().min(1);

const exportInputSchema = z
  .object({
    customerId: customerIdSchema,
    requestedBy: z.string().trim().max(200).optional(),
    dataRequestId: z.string().trim().min(1).optional(),
  })
  .strict();

const eraseInputSchema = z
  .object({
    customerId: customerIdSchema,
    requestedBy: z.string().trim().max(200).optional(),
    reason: z.string().trim().max(1000).optional(),
    dataRequestId: z.string().trim().min(1).optional(),
  })
  .strict();

const consentInputSchema = z
  .object({
    customerId: customerIdSchema,
    granted: z.boolean(),
    source: z.string().trim().min(1).max(120),
  })
  .strict();

const dataRequestInputSchema = z
  .object({
    customerId: customerIdSchema,
    type: z.enum(["export", "erasure"]),
    requestedBy: z.string().trim().max(200).optional(),
  })
  .strict();

function stamp(value: Date, locale: AppLocale): ExportTimestamp {
  return { iso: value.toISOString(), salon: formatInSalonZone(value, locale) };
}

function optionalStamp(value: Date | null | undefined, locale: AppLocale): ExportTimestamp | null {
  return value ? stamp(value, locale) : null;
}

function ids<T extends { id: string }>(rows: T[]): string[] {
  return rows.map((row) => row.id);
}

function byIdChunk(values: string[]): { in: string[] } {
  return { in: values };
}

/**
 * Needles for the residue scan. Names are only searched as the full "First Last" string:
 * a bare "Anna" matches half the town and would drown the real findings, and the
 * placeholder written by erasure never contains the original name anyway.
 */
function buildNeedles(identifiers: ErasureIdentifiers): string[] {
  const out = new Set<string>();
  const push = (value: string | null | undefined) => {
    const trimmed = value?.trim();
    if (trimmed && trimmed.length >= 3) out.add(trimmed);
  };
  push(identifiers.email);
  push(identifiers.phone);
  const digits = identifiers.phone?.replace(/[^\d+]/g, "");
  if (digits && digits !== identifiers.phone?.trim()) push(digits);
  const first = identifiers.firstName?.trim();
  const last = identifiers.lastName?.trim();
  if (first && last) push(`${first} ${last}`);
  for (const extra of identifiers.extra ?? []) push(extra);
  return [...out];
}

function containsNeedle(value: unknown, needle: string): boolean {
  if (typeof value !== "string") return false;
  return value.toLowerCase().includes(needle.toLowerCase());
}

function jsonContainsNeedle(value: unknown, needle: string): boolean {
  if (value === null || value === undefined) return false;
  return JSON.stringify(value).toLowerCase().includes(needle.toLowerCase());
}

type ScanRow = { id: string; value: unknown };

type ScanTarget = {
  dataClass: string;
  field: string;
  find: (needles: string[]) => Promise<ScanRow[]>;
};

function containsAny(needles: string[], field: string) {
  return {
    OR: needles.map((needle) => ({ [field]: { contains: needle, mode: "insensitive" } })),
  };
}

export class GdprService {
  /** Reads that must ignore soft-deleted and anonymised people. */
  async findLiveCustomer(customerId: string): Promise<LiveCustomer | null> {
    const id = customerIdSchema.parse(customerId);
    const customer = await prisma.customer.findFirst({
      where: { id, ...LIVE_CUSTOMER_WHERE },
      select: {
        id: true,
        email: true,
        phone: true,
        firstName: true,
        lastName: true,
        locale: true,
        marketingOptIn: true,
      },
    });
    return customer ?? null;
  }

  async createDataRequest(input: {
    customerId: string;
    type: DataRequestType;
    requestedBy?: string;
  }): Promise<DataRequest> {
    const parsed = dataRequestInputSchema.parse(input);
    return prisma.dataRequest.create({
      data: {
        customerId: parsed.customerId,
        type: parsed.type,
        status: "pending",
        requestedBy: parsed.requestedBy ?? null,
      },
    });
  }

  async listDataRequests(filters?: {
    customerId?: string;
    status?: DataRequestStatus;
    take?: number;
  }): Promise<DataRequest[]> {
    const take = Math.min(200, Math.max(1, Math.trunc(filters?.take ?? 50)));
    return prisma.dataRequest.findMany({
      where: {
        ...(filters?.customerId ? { customerId: filters.customerId } : {}),
        ...(filters?.status ? { status: filters.status } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take,
    });
  }

  async failDataRequest(dataRequestId: string, error: string): Promise<DataRequest> {
    return prisma.dataRequest.update({
      where: { id: dataRequestId },
      data: { status: "failed", error: error.slice(0, 1000) },
    });
  }

  /**
   * Art. 15 / Art. 20. Every relation the schema attaches to a Customer, collected with
   * flat id-scoped queries and joined in memory: nothing is fetched by a filter that
   * could widen beyond this subject, which is what keeps a shared relation (a gift
   * voucher redeemed on somebody else's appointment) from leaking a third party.
   */
  async exportCustomerData(
    customerId: string,
    opts: ExportOptions = {},
  ): Promise<CustomerDataExportResult> {
    const parsed = exportInputSchema.parse({
      customerId,
      requestedBy: opts.requestedBy,
      dataRequestId: opts.dataRequestId,
    });
    const id = parsed.customerId;
    const now = opts.now ?? new Date();

    const customer = await prisma.customer.findUnique({ where: { id } });
    if (!customer) throw new GdprError("CUSTOMER_NOT_FOUND");
    const locale = opts.locale ?? resolveLocale(customer.locale);

    const appointments = await prisma.appointment.findMany({
      where: { customerId: id },
      orderBy: [{ startsAt: "asc" }, { id: "asc" }],
    });
    const appointmentIds = ids(appointments);
    const appointmentIdSet = new Set(appointmentIds);

    const conversations = await prisma.conversation.findMany({
      where: { customerId: id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const conversationIds = ids(conversations);

    const vouchers = await prisma.voucher.findMany({
      where: { issuedToCustomerId: id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const voucherIds = ids(vouchers);

    const contacts = [customer.email, customer.phone].filter(
      (value): value is string => typeof value === "string" && value.trim() !== "",
    );
    const notificationFilters = [
      ...(appointmentIds.length ? [{ appointmentId: byIdChunk(appointmentIds) }] : []),
      ...contacts.map((value) => ({ recipient: value })),
    ];

    const [
      notes,
      statusHistory,
      payments,
      messages,
      callLogs,
      notifications,
      consents,
      waitlistEntries,
      series,
      redemptions,
      reviewRequests,
      verifications,
      dataRequests,
    ] = await Promise.all([
      prisma.customerNote.findMany({
        where: { customerId: id },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
      appointmentIds.length
        ? prisma.appointmentStatusHistory.findMany({
            where: { appointmentId: byIdChunk(appointmentIds) },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          })
        : Promise.resolve([]),
      appointmentIds.length
        ? prisma.payment.findMany({
            where: { appointmentId: byIdChunk(appointmentIds) },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          })
        : Promise.resolve([]),
      conversationIds.length
        ? prisma.message.findMany({
            where: { conversationId: byIdChunk(conversationIds) },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          })
        : Promise.resolve([]),
      prisma.callLog.findMany({
        where: { customerId: id },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
      // A newsletter or a booking confirmation for somebody else's slot reaches the
      // subject by address, with no appointment of theirs attached. Erasure already
      // treats those rows as the subject's data, so access has to disclose them too.
      notificationFilters.length
        ? prisma.notificationLog.findMany({
            where: { OR: notificationFilters },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          })
        : Promise.resolve([]),
      prisma.consentRecord.findMany({
        where: { customerId: id },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
      prisma.waitlist.findMany({
        where: { customerId: id },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
      prisma.recurringSeries.findMany({
        where: { customerId: id },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
      voucherIds.length
        ? prisma.voucherRedemption.findMany({
            where: { voucherId: byIdChunk(voucherIds) },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          })
        : Promise.resolve([]),
      appointmentIds.length
        ? prisma.reviewRequest.findMany({
            where: { appointmentId: byIdChunk(appointmentIds) },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          })
        : Promise.resolve([]),
      appointmentIds.length
        ? prisma.bookingVerification.findMany({
            where: { appointmentId: byIdChunk(appointmentIds) },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          })
        : Promise.resolve([]),
      prisma.dataRequest.findMany({
        where: { customerId: id },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
    ]);

    const paymentIds = ids(payments);
    const serviceIds = [
      ...new Set([
        ...appointments.map((row) => row.serviceId),
        ...waitlistEntries.map((row) => row.serviceId),
        ...series.map((row) => row.serviceId),
      ]),
    ];
    const staffIds = [
      ...new Set(
        [
          ...appointments.map((row) => row.staffId),
          ...waitlistEntries.map((row) => row.staffId),
          ...series.map((row) => row.staffId),
        ].filter((value): value is string => value !== null),
      ),
    ];

    const [refunds, services, translations, staff, auditEntries] = await Promise.all([
      paymentIds.length
        ? prisma.refund.findMany({
            where: { paymentId: byIdChunk(paymentIds) },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          })
        : Promise.resolve([]),
      serviceIds.length
        ? prisma.service.findMany({ where: { id: byIdChunk(serviceIds) } })
        : Promise.resolve([]),
      serviceIds.length
        ? prisma.serviceTranslation.findMany({ where: { serviceId: byIdChunk(serviceIds) } })
        : Promise.resolve([]),
      staffIds.length
        ? prisma.staffProfile.findMany({
            where: { id: byIdChunk(staffIds) },
            select: { id: true, displayName: true },
          })
        : Promise.resolve([]),
      prisma.auditLog.findMany({
        where: {
          OR: [
            { entityType: "customer", entityId: id },
            ...(appointmentIds.length
              ? [{ entityType: "appointment", entityId: byIdChunk(appointmentIds) }]
              : []),
          ],
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
    ]);

    const serviceById = new Map(services.map((row) => [row.id, row]));
    const staffNameById = new Map(staff.map((row) => [row.id, row.displayName]));
    const translationsByService = new Map<string, { locale: string; name: string }[]>();
    for (const row of translations) {
      const bucket = translationsByService.get(row.serviceId) ?? [];
      bucket.push({ locale: row.locale, name: row.name });
      translationsByService.set(row.serviceId, bucket);
    }
    const serviceName = (serviceId: string): string | null => {
      const service = serviceById.get(serviceId);
      if (!service) return null;
      return getServiceTranslationName(
        translationsByService.get(serviceId) ?? [],
        locale,
        service.slug,
      );
    };
    const staffName = (staffId: string | null): string | null =>
      staffId ? (staffNameById.get(staffId) ?? null) : null;

    const refundsByPayment = new Map<string, ExportedRefund[]>();
    for (const row of refunds) {
      const bucket = refundsByPayment.get(row.paymentId) ?? [];
      bucket.push({
        id: row.id,
        paymentId: row.paymentId,
        amountCents: row.amountCents,
        reason: row.reason,
        createdAt: stamp(row.createdAt, locale),
      });
      refundsByPayment.set(row.paymentId, bucket);
    }

    const messagesByConversation = new Map<string, ExportedMessage[]>();
    for (const row of messages) {
      const bucket = messagesByConversation.get(row.conversationId) ?? [];
      bucket.push({
        id: row.id,
        role: row.role,
        content: row.content,
        metadata: row.metadata ?? null,
        createdAt: stamp(row.createdAt, locale),
      });
      messagesByConversation.set(row.conversationId, bucket);
    }

    const redemptionsByVoucher = new Map<string, ExportedVoucherRedemption[]>();
    for (const row of redemptions) {
      const belongs = row.appointmentId !== null && appointmentIdSet.has(row.appointmentId);
      const bucket = redemptionsByVoucher.get(row.voucherId) ?? [];
      bucket.push({
        id: row.id,
        voucherId: row.voucherId,
        amountCents: row.amountCents,
        appointmentId: belongs ? row.appointmentId : null,
        appointmentBelongsToSubject: belongs,
        redeemedAt: stamp(row.createdAt, locale),
      });
      redemptionsByVoucher.set(row.voucherId, bucket);
    }

    const document: CustomerDataExport = {
      schemaVersion: CUSTOMER_EXPORT_SCHEMA_VERSION,
      generatedAt: stamp(now, locale),
      timeZone: SALON_TIME_ZONE,
      locale,
      subjectId: id,
      counts: {},
      customer: {
        id: customer.id,
        email: customer.email,
        phone: customer.phone,
        firstName: customer.firstName,
        lastName: customer.lastName,
        locale: customer.locale,
        sourceChannel: customer.sourceChannel,
        marketingOptIn: customer.marketingOptIn,
        deletedAt: optionalStamp(customer.deletedAt, locale),
        anonymizedAt: optionalStamp(customer.anonymizedAt, locale),
        createdAt: stamp(customer.createdAt, locale),
        updatedAt: stamp(customer.updatedAt, locale),
      },
      customerNotes: notes.map((row) => ({
        id: row.id,
        note: row.note,
        kind: row.kind,
        pinned: row.pinned,
        createdAt: stamp(row.createdAt, locale),
      })),
      appointments: appointments.map((row) => {
        const service = serviceById.get(row.serviceId);
        return {
          id: row.id,
          seriesId: row.seriesId,
          status: row.status,
          sourceChannel: row.sourceChannel,
          locale: row.locale,
          startsAt: stamp(row.startsAt, locale),
          endsAt: stamp(row.endsAt, locale),
          createdAt: stamp(row.createdAt, locale),
          service: service
            ? {
                id: service.id,
                slug: service.slug,
                category: service.category,
                name: serviceName(row.serviceId) ?? service.slug,
                durationMin: service.durationMin,
                priceCents: service.priceCents,
                currency: service.currency,
              }
            : null,
          staffDisplayName: staffName(row.staffId),
          notes: row.notes,
          cancellationReason: row.cancellationReason,
          depositRequired: row.depositRequired,
          noShowFeeCents: row.noShowFeeCents,
          googleEventId: row.googleEventId,
        };
      }),
      appointmentStatusHistory: statusHistory.map((row) => ({
        id: row.id,
        appointmentId: row.appointmentId,
        status: row.status,
        reason: row.reason,
        changedAt: stamp(row.createdAt, locale),
      })),
      payments: payments.map((row) => ({
        id: row.id,
        appointmentId: row.appointmentId,
        provider: row.provider,
        amountCents: row.amountCents,
        tipCents: row.tipCents,
        refundedCents: row.refundedCents,
        currency: row.currency,
        mode: row.mode,
        status: row.status,
        createdAt: stamp(row.createdAt, locale),
        refunds: refundsByPayment.get(row.id) ?? [],
      })),
      conversations: conversations.map((row) => ({
        id: row.id,
        channel: row.channel,
        locale: row.locale,
        externalRef: row.externalRef,
        createdAt: stamp(row.createdAt, locale),
        messages: messagesByConversation.get(row.id) ?? [],
      })),
      callLogs: callLogs.map((row) => ({
        id: row.id,
        locale: row.locale,
        fromNumber: row.fromNumber,
        toNumber: row.toNumber,
        summary: row.summary,
        actionTaken: row.actionTaken,
        fallback: row.fallback,
        createdAt: stamp(row.createdAt, locale),
      })),
      notifications: notifications.map((row) => ({
        id: row.id,
        // Same rule as a gifted voucher redemption: the message is the subject's, the
        // third party's appointment it refers to is not.
        appointmentId:
          row.appointmentId !== null && appointmentIdSet.has(row.appointmentId)
            ? row.appointmentId
            : null,
        channel: row.channel,
        recipient: row.recipient,
        templateKey: row.templateKey,
        payload: row.payload ?? null,
        status: row.status,
        sentAt: optionalStamp(row.sentAt, locale),
        createdAt: stamp(row.createdAt, locale),
      })),
      consentRecords: consents.map((row) => ({
        id: row.id,
        type: row.type,
        granted: row.granted,
        source: row.source,
        metadata: row.metadata ?? null,
        recordedAt: stamp(row.createdAt, locale),
      })),
      waitlistEntries: waitlistEntries.map((row) => ({
        id: row.id,
        serviceId: row.serviceId,
        serviceName: serviceName(row.serviceId),
        staffDisplayName: staffName(row.staffId),
        earliestAt: stamp(row.earliestAt, locale),
        latestAt: stamp(row.latestAt, locale),
        locale: row.locale,
        channel: row.channel,
        status: row.status,
        notifiedAt: optionalStamp(row.notifiedAt, locale),
        convertedAppointmentId: row.convertedAppointmentId,
        createdAt: stamp(row.createdAt, locale),
      })),
      recurringSeries: series.map((row) => ({
        id: row.id,
        serviceId: row.serviceId,
        serviceName: serviceName(row.serviceId),
        staffDisplayName: staffName(row.staffId),
        intervalWeeks: row.intervalWeeks,
        nextAt: stamp(row.nextAt, locale),
        endsAt: optionalStamp(row.endsAt, locale),
        active: row.active,
        locale: row.locale,
        channel: row.channel,
        createdAt: stamp(row.createdAt, locale),
      })),
      vouchers: vouchers.map((row) => ({
        id: row.id,
        code: row.code,
        initialCents: row.initialCents,
        remainingCents: row.remainingCents,
        currency: row.currency,
        expiresAt: optionalStamp(row.expiresAt, locale),
        active: row.active,
        note: row.note,
        createdAt: stamp(row.createdAt, locale),
        redemptions: redemptionsByVoucher.get(row.id) ?? [],
      })),
      reviewRequests: reviewRequests.map((row) => ({
        id: row.id,
        appointmentId: row.appointmentId,
        platform: row.platform,
        sentAt: optionalStamp(row.sentAt, locale),
        clickedAt: optionalStamp(row.clickedAt, locale),
        createdAt: stamp(row.createdAt, locale),
      })),
      bookingVerifications: verifications.map((row) => ({
        id: row.id,
        appointmentId: row.appointmentId,
        expiresAt: stamp(row.expiresAt, locale),
        verifiedAt: optionalStamp(row.verifiedAt, locale),
        sentCount: row.sentCount,
        createdAt: stamp(row.createdAt, locale),
      })),
      dataRequests: dataRequests.map((row) => ({
        id: row.id,
        type: row.type,
        status: row.status,
        requestedBy: row.requestedBy,
        completedAt: optionalStamp(row.completedAt, locale),
        resultLocation: row.resultLocation,
        error: row.error,
        createdAt: stamp(row.createdAt, locale),
      })),
      auditTrail: auditEntries.map((row) => ({
        id: row.id,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        actorRole: row.actorRole,
        before: row.before ?? null,
        after: row.after ?? null,
        createdAt: stamp(row.createdAt, locale),
      })),
    };

    document.counts = {
      customerNotes: document.customerNotes.length,
      appointments: document.appointments.length,
      appointmentStatusHistory: document.appointmentStatusHistory.length,
      payments: document.payments.length,
      refunds: document.payments.reduce((sum, row) => sum + row.refunds.length, 0),
      conversations: document.conversations.length,
      messages: document.conversations.reduce((sum, row) => sum + row.messages.length, 0),
      callLogs: document.callLogs.length,
      notifications: document.notifications.length,
      consentRecords: document.consentRecords.length,
      waitlistEntries: document.waitlistEntries.length,
      recurringSeries: document.recurringSeries.length,
      vouchers: document.vouchers.length,
      voucherRedemptions: document.vouchers.reduce((sum, row) => sum + row.redemptions.length, 0),
      reviewRequests: document.reviewRequests.length,
      bookingVerifications: document.bookingVerifications.length,
      dataRequests: document.dataRequests.length,
      auditTrail: document.auditTrail.length,
    };

    let dataRequestId: string | null = null;
    if (opts.recordRequest ?? true) {
      const resultLocation = JSON.stringify({
        delivery: "inline",
        schemaVersion: CUSTOMER_EXPORT_SCHEMA_VERSION,
        counts: document.counts,
      });
      if (parsed.dataRequestId) {
        const updated = await prisma.dataRequest.update({
          where: { id: parsed.dataRequestId },
          data: { status: "completed", completedAt: now, resultLocation, error: null },
        });
        dataRequestId = updated.id;
      } else {
        const created = await prisma.dataRequest.create({
          data: {
            customerId: id,
            type: "export",
            status: "completed",
            requestedBy: parsed.requestedBy ?? null,
            completedAt: now,
            resultLocation,
          },
        });
        dataRequestId = created.id;
      }
    }

    return { document, dataRequestId };
  }

  /** Ready-to-stream form of {@link exportCustomerData} for a download route. */
  async exportCustomerDataAsJson(
    customerId: string,
    opts: ExportOptions = {},
  ): Promise<{ filename: string; contentType: string; body: string; dataRequestId: string | null }> {
    const now = opts.now ?? new Date();
    const { document, dataRequestId } = await this.exportCustomerData(customerId, {
      ...opts,
      now,
    });
    return {
      filename: `hair-simo-data-export-${document.subjectId}-${salonDayKey(now)}.json`,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(document, null, 2),
      dataRequestId,
    };
  }

  /**
   * Art. 17 by anonymisation, in one transaction and safe to run twice.
   *
   * Deleting the rows is not an option: the appointment and its payment are the salon's
   * accounting entry and Italian law (Codice Civile art. 2220, DPR 633/1972 art. 39)
   * keeps those for ten years, which Art. 17(3)(b) recognises. What actually identifies
   * the person — name, email, phone, notes, chat transcripts, call summaries,
   * notification payloads — is destroyed or overwritten with an irreversible placeholder.
   * The unique email and phone are released so the same human can come back later as a
   * genuinely new customer with no link to the old record.
   *
   * Re-running is a no-op on the identifiers: `anonymizedAt` and the placeholder from the
   * first run are preserved, only the (already empty) redaction sweeps repeat.
   */
  async eraseCustomerData(customerId: string, opts: ErasureOptions = {}): Promise<ErasureResult> {
    const parsed = eraseInputSchema.parse({
      customerId,
      requestedBy: opts.requestedBy,
      reason: opts.reason,
      dataRequestId: opts.dataRequestId,
    });
    const id = parsed.customerId;
    const now = opts.now ?? new Date();
    const recordRequest = opts.recordRequest ?? true;

    return prisma.$transaction(async (tx) => {
      const customer = await tx.customer.findUnique({
        where: { id },
        select: {
          id: true,
          email: true,
          phone: true,
          locale: true,
          deletedAt: true,
          anonymizedAt: true,
        },
      });
      if (!customer) throw new GdprError("CUSTOMER_NOT_FOUND");

      const locale = opts.locale ?? resolveLocale(customer.locale);
      const alreadyErased = customer.anonymizedAt !== null;

      const [appointments, conversations, vouchers] = await Promise.all([
        tx.appointment.findMany({ where: { customerId: id }, select: { id: true } }),
        tx.conversation.findMany({ where: { customerId: id }, select: { id: true } }),
        tx.voucher.findMany({ where: { issuedToCustomerId: id }, select: { id: true } }),
      ]);
      const appointmentIds = ids(appointments);
      const conversationIds = ids(conversations);
      const voucherIds = ids(vouchers);
      const contacts = [customer.email, customer.phone].filter(
        (value): value is string => typeof value === "string" && value.trim() !== "",
      );
      const requesterIsSubject =
        parsed.requestedBy !== undefined &&
        scrubContacts(parsed.requestedBy, contacts) !== parsed.requestedBy;
      const requestedBy =
        parsed.requestedBy === undefined
          ? null
          : requesterIsSubject
            ? ERASURE_SUBJECT_ACTOR
            : parsed.requestedBy;
      const reason = parsed.reason === undefined ? null : scrubContacts(parsed.reason, contacts);

      const notesDeleted = await tx.customerNote.deleteMany({ where: { customerId: id } });

      const verificationsDeleted = appointmentIds.length
        ? await tx.bookingVerification.deleteMany({
            where: { appointmentId: byIdChunk(appointmentIds) },
          })
        : { count: 0 };

      const messagesRedacted = conversationIds.length
        ? await tx.message.updateMany({
            where: { conversationId: byIdChunk(conversationIds) },
            data: { content: ERASURE_REDACTION_MARKER, metadata: redactedJson() },
          })
        : { count: 0 };

      const conversationsRedacted = await tx.conversation.updateMany({
        where: { customerId: id, externalRef: { not: null } },
        data: { externalRef: null },
      });

      // A call that was never matched to the customer record still carries their number
      // in `fromNumber`, and {@link GdprService.verifyErasure} looks for exactly that. The
      // number is the link, so it selects the row just like it does for notifications.
      const callLogsRedacted = await tx.callLog.updateMany({
        where: {
          OR: [
            { customerId: id },
            ...contacts.map((value) => ({ fromNumber: value })),
            ...contacts.map((value) => ({ toNumber: value })),
          ],
        },
        data: { summary: ERASURE_REDACTION_MARKER, fromNumber: null, toNumber: null },
      });

      const notificationFilters = [
        ...(appointmentIds.length ? [{ appointmentId: byIdChunk(appointmentIds) }] : []),
        ...contacts.map((value) => ({ recipient: value })),
      ];
      const notificationLogsRedacted = notificationFilters.length
        ? await tx.notificationLog.updateMany({
            where: { OR: notificationFilters },
            data: { recipient: ERASURE_REDACTION_MARKER, payload: redactedJson() },
          })
        : { count: 0 };

      const appointmentsRedacted = appointmentIds.length
        ? await tx.appointment.updateMany({
            where: { id: byIdChunk(appointmentIds) },
            data: { notes: null, cancellationReason: null },
          })
        : { count: 0 };

      const statusHistoryRedacted = appointmentIds.length
        ? await tx.appointmentStatusHistory.updateMany({
            where: { appointmentId: byIdChunk(appointmentIds), reason: { not: null } },
            data: { reason: null },
          })
        : { count: 0 };

      const voucherNotesRedacted = voucherIds.length
        ? await tx.voucher.updateMany({
            where: { id: byIdChunk(voucherIds), note: { not: null } },
            data: { note: null },
          })
        : { count: 0 };

      const consentMetadataRedacted = await tx.consentRecord.updateMany({
        where: { customerId: id },
        data: { metadata: redactedJson() },
      });

      // Retained accountability rows keep saying "the subject did this" without saying who.
      if (contacts.length) {
        await tx.dataRequest.updateMany({
          where: { customerId: id, OR: contacts.map((value) => ({ requestedBy: value })) },
          data: { requestedBy: ERASURE_SUBJECT_ACTOR },
        });
        await tx.auditLog.updateMany({
          where: { OR: contacts.map((value) => ({ actorEmail: value })) },
          data: { actorEmail: ERASURE_SUBJECT_ACTOR },
        });
      }

      // `gdpr.*` entries are the proof that this erasure happened and must survive it.
      const auditRows = await tx.auditLog.findMany({
        where: {
          AND: [
            {
              OR: [
                { entityType: "customer", entityId: id },
                ...(appointmentIds.length
                  ? [{ entityType: "appointment", entityId: byIdChunk(appointmentIds) }]
                  : []),
              ],
            },
            { NOT: { action: { startsWith: "gdpr." } } },
          ],
        },
        select: { id: true, before: true, after: true },
      });
      const withBefore = auditRows.filter((row) => row.before !== null).map((row) => row.id);
      const withAfter = auditRows.filter((row) => row.after !== null).map((row) => row.id);
      if (withBefore.length) {
        await tx.auditLog.updateMany({
          where: { id: byIdChunk(withBefore) },
          data: { before: redactedJson() },
        });
      }
      if (withAfter.length) {
        await tx.auditLog.updateMany({
          where: { id: byIdChunk(withAfter) },
          data: { after: redactedJson() },
        });
      }

      // Erasure also has to stop FUTURE automated processing, not just past records.
      const recurringSeriesStopped = await tx.recurringSeries.updateMany({
        where: { customerId: id, active: true },
        data: { active: false },
      });
      const waitlistEntriesCancelled = await tx.waitlist.updateMany({
        where: { customerId: id, status: { in: ["active", "notified"] } },
        data: { status: "cancelled" },
      });

      let placeholderSuffix: string | null = null;
      if (!alreadyErased) {
        placeholderSuffix = erasurePlaceholder();
        await tx.customer.update({
          where: { id },
          data: {
            email: null,
            phone: null,
            firstName: ERASED_FIRST_NAME,
            lastName: `${ERASED_LAST_NAME_PREFIX} ${placeholderSuffix}`,
            marketingOptIn: false,
            deletedAt: customer.deletedAt ?? now,
            anonymizedAt: now,
          },
        });
      }

      const paymentRows = appointmentIds.length
        ? await tx.payment.findMany({
            where: { appointmentId: byIdChunk(appointmentIds) },
            select: { id: true },
          })
        : [];
      const paymentIds = ids(paymentRows);

      // The amount, the date and the link to the payment are the accounting entry; the
      // free-text justification a staff member typed next to it is not, and it is one of
      // the few places where an address or a full name reliably ends up.
      const refundReasonsRedacted = paymentIds.length
        ? await tx.refund.updateMany({
            where: { paymentId: byIdChunk(paymentIds), reason: { not: null } },
            data: { reason: null },
          })
        : { count: 0 };

      const [refundCount, consentCount, redemptionCount, reviewCount, requestCount, auditCount] =
        await Promise.all([
          paymentIds.length
            ? tx.refund.count({ where: { paymentId: byIdChunk(paymentIds) } })
            : Promise.resolve(0),
          tx.consentRecord.count({ where: { customerId: id } }),
          voucherIds.length
            ? tx.voucherRedemption.count({ where: { voucherId: byIdChunk(voucherIds) } })
            : Promise.resolve(0),
          appointmentIds.length
            ? tx.reviewRequest.count({ where: { appointmentId: byIdChunk(appointmentIds) } })
            : Promise.resolve(0),
          tx.dataRequest.count({ where: { customerId: id } }),
          Promise.resolve(auditRows.length),
        ]);

      const receipt: ErasureReceipt = {
        schemaVersion: ERASURE_RECEIPT_SCHEMA_VERSION,
        customerId: id,
        erasedAt: stamp(customer.anonymizedAt ?? now, locale),
        timeZone: SALON_TIME_ZONE,
        alreadyErased,
        requestedBy,
        reason,
        identifiers: {
          emailCleared: true,
          phoneCleared: true,
          nameReplaced: true,
          placeholderSuffix,
        },
        removed: {
          customerNotesDeleted: notesDeleted.count,
          bookingVerificationsDeleted: verificationsDeleted.count,
          messagesRedacted: messagesRedacted.count,
          conversationsRedacted: conversationsRedacted.count,
          callLogsRedacted: callLogsRedacted.count,
          notificationLogsRedacted: notificationLogsRedacted.count,
          appointmentsRedacted: appointmentsRedacted.count,
          statusHistoryRedacted: statusHistoryRedacted.count,
          voucherNotesRedacted: voucherNotesRedacted.count,
          refundReasonsRedacted: refundReasonsRedacted.count,
          consentMetadataRedacted: consentMetadataRedacted.count,
          auditEntriesRedacted: withBefore.length + withAfter.length,
          recurringSeriesStopped: recurringSeriesStopped.count,
          waitlistEntriesCancelled: waitlistEntriesCancelled.count,
        },
        retained: [
          {
            dataClass: "appointments",
            records: appointmentIds.length,
            legalBasis:
              "GDPR Art. 17(3)(b) with Codice Civile art. 2220: the appointment is the " +
              "underlying business record of the invoiced service and cannot be deleted " +
              "while the accounting entry it supports must be kept.",
            retainedFor: "10 years from the end of the financial year of the service",
          },
          {
            dataClass: "payments",
            records: paymentIds.length,
            legalBasis:
              "GDPR Art. 17(3)(b) with DPR 633/1972 art. 39 and Codice Civile art. 2220: " +
              "VAT and accounting documentation must remain intact and auditable.",
            retainedFor: "10 years from the end of the financial year of the payment",
          },
          {
            dataClass: "refunds",
            records: refundCount,
            legalBasis:
              "GDPR Art. 17(3)(b): a refund is a correction of an accounting entry and " +
              "shares its retention obligation.",
            retainedFor: "10 years from the end of the financial year of the refund",
          },
          {
            dataClass: "consentRecords",
            records: consentCount,
            legalBasis:
              "GDPR Art. 7(1) and Art. 5(2): the salon must be able to demonstrate what " +
              "was consented to and when. Free-form metadata was redacted; the proof " +
              "itself (type, granted, source, timestamp) is kept.",
            retainedFor: "for as long as the consent may need to be demonstrated",
          },
          {
            dataClass: "voucherRedemptions",
            records: redemptionCount,
            legalBasis:
              "GDPR Art. 17(3)(b): a voucher is a bearer instrument with a monetary " +
              "balance; its issuance and redemptions are accounting movements.",
            retainedFor: "10 years from the end of the financial year of the redemption",
          },
          {
            dataClass: "reviewRequests",
            records: reviewCount,
            legalBasis:
              "No personal data remains on the row once the appointment is anonymised; " +
              "it is kept as an operational counter.",
            retainedFor: "until the retention sweeper removes it",
          },
          {
            dataClass: "dataRequests",
            records: requestCount,
            legalBasis:
              "GDPR Art. 5(2) accountability: the record that this erasure was requested " +
              "and executed is itself the evidence of compliance.",
            retainedFor: "indefinitely",
          },
          {
            dataClass: "auditTrail",
            records: auditCount,
            legalBasis:
              "GDPR Art. 5(2) and Art. 32: staff actions on the record stay auditable. " +
              "The before/after snapshots that contained personal data were redacted.",
            retainedFor: "2 years (see the audit_logs retention rule)",
          },
        ],
      };

      let dataRequestId: string | null = null;
      if (recordRequest) {
        const resultLocation = JSON.stringify(receipt);
        if (parsed.dataRequestId) {
          const updated = await tx.dataRequest.update({
            where: { id: parsed.dataRequestId },
            data: { status: "completed", completedAt: now, resultLocation, error: null },
          });
          dataRequestId = updated.id;
        } else {
          const created = await tx.dataRequest.create({
            data: {
              customerId: id,
              type: "erasure",
              status: "completed",
              requestedBy,
              completedAt: now,
              resultLocation,
            },
          });
          dataRequestId = created.id;
        }
      }

      await tx.auditLog.create({
        data: {
          actorId: null,
          actorEmail:
            requestedBy && requestedBy !== ERASURE_SUBJECT_ACTOR
              ? requestedBy
              : SYSTEM_ACTOR_EMAIL,
          actorRole: "system",
          action: "gdpr.customer.erasure",
          entityType: "customer",
          entityId: id,
          after: receipt,
        },
      });

      return { receipt, dataRequestId, alreadyErased };
    });
  }

  /**
   * Art. 17 is only satisfied if the identifiers are actually gone, so this re-reads the
   * database looking for them. It searches globally rather than only within the subject's
   * own rows: an address that survived on somebody else's note or on an unlinked
   * notification is exactly the residue that matters.
   *
   * The caller must supply the identifiers — they were destroyed by the erasure and the
   * service deliberately keeps no copy of them anywhere.
   */
  async verifyErasure(
    customerId: string,
    identifiers: ErasureIdentifiers,
    opts: { locale?: AppLocale; now?: Date } = {},
  ): Promise<ErasureVerification> {
    const id = customerIdSchema.parse(customerId);
    const now = opts.now ?? new Date();
    const locale = opts.locale ?? "en";
    const needles = buildNeedles(identifiers);
    if (needles.length === 0) {
      return {
        customerId: id,
        clean: true,
        checkedAt: stamp(now, locale),
        identifiersChecked: [],
        residues: [],
        truncated: false,
      };
    }

    const targets: ScanTarget[] = [
      {
        dataClass: "customer",
        field: "email",
        find: async (values) =>
          (
            await prisma.customer.findMany({
              where: containsAny(values, "email"),
              select: { id: true, email: true },
            })
          ).map((row) => ({ id: row.id, value: row.email })),
      },
      {
        dataClass: "customer",
        field: "phone",
        find: async (values) =>
          (
            await prisma.customer.findMany({
              where: containsAny(values, "phone"),
              select: { id: true, phone: true },
            })
          ).map((row) => ({ id: row.id, value: row.phone })),
      },
      {
        dataClass: "customer",
        field: "lastName",
        // The needle is the full "First Last" string but the name is stored in two
        // columns, so filtering `lastName contains "Anna Rossi"` matches nothing and the
        // check never fires. Candidates are selected column by column and the full name
        // is reassembled in memory, where the needle can actually match.
        find: async (values) => {
          const first = identifiers.firstName?.trim();
          const last = identifiers.lastName?.trim();
          const where = {
            OR: [
              ...containsAny(values, "firstName").OR,
              ...containsAny(values, "lastName").OR,
              ...(first && last
                ? [
                    {
                      AND: [
                        { firstName: { contains: first, mode: "insensitive" as const } },
                        { lastName: { contains: last, mode: "insensitive" as const } },
                      ],
                    },
                  ]
                : []),
            ],
          };
          return (
            await prisma.customer.findMany({
              where,
              select: { id: true, firstName: true, lastName: true },
            })
          ).map((row) => ({ id: row.id, value: `${row.firstName} ${row.lastName}` }));
        },
      },
      {
        dataClass: "customerNote",
        field: "note",
        find: async (values) =>
          (
            await prisma.customerNote.findMany({
              where: containsAny(values, "note"),
              select: { id: true, note: true },
            })
          ).map((row) => ({ id: row.id, value: row.note })),
      },
      {
        dataClass: "appointment",
        field: "notes",
        find: async (values) =>
          (
            await prisma.appointment.findMany({
              where: containsAny(values, "notes"),
              select: { id: true, notes: true },
            })
          ).map((row) => ({ id: row.id, value: row.notes })),
      },
      {
        dataClass: "appointment",
        field: "cancellationReason",
        find: async (values) =>
          (
            await prisma.appointment.findMany({
              where: containsAny(values, "cancellationReason"),
              select: { id: true, cancellationReason: true },
            })
          ).map((row) => ({ id: row.id, value: row.cancellationReason })),
      },
      {
        dataClass: "appointmentStatusHistory",
        field: "reason",
        find: async (values) =>
          (
            await prisma.appointmentStatusHistory.findMany({
              where: containsAny(values, "reason"),
              select: { id: true, reason: true },
            })
          ).map((row) => ({ id: row.id, value: row.reason })),
      },
      {
        dataClass: "message",
        field: "content",
        find: async (values) =>
          (
            await prisma.message.findMany({
              where: containsAny(values, "content"),
              select: { id: true, content: true },
            })
          ).map((row) => ({ id: row.id, value: row.content })),
      },
      {
        dataClass: "callLog",
        field: "summary",
        find: async (values) =>
          (
            await prisma.callLog.findMany({
              where: containsAny(values, "summary"),
              select: { id: true, summary: true },
            })
          ).map((row) => ({ id: row.id, value: row.summary })),
      },
      {
        dataClass: "callLog",
        field: "fromNumber",
        find: async (values) =>
          (
            await prisma.callLog.findMany({
              where: containsAny(values, "fromNumber"),
              select: { id: true, fromNumber: true },
            })
          ).map((row) => ({ id: row.id, value: row.fromNumber })),
      },
      {
        dataClass: "callLog",
        field: "toNumber",
        find: async (values) =>
          (
            await prisma.callLog.findMany({
              where: containsAny(values, "toNumber"),
              select: { id: true, toNumber: true },
            })
          ).map((row) => ({ id: row.id, value: row.toNumber })),
      },
      {
        dataClass: "notificationLog",
        field: "recipient",
        find: async (values) =>
          (
            await prisma.notificationLog.findMany({
              where: containsAny(values, "recipient"),
              select: { id: true, recipient: true },
            })
          ).map((row) => ({ id: row.id, value: row.recipient })),
      },
      {
        dataClass: "conversation",
        field: "externalRef",
        find: async (values) =>
          (
            await prisma.conversation.findMany({
              where: containsAny(values, "externalRef"),
              select: { id: true, externalRef: true },
            })
          ).map((row) => ({ id: row.id, value: row.externalRef })),
      },
      {
        dataClass: "voucher",
        field: "note",
        find: async (values) =>
          (
            await prisma.voucher.findMany({
              where: containsAny(values, "note"),
              select: { id: true, note: true },
            })
          ).map((row) => ({ id: row.id, value: row.note })),
      },
      {
        dataClass: "refund",
        field: "reason",
        find: async (values) =>
          (
            await prisma.refund.findMany({
              where: containsAny(values, "reason"),
              select: { id: true, reason: true },
            })
          ).map((row) => ({ id: row.id, value: row.reason })),
      },
      {
        dataClass: "dataRequest",
        field: "requestedBy",
        find: async (values) =>
          (
            await prisma.dataRequest.findMany({
              where: containsAny(values, "requestedBy"),
              select: { id: true, requestedBy: true },
            })
          ).map((row) => ({ id: row.id, value: row.requestedBy })),
      },
      {
        dataClass: "auditLog",
        field: "actorEmail",
        find: async (values) =>
          (
            await prisma.auditLog.findMany({
              where: containsAny(values, "actorEmail"),
              select: { id: true, actorEmail: true },
            })
          ).map((row) => ({ id: row.id, value: row.actorEmail })),
      },
    ];

    const residues: ErasureResidue[] = [];
    const scans = await Promise.all(targets.map((target) => target.find(needles)));
    scans.forEach((rows, index) => {
      const target = targets[index];
      if (!target) return;
      for (const row of rows) {
        for (const needle of needles) {
          if (containsNeedle(row.value, needle)) {
            residues.push({
              dataClass: target.dataClass,
              recordId: row.id,
              field: target.field,
              identifier: needle,
            });
          }
        }
      }
    });

    // JSON columns cannot be filtered by substring without a path, so the structured
    // payloads reachable from this subject are pulled and scanned in memory instead.
    const appointments = await prisma.appointment.findMany({
      where: { customerId: id },
      select: { id: true },
    });
    const appointmentIds = ids(appointments);
    const conversations = await prisma.conversation.findMany({
      where: { customerId: id },
      select: { id: true },
    });
    const conversationIds = ids(conversations);

    const [notificationPayloads, messageMetadata, consentMetadata, auditPayloads] =
      await Promise.all([
        appointmentIds.length
          ? prisma.notificationLog.findMany({
              where: { appointmentId: byIdChunk(appointmentIds) },
              select: { id: true, payload: true },
            })
          : Promise.resolve([]),
        conversationIds.length
          ? prisma.message.findMany({
              where: { conversationId: byIdChunk(conversationIds) },
              select: { id: true, metadata: true },
            })
          : Promise.resolve([]),
        prisma.consentRecord.findMany({
          where: { customerId: id },
          select: { id: true, metadata: true },
        }),
        prisma.auditLog.findMany({
          where: {
            OR: [
              { entityType: "customer", entityId: id },
              ...(appointmentIds.length
                ? [{ entityType: "appointment", entityId: byIdChunk(appointmentIds) }]
                : []),
            ],
          },
          select: { id: true, before: true, after: true, action: true },
        }),
      ]);

    const pushJson = (dataClass: string, field: string, recordId: string, value: unknown) => {
      for (const needle of needles) {
        if (jsonContainsNeedle(value, needle)) {
          residues.push({ dataClass, recordId, field, identifier: needle });
        }
      }
    };
    for (const row of notificationPayloads) pushJson("notificationLog", "payload", row.id, row.payload);
    for (const row of messageMetadata) pushJson("message", "metadata", row.id, row.metadata);
    for (const row of consentMetadata) pushJson("consentRecord", "metadata", row.id, row.metadata);
    for (const row of auditPayloads) {
      if (row.action.startsWith("gdpr.")) continue;
      pushJson("auditLog", "before", row.id, row.before);
      pushJson("auditLog", "after", row.id, row.after);
    }

    const truncated = residues.length > MAX_SCAN_RESIDUES;
    return {
      customerId: id,
      clean: residues.length === 0,
      checkedAt: stamp(now, locale),
      identifiersChecked: needles,
      residues: truncated ? residues.slice(0, MAX_SCAN_RESIDUES) : residues,
      truncated,
    };
  }

  /**
   * Art. 7(3). Withdrawal is recorded as its own ConsentRecord rather than by mutating
   * the previous one: the history of what was granted and revoked, and when, is the
   * evidence the salon needs, and overwriting it would destroy that evidence.
   */
  async setMarketingConsent(
    customerId: string,
    granted: boolean,
    source: string,
    opts: { metadata?: Record<string, unknown>; locale?: AppLocale; now?: Date } = {},
  ): Promise<MarketingConsentResult> {
    const parsed = consentInputSchema.parse({ customerId, granted, source });
    const now = opts.now ?? new Date();
    const locale = opts.locale ?? "en";

    return prisma.$transaction(async (tx) => {
      const customer = await tx.customer.findFirst({
        where: { id: parsed.customerId, ...LIVE_CUSTOMER_WHERE },
        select: { id: true, marketingOptIn: true },
      });
      if (!customer) throw new GdprError("CUSTOMER_NOT_FOUND");

      const consent = await tx.consentRecord.create({
        data: {
          customerId: parsed.customerId,
          type: MARKETING_CONSENT_TYPE,
          granted: parsed.granted,
          source: parsed.source,
          ...(opts.metadata ? { metadata: opts.metadata as Prisma.InputJsonValue } : {}),
        },
      });
      await tx.customer.update({
        where: { id: parsed.customerId },
        data: { marketingOptIn: parsed.granted },
      });

      return {
        customerId: parsed.customerId,
        granted: parsed.granted,
        changed: customer.marketingOptIn !== parsed.granted,
        consentRecordId: consent.id,
        recordedAt: stamp(consent.createdAt ?? now, locale),
      };
    });
  }

  async withdrawMarketingConsent(
    customerId: string,
    source: string,
    opts: { metadata?: Record<string, unknown>; locale?: AppLocale; now?: Date } = {},
  ): Promise<MarketingConsentResult> {
    return this.setMarketingConsent(customerId, false, source, opts);
  }

  /**
   * Consent history for the admin UI. Readable for soft-deleted customers too: the
   * accountability duty in Art. 5(2) does not end when the record is hidden from the
   * booking flow. `marketingFlagDrift` surfaces the one inconsistency that actually
   * matters — the boolean on Customer disagreeing with the newest recorded consent.
   */
  async readConsentHistory(
    customerId: string,
    opts: { type?: string; take?: number; locale?: AppLocale } = {},
  ): Promise<ConsentHistory> {
    const id = customerIdSchema.parse(customerId);
    const take = Math.min(500, Math.max(1, Math.trunc(opts.take ?? 200)));
    const locale = opts.locale ?? "en";

    const customer = await prisma.customer.findUnique({
      where: { id },
      select: { id: true, marketingOptIn: true },
    });
    if (!customer) throw new GdprError("CUSTOMER_NOT_FOUND");

    const rows = await prisma.consentRecord.findMany({
      where: { customerId: id, ...(opts.type ? { type: opts.type } : {}) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take,
    });

    const entries: ConsentHistoryEntry[] = rows.map((row) => ({
      id: row.id,
      type: row.type,
      granted: row.granted,
      source: row.source,
      metadata: row.metadata ?? null,
      recordedAt: stamp(row.createdAt, locale),
    }));

    const current: ConsentStateEntry[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.type)) continue;
      seen.add(row.type);
      current.push({
        type: row.type,
        granted: row.granted,
        source: row.source,
        since: stamp(row.createdAt, locale),
      });
    }

    const newestMarketing = current.find((entry) => entry.type === MARKETING_CONSENT_TYPE);
    return {
      customerId: id,
      marketingOptIn: customer.marketingOptIn,
      marketingFlagDrift:
        newestMarketing !== undefined && newestMarketing.granted !== customer.marketingOptIn,
      current,
      entries,
    };
  }
}

export const gdprService = new GdprService();
