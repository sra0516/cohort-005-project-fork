import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  coupons,
  lessonProgress,
  lessons,
  LessonProgressStatus,
  modules,
  purchases,
  refundRequests,
  RefundRequestStatus,
  refunds,
  RefundStatus,
  videoWatchEvents,
} from "~/db/schema";

export const REFUND_WINDOW_DAYS = 14;
export const REFUND_WATCH_LIMIT_SECONDS = 2 * 60 * 60;
export const REFUND_COMPLETION_LIMIT = 0.5;

export type RefundEligibilityFacts = {
  purchase: { id: number; amountPaid: number; createdAt: string } | undefined;
  hasOpenRefundRequest: boolean;
  /** Statuses of every Refund on this purchase's Approved Refund Requests. */
  refundStatuses: RefundStatus[];
  hasClaimedSeat: boolean;
  completedLessonCount: number;
  totalLessonCount: number;
  secondsWatched: number;
  now: Date;
};

export type RefundEligibility =
  | {
      eligible: true;
      purchaseId: number;
      amount: number;
      lastDayInWindow: string;
    }
  | { eligible: false; reason: string; status: 403 | 409 };

// Compare whole days, not hours — a purchase at 23:00 should still get its
// full fourteenth day.
function asDayString(when: Date) {
  const year = when.getFullYear();
  const month = String(when.getMonth() + 1).padStart(2, "0");
  const day = String(when.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Whether a learner may raise a Refund Request on their latest purchase of a
 * course. The course page uses this to decide whether to offer the button, and
 * the refund action uses it to decide whether to accept the request, so the
 * two can never disagree.
 */
export function decideRefundEligibility(
  facts: RefundEligibilityFacts
): RefundEligibility {
  const { purchase } = facts;

  if (!purchase) {
    return {
      eligible: false,
      reason: "You have not bought this course.",
      status: 403,
    };
  }

  if (facts.hasOpenRefundRequest) {
    return {
      eligible: false,
      reason: "You already have an open refund request on this purchase.",
      status: 409,
    };
  }

  if (
    facts.refundStatuses.some(
      (status) =>
        status === RefundStatus.Pending || status === RefundStatus.Failed
    )
  ) {
    return {
      eligible: false,
      reason: "This purchase already has a refund in progress.",
      status: 409,
    };
  }

  // A seat that came out of a team licence, and has been claimed, belongs to
  // the team — the learner cannot hand it back on their own.
  if (facts.hasClaimedSeat) {
    return {
      eligible: false,
      reason: "A claimed team seat cannot be refunded.",
      status: 403,
    };
  }

  const purchasedDay = asDayString(new Date(purchase.createdAt));
  const windowEnd = new Date(purchase.createdAt);
  windowEnd.setDate(windowEnd.getDate() + REFUND_WINDOW_DAYS);
  const lastDayInWindow = asDayString(windowEnd);
  const today = asDayString(facts.now);

  if (today < purchasedDay || today > lastDayInWindow) {
    return {
      eligible: false,
      reason: `The ${REFUND_WINDOW_DAYS}-day window has closed.`,
      status: 403,
    };
  }

  if (
    facts.totalLessonCount > 0 &&
    facts.completedLessonCount / facts.totalLessonCount >=
      REFUND_COMPLETION_LIMIT
  ) {
    return {
      eligible: false,
      reason: "You have completed too much of this course to request a refund.",
      status: 403,
    };
  }

  if (facts.secondsWatched >= REFUND_WATCH_LIMIT_SECONDS) {
    return {
      eligible: false,
      reason: "You have watched too much of this course to request a refund.",
      status: 403,
    };
  }

  return {
    eligible: true,
    purchaseId: purchase.id,
    amount: purchase.amountPaid,
    lastDayInWindow,
  };
}

function getLatestPurchase(userId: number, courseId: number) {
  return db
    .select({
      id: purchases.id,
      amountPaid: purchases.amountPaid,
      createdAt: purchases.createdAt,
    })
    .from(purchases)
    .where(and(eq(purchases.userId, userId), eq(purchases.courseId, courseId)))
    .orderBy(sql`${purchases.createdAt} desc`)
    .get();
}

function getLessonIdsForCourse(courseId: number): number[] {
  return db
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .all()
    .map((row) => row.id);
}

function hasOpenRefundRequest(purchaseId: number) {
  const row = db
    .select({ id: refundRequests.id })
    .from(refundRequests)
    .where(
      and(
        eq(refundRequests.purchaseId, purchaseId),
        eq(refundRequests.status, RefundRequestStatus.Open)
      )
    )
    .get();
  return row !== undefined;
}

function getRefundStatuses(purchaseId: number): RefundStatus[] {
  return db
    .select({ status: refunds.status })
    .from(refunds)
    .innerJoin(refundRequests, eq(refunds.refundRequestId, refundRequests.id))
    .where(eq(refundRequests.purchaseId, purchaseId))
    .all()
    .map((row) => row.status);
}

function hasClaimedSeat(purchaseId: number) {
  const row = db
    .select({ id: coupons.id })
    .from(coupons)
    .where(
      and(eq(coupons.purchaseId, purchaseId), isNotNull(coupons.redeemedAt))
    )
    .get();
  return row !== undefined;
}

function getCompletedLessonCount(userId: number, lessonIds: number[]) {
  if (lessonIds.length === 0) return 0;

  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(lessonProgress)
    .where(
      and(
        eq(lessonProgress.userId, userId),
        eq(lessonProgress.status, LessonProgressStatus.Completed),
        inArray(lessonProgress.lessonId, lessonIds)
      )
    )
    .get();

  return result?.count ?? 0;
}

function getSecondsWatched(userId: number, lessonIds: number[]) {
  if (lessonIds.length === 0) return 0;

  return db
    .select({
      furthest: sql<number>`max(${videoWatchEvents.positionSeconds})`,
    })
    .from(videoWatchEvents)
    .where(
      and(
        eq(videoWatchEvents.userId, userId),
        inArray(videoWatchEvents.lessonId, lessonIds)
      )
    )
    .groupBy(videoWatchEvents.lessonId)
    .all()
    .reduce((total, row) => total + row.furthest, 0);
}

export function getRefundEligibility(
  userId: number,
  courseId: number,
  now: Date = new Date()
): RefundEligibility {
  const purchase = getLatestPurchase(userId, courseId);
  const lessonIds = getLessonIdsForCourse(courseId);

  return decideRefundEligibility({
    purchase,
    hasOpenRefundRequest: purchase ? hasOpenRefundRequest(purchase.id) : false,
    refundStatuses: purchase ? getRefundStatuses(purchase.id) : [],
    hasClaimedSeat: purchase ? hasClaimedSeat(purchase.id) : false,
    completedLessonCount: getCompletedLessonCount(userId, lessonIds),
    totalLessonCount: lessonIds.length,
    secondsWatched: getSecondsWatched(userId, lessonIds),
    now,
  });
}
