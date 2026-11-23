import { RefundRequestStatus, RefundStatus } from "~/db/schema";
import { formatPrice } from "~/lib/utils";

/**
 * The learner's latest Refund Request on a course, with its Refund if it was
 * approved. Internal Notes may be present here because they live on the same
 * rows, but they never make it into what the learner is shown.
 */
export type LatestRefundRequest = {
  status: RefundRequestStatus;
  declineReason: string | null;
  internalNote: string | null;
  refund: {
    status: RefundStatus;
    amount: number;
    internalNote: string | null;
  } | null;
};

export type RefundStanding = {
  kind: "open" | "pending" | "issued" | "delayed" | "declined";
  heading: string;
  message: string;
};

/** What the learner sees on the course page about their latest Refund Request. */
export function describeRefundStanding(
  request: LatestRefundRequest
): RefundStanding {
  if (request.status === RefundRequestStatus.Declined) {
    return {
      kind: "declined",
      heading: "Refund request declined",
      message: request.declineReason ?? "",
    };
  }

  if (request.status === RefundRequestStatus.Approved) {
    const amount = request.refund ? formatPrice(request.refund.amount) : "your money";
    if (request.refund?.status === RefundStatus.Issued) {
      return {
        kind: "issued",
        heading: "Refund issued",
        message: `We have sent ${amount} back to the card you paid with. Buy the course again any time to pick up where you left off.`,
      };
    }
    if (request.refund?.status === RefundStatus.Failed) {
      return {
        kind: "delayed",
        heading: "Refund delayed",
        message: `Your refund of ${amount} is approved, but sending it is taking longer than expected. We are still working on it, and you keep access to the course meanwhile.`,
      };
    }
    return {
      kind: "pending",
      heading: "Refund approved",
      message: `We are sending ${amount} back to the card you paid with. You keep access to the course until it has been sent.`,
    };
  }

  return {
    kind: "open",
    heading: "Refund requested",
    message:
      "We have your refund request and will reply here once someone has read it.",
  };
}
