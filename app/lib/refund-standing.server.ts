import { and, desc, eq } from "drizzle-orm";
import { db } from "~/db";
import { purchases, refundRequests, refunds } from "~/db/schema";
import {
  describeRefundStanding,
  type LatestRefundRequest,
  type RefundStanding,
} from "./refund-standing";

function getLatestRefundRequest(
  userId: number,
  courseId: number
): LatestRefundRequest | undefined {
  const row = db
    .select({
      status: refundRequests.status,
      declineReason: refundRequests.declineReason,
      internalNote: refundRequests.internalNote,
      refundStatus: refunds.status,
      refundAmount: refunds.amount,
      refundInternalNote: refunds.internalNote,
    })
    .from(refundRequests)
    .innerJoin(purchases, eq(refundRequests.purchaseId, purchases.id))
    .leftJoin(refunds, eq(refunds.refundRequestId, refundRequests.id))
    .where(and(eq(purchases.userId, userId), eq(purchases.courseId, courseId)))
    .orderBy(desc(refundRequests.requestedAt), desc(refundRequests.id))
    .get();

  if (!row) return undefined;

  return {
    status: row.status,
    declineReason: row.declineReason,
    internalNote: row.internalNote,
    refund:
      row.refundStatus !== null && row.refundAmount !== null
        ? {
            status: row.refundStatus,
            amount: row.refundAmount,
            internalNote: row.refundInternalNote,
          }
        : null,
  };
}

/**
 * Where the learner's latest Refund Request on a course stands, in the words
 * the course page shows them, or null if they have never asked for a refund.
 * Only this description leaves the server, so Internal Notes stay behind.
 */
export function getRefundStanding(
  userId: number,
  courseId: number
): RefundStanding | null {
  const latest = getLatestRefundRequest(userId, courseId);
  return latest ? describeRefundStanding(latest) : null;
}
