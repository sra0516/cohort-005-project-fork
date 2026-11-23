import { describe, it, expect } from "vitest";
import { RefundRequestStatus, RefundStatus } from "~/db/schema";
import { describeRefundStanding } from "./refund-standing";

describe("describeRefundStanding", () => {
  it("tells the learner an Open Refund Request is waiting to be read", () => {
    expect(
      describeRefundStanding({
        status: RefundRequestStatus.Open,
        declineReason: null,
        internalNote: null,
        refund: null,
      })
    ).toEqual({
      kind: "open",
      heading: "Refund requested",
      message:
        "We have your refund request and will reply here once someone has read it.",
    });
  });

  it("shows the Decline Reason on a Declined Refund Request", () => {
    expect(
      describeRefundStanding({
        status: RefundRequestStatus.Declined,
        declineReason: "You finished most of the course before asking.",
        internalNote: null,
        refund: null,
      })
    ).toEqual({
      kind: "declined",
      heading: "Refund request declined",
      message: "You finished most of the course before asking.",
    });
  });

  it("tells the learner an approved Refund is on its way while Pending", () => {
    expect(
      describeRefundStanding({
        status: RefundRequestStatus.Approved,
        declineReason: null,
        internalNote: null,
        refund: { status: RefundStatus.Pending, amount: 7900, internalNote: null },
      })
    ).toEqual({
      kind: "pending",
      heading: "Refund approved",
      message:
        "We are sending $79.00 back to the card you paid with. You keep access to the course until it has been sent.",
    });
  });

  it("tells the learner when their Refund has been Issued", () => {
    expect(
      describeRefundStanding({
        status: RefundRequestStatus.Approved,
        declineReason: null,
        internalNote: null,
        refund: { status: RefundStatus.Issued, amount: 7900, internalNote: null },
      })
    ).toEqual({
      kind: "issued",
      heading: "Refund issued",
      message:
        "We have sent $79.00 back to the card you paid with. Buy the course again any time to pick up where you left off.",
    });
  });

  it("shows a Failed Refund as delayed, not as failed", () => {
    expect(
      describeRefundStanding({
        status: RefundRequestStatus.Approved,
        declineReason: null,
        internalNote: null,
        refund: { status: RefundStatus.Failed, amount: 7900, internalNote: null },
      })
    ).toEqual({
      kind: "delayed",
      heading: "Refund delayed",
      message:
        "Your refund of $79.00 is approved, but sending it is taking longer than expected. We are still working on it, and you keep access to the course meanwhile.",
    });
  });

  it("never passes an Internal Note on to the learner", () => {
    const requests = [
      {
        status: RefundRequestStatus.Declined,
        declineReason: "Outside the refund window.",
        internalNote: "SECRET-request-note",
        refund: null,
      },
      ...[RefundStatus.Pending, RefundStatus.Issued, RefundStatus.Failed].map(
        (status) => ({
          status: RefundRequestStatus.Approved,
          declineReason: null,
          internalNote: "SECRET-request-note",
          refund: { status, amount: 7900, internalNote: "SECRET-refund-note" },
        })
      ),
    ];

    for (const request of requests) {
      expect(JSON.stringify(describeRefundStanding(request))).not.toContain(
        "SECRET"
      );
    }
  });
});
