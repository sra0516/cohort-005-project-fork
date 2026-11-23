import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "~/db";
import { getLearnerCourseProgress } from "~/lib/refund-eligibility.server";
import {
  courses,
  enrollments,
  users,
  purchases,
  refundRequests,
  RefundRequestStatus,
  refunds,
  RefundStatus,
} from "~/db/schema";

type RefundRequestRow = typeof refundRequests.$inferSelect;
type RefundRow = typeof refunds.$inferSelect;

export type RefundDecisionFailure = {
  ok: false;
  reason: string;
  status: 400 | 404 | 409;
};

type DecisionInput = {
  refundRequestId: number;
  adminUserId: number;
  internalNote?: string | null;
  now?: Date;
};

function isOpen(refundRequestId: number) {
  return and(
    eq(refundRequests.id, refundRequestId),
    eq(refundRequests.status, RefundRequestStatus.Open)
  );
}

function undecidableRequest(refundRequestId: number): RefundDecisionFailure {
  const exists = db
    .select({ id: refundRequests.id })
    .from(refundRequests)
    .where(eq(refundRequests.id, refundRequestId))
    .get();

  return exists
    ? {
        ok: false,
        reason: "This Refund Request has already been decided.",
        status: 409,
      }
    : { ok: false, reason: "Refund Request not found.", status: 404 };
}

const DAY_MS = 86_400_000;

/**
 * Every Open Refund Request, oldest first, with the learner's eligibility facts
 * as they stand now. The facts are for the admin's information only — they
 * never block a decision.
 */
