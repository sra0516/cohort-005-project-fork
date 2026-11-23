import { and, asc, eq } from "drizzle-orm";
import { db } from "~/db";
import { getLearnerCourseProgress } from "~/lib/refund-eligibility.server";
import {
  courses,
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