export function listOpenRefundRequests(now: Date = new Date()) {
  const rows = db
    .select({
      id: refundRequests.id,
      reason: refundRequests.reason,
      requestedAt: refundRequests.requestedAt,
      learner: { id: users.id, name: users.name, email: users.email },
      course: { id: courses.id, title: courses.title, slug: courses.slug },
      purchase: {
        amountPaid: purchases.amountPaid,
        purchasedAt: purchases.createdAt,
      },
    })
    .from(refundRequests)
    .innerJoin(purchases, eq(refundRequests.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(refundRequests.status, RefundRequestStatus.Open))
    .orderBy(asc(refundRequests.requestedAt), asc(refundRequests.id))
    .all();

  return rows.map((row) => {
    const progress = getLearnerCourseProgress(row.learner.id, row.course.id);
    const elapsed = now.getTime() - new Date(row.purchase.purchasedAt).getTime();
    return {
      ...row,
      facts: {
        daysSincePurchase: Math.max(0, Math.floor(elapsed / DAY_MS)),
        percentLessonsCompleted:
          progress.totalLessonCount === 0
            ? 0
            : Math.round(
                (progress.completedLessonCount / progress.totalLessonCount) *
                  100
              ),
        hoursWatched: Math.round((progress.secondsWatched / 3600) * 10) / 10,
      },
    };
  });
}

export type OpenRefundRequest = ReturnType<typeof listOpenRefundRequests>[number];

/**
 * Approve an Open Refund Request. Records who decided and when, and creates a
 * Pending Refund for the full amount paid. Decisions are final.
 */
export function approveRefundRequest(
  input: DecisionInput
):
  | { ok: true; refundRequest: RefundRequestRow; refund: RefundRow }
  | RefundDecisionFailure {
  return db.transaction((tx) => {
    const refundRequest = tx
      .update(refundRequests)
      .set({
        status: RefundRequestStatus.Approved,
        decidedAt: (input.now ?? new Date()).toISOString(),
        decidedByUserId: input.adminUserId,
        internalNote: input.internalNote?.trim() || null,
      })
      .where(isOpen(input.refundRequestId))
      .returning()
      .get();

    if (!refundRequest) {
      return undecidableRequest(input.refundRequestId);
    }

    const purchase = tx
      .select({ amountPaid: purchases.amountPaid })
      .from(purchases)
      .where(eq(purchases.id, refundRequest.purchaseId))
      .get();

    const refund = tx
      .insert(refunds)
      .values({
        refundRequestId: refundRequest.id,
        amount: purchase!.amountPaid,
        status: RefundStatus.Pending,
      })
      .returning()
      .get();

    return { ok: true as const, refundRequest, refund };
  });
}

/**
 * Decline an Open Refund Request. The Decline Reason is required and is shown
 * to the learner; the Internal Note is optional and never is.
 */
export function declineRefundRequest(
  input: DecisionInput & { declineReason: string }
): { ok: true; refundRequest: RefundRequestRow } | RefundDecisionFailure {
  const declineReason = input.declineReason.trim();

  if (!declineReason) {
    return {
      ok: false,
      reason: "A Decline Reason is required to decline a Refund Request.",
      status: 400,
    };
  }

  const refundRequest = db
    .update(refundRequests)
    .set({
      status: RefundRequestStatus.Declined,
      decidedAt: (input.now ?? new Date()).toISOString(),
      decidedByUserId: input.adminUserId,
      declineReason,
      internalNote: input.internalNote?.trim() || null,
    })
    .where(isOpen(input.refundRequestId))
    .returning()
    .get();

  if (!refundRequest) {
    return undecidableRequest(input.refundRequestId);
  }

  return { ok: true, refundRequest };
}

/**
 * Every Refund still waiting on the payout (Pending) or whose payout went wrong
 * (Failed), oldest approval first.
 */
export function listPendingAndFailedRefunds() {
  return db
    .select({
      id: refunds.id,
      amount: refunds.amount,
      status: refunds.status,
      internalNote: refunds.internalNote,
      confirmedAt: refunds.confirmedAt,
      approvedAt: refundRequests.decidedAt,
      learner: { id: users.id, name: users.name, email: users.email },
      course: { id: courses.id, title: courses.title, slug: courses.slug },
    })
    .from(refunds)
    .innerJoin(refundRequests, eq(refunds.refundRequestId, refundRequests.id))
    .innerJoin(purchases, eq(refundRequests.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(inArray(refunds.status, [RefundStatus.Pending, RefundStatus.Failed]))
    .orderBy(asc(refunds.createdAt), asc(refunds.id))
    .all();
}

export type PendingOrFailedRefund = ReturnType<
  typeof listPendingAndFailedRefunds
>[number];

type ConfirmationInput = {
  refundId: number;
  adminUserId: number;
  internalNote?: string | null;
  now?: Date;
};

function unconfirmableRefund(
  refundId: number,
  target: RefundStatus
): RefundDecisionFailure {
  const refund = db
    .select({ status: refunds.status })
    .from(refunds)
    .where(eq(refunds.id, refundId))
    .get();

  if (!refund) {
    return { ok: false, reason: "Refund not found.", status: 404 };
  }

  return {
    ok: false,
    reason:
      refund.status === RefundStatus.Issued
        ? "This Refund has already been Issued."
        : `A ${refund.status} Refund cannot be marked ${target}.`,
    status: 409,
  };
}

/**
 * Adds a new Internal Note on its own line after any earlier one, so the note
 * left when a Refund Failed survives it being Issued later.
 */
function withInternalNote(internalNote: string | null | undefined) {
  const note = internalNote?.trim();
  if (!note) return {};
  return {
    internalNote: sql<string>`coalesce(${refunds.internalNote} || char(10), '') || ${note}`,
  };
}

/**
 * Mark a Pending Refund Failed: the payout outside the app did not go through.
 * The learner keeps access; the Refund can be marked Issued later.
 */
export function markRefundFailed(
  input: ConfirmationInput
): { ok: true; refund: RefundRow } | RefundDecisionFailure {
  const refund = db
    .update(refunds)
    .set({
      status: RefundStatus.Failed,
      confirmedAt: (input.now ?? new Date()).toISOString(),
      confirmedByUserId: input.adminUserId,
      ...withInternalNote(input.internalNote),
    })
    .where(
      and(eq(refunds.id, input.refundId), eq(refunds.status, RefundStatus.Pending))
    )
    .returning()
    .get();

  if (!refund) {
    return unconfirmableRefund(input.refundId, RefundStatus.Failed);
  }

  return { ok: true, refund };
}

/**
 * Mark a Pending or Failed Refund Issued:the payout happened outside the app.
 * Issued is final. In the same transaction the learner's enrollment is removed,
 * so they lose access to the course; lesson progress and watch history stay.
 */
export function markRefundIssued(
  input: ConfirmationInput
): { ok: true; refund: RefundRow } | RefundDecisionFailure {
  return db.transaction((tx) => {
    const refund = tx
      .update(refunds)
      .set({
        status: RefundStatus.Issued,
        confirmedAt: (input.now ?? new Date()).toISOString(),
        confirmedByUserId: input.adminUserId,
        ...withInternalNote(input.internalNote),
      })
      .where(
        and(
          eq(refunds.id, input.refundId),
          inArray(refunds.status, [RefundStatus.Pending, RefundStatus.Failed])
        )
      )
      .returning()
      .get();

    if (!refund) {
      return unconfirmableRefund(input.refundId, RefundStatus.Issued);
    }

    const purchase = tx
      .select({ userId: purchases.userId, courseId: purchases.courseId })
      .from(refundRequests)
      .innerJoin(purchases, eq(refundRequests.purchaseId, purchases.id))
      .where(eq(refundRequests.id, refund.refundRequestId))
      .get()!;

    tx.delete(enrollments)
      .where(
        and(
          eq(enrollments.userId, purchase.userId),
          eq(enrollments.courseId, purchase.courseId)
        )
      )
      .run();

    return { ok: true as const, refund };
  });
}