import { useEffect, useState } from "react";
import { data, isRouteErrorResponse, Link, useFetcher } from "react-router";
import { toast } from "sonner";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { AlertTriangle, Check, Inbox, X } from "lucide-react";
import type { Route } from "./+types/admin.refunds";
import { db } from "~/db";
import {
  RefundRequestStatus,
  RefundStatus,
  UserRole,
  users,
} from "~/db/schema";
import { getCurrentUserId } from "~/lib/session";
import { parseFormData } from "~/lib/validation";
import { formatPrice } from "~/lib/utils";
import {
  approveRefundRequest,
  declineRefundRequest,
  listOpenRefundRequests,
  listPendingAndFailedRefunds,
  listRefundHistory,
  markRefundFailed,
  markRefundIssued,
  type OpenRefundRequest,
  type PendingOrFailedRefund,
  type RefundHistoryEntry,
} from "~/lib/refund-decisions.server";
import { Card, CardContent } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";

const refundActionSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("approve"),
    refundRequestId: z.coerce.number().int(),
    internalNote: z.string().trim().max(1000).optional(),
  }),
  z.object({
    intent: z.literal("decline"),
    refundRequestId: z.coerce.number().int(),
    declineReason: z.string().trim().max(1000).default(""),
    internalNote: z.string().trim().max(1000).optional(),
  }),
  z.object({
    intent: z.literal("issue"),
    refundId: z.coerce.number().int(),
    internalNote: z.string().trim().max(1000).optional(),
  }),
  z.object({
    intent: z.literal("fail"),
    refundId: z.coerce.number().int(),
    internalNote: z.string().trim().max(1000).optional(),
  }),
]);

type RefundAction = z.infer<typeof refundActionSchema>;

function runRefundAction(input: RefundAction, adminUserId: number) {
  switch (input.intent) {
    case "approve":
      return approveRefundRequest({
        refundRequestId: input.refundRequestId,
        adminUserId,
        internalNote: input.internalNote,
      });
    case "decline":
      return declineRefundRequest({
        refundRequestId: input.refundRequestId,
        adminUserId,
        declineReason: input.declineReason,
        internalNote: input.internalNote,
      });
    case "issue":
      return markRefundIssued({
        refundId: input.refundId,
        adminUserId,
        internalNote: input.internalNote,
      });
    case "fail":
      return markRefundFailed({
        refundId: input.refundId,
        adminUserId,
        internalNote: input.internalNote,
      });
  }
}

const SUCCESS_MESSAGES: Record<RefundAction["intent"], string> = {
  approve: "Refund Request approved. The Refund is now pending.",
  decline: "Refund Request declined.",
  issue: "Refund marked Issued. The learner no longer has access.",
  fail: "Refund marked Failed. The learner keeps access for now.",
};

/** Every loader and action on this screen is for admins only. */
async function requireAdmin(request: Request) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("Select a user from the DevUI panel to manage refunds.", {
      status: 401,
    });
  }

  const currentUser = db
    .select()
    .from(users)
    .where(eq(users.id, currentUserId))
    .get();

  if (!currentUser || currentUser.role !== UserRole.Admin) {
    throw data("Only admins can manage refunds.", { status: 403 });
  }

  return currentUser;
}

export function meta() {
  return [
    { title: "Refunds — Cadence" },
    { name: "description", content: "Decide Refund Requests" },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);

  return {
    openRefundRequests: listOpenRefundRequests(),
    pendingAndFailedRefunds: listPendingAndFailedRefunds(),
    refundHistory: listRefundHistory(),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const admin = await requireAdmin(request);

  const parsed = parseFormData(await request.formData(), refundActionSchema);

  if (!parsed.success) {
    return data({ error: Object.values(parsed.errors)[0] }, { status: 400 });
  }

  const result = runRefundAction(parsed.data, admin.id);

  if (!result.ok) {
    return data({ error: result.reason }, { status: result.status });
  }

  return { success: true, message: SUCCESS_MESSAGES[parsed.data.intent] };
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="text-sm font-medium">{value}</div>
    </div>
  );
}

function OpenRefundRequestCard({ request }: { request: OpenRefundRequest }) {
  const fetcher = useFetcher<typeof action>();
  const [mode, setMode] = useState<"idle" | "approve" | "decline">("idle");
  const busy = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if ("error" in fetcher.data) toast.error(fetcher.data.error);
    if ("success" in fetcher.data) toast.success(fetcher.data.message);
  }, [fetcher.state, fetcher.data]);

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div className="font-medium">{request.learner.name}</div>
            <div className="text-sm text-muted-foreground">
              {request.learner.email}
            </div>
          </div>
          <div className="text-right">
            <Link
              to={`/courses/${request.course.slug}`}
              className="font-medium hover:underline"
            >
              {request.course.title}
            </Link>
            <div className="text-sm text-muted-foreground">
              {formatPrice(request.purchase.amountPaid)} paid on{" "}
              {new Date(request.purchase.purchasedAt).toLocaleDateString()}
            </div>
          </div>
        </div>

        <blockquote className="border-l-2 border-border pl-3 text-sm italic">
          {request.reason}
        </blockquote>

        <div className="grid grid-cols-3 gap-4 rounded-md bg-muted/50 p-3">
          <Fact
            label="Days since purchase"
            value={String(request.facts.daysSincePurchase)}
          />
          <Fact
            label="Lessons completed"
            value={`${request.facts.percentLessonsCompleted}%`}
          />
          <Fact
            label="Hours watched"
            value={request.facts.hoursWatched.toFixed(1)}
          />
        </div>

        {mode === "idle" ? (
          <div className="flex gap-2">
            <Button size="sm" onClick={() => setMode("approve")}>
              <Check className="mr-1.5 size-3.5" />
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setMode("decline")}
            >
              <X className="mr-1.5 size-3.5" />
              Decline
            </Button>
          </div>
        ) : (
          <fetcher.Form method="post" className="space-y-3">
            <input type="hidden" name="intent" value={mode} />
            <input type="hidden" name="refundRequestId" value={request.id} />
            {mode === "decline" && (
              <div className="space-y-1.5">
                <Label htmlFor={`declineReason-${request.id}`}>
                  Decline Reason (shown to the learner)
                </Label>
                <Textarea
                  id={`declineReason-${request.id}`}
                  name="declineReason"
                  required
                />
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor={`internalNote-${request.id}`}>
                Internal Note (optional, never shown to the learner)
              </Label>
              <Textarea id={`internalNote-${request.id}`} name="internalNote" />
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                type="submit"
                variant={mode === "decline" ? "destructive" : "default"}
                disabled={busy}
              >
                {mode === "approve" ? "Confirm approval" : "Confirm decline"}
              </Button>
              <Button
                size="sm"
                type="button"
                variant="ghost"
                onClick={() => setMode("idle")}
              >
                Cancel
              </Button>
            </div>
          </fetcher.Form>
        )}
      </CardContent>
    </Card>
  );
}

function OpenRefundRequestsSection({
  requests,
}: {
  requests: OpenRefundRequest[];
}) {
  return (
    <section className="mb-10">
      <h2 className="mb-4 text-xl font-semibold">
        Open Refund Requests ({requests.length})
      </h2>
      {requests.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            <Inbox className="mx-auto mb-3 size-8 text-muted-foreground/50" />
            No Open Refund Requests.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {requests.map((request) => (
            <OpenRefundRequestCard key={request.id} request={request} />
          ))}
        </div>
      )}
    </section>
  );
}

function PendingOrFailedRefundCard({
  refund,
}: {
  refund: PendingOrFailedRefund;
}) {
  const fetcher = useFetcher<typeof action>();
  const [mode, setMode] = useState<"idle" | "issue" | "fail">("idle");
  const busy = fetcher.state !== "idle";
  const failed = refund.status === RefundStatus.Failed;

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if ("error" in fetcher.data) toast.error(fetcher.data.error);
    if ("success" in fetcher.data) toast.success(fetcher.data.message);
  }, [fetcher.state, fetcher.data]);

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div className="font-medium">{refund.learner.name}</div>
            <div className="text-sm text-muted-foreground">
              {refund.learner.email}
            </div>
          </div>
          <div className="text-right">
            <Link
              to={`/courses/${refund.course.slug}`}
              className="font-medium hover:underline"
            >
              {refund.course.title}
            </Link>
            <div className="text-sm text-muted-foreground">
              {formatPrice(refund.amount)} to refund
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span
            className={
              failed
                ? "rounded-full bg-destructive/10 px-2 py-0.5 font-medium text-destructive"
                : "rounded-full bg-muted px-2 py-0.5 font-medium"
            }
          >
            {failed ? "Failed" : "Pending"}
          </span>
          {refund.approvedAt && (
            <span className="text-muted-foreground">
              Approved {new Date(refund.approvedAt).toLocaleDateString()}
            </span>
          )}
          {failed && refund.failedAt && (
            <span className="text-muted-foreground">
              · Failed {new Date(refund.failedAt).toLocaleDateString()}
            </span>
          )}
        </div>

        {refund.internalNote && (
          <p className="whitespace-pre-line rounded-md bg-muted/50 p-3 text-sm">
            {refund.internalNote}
          </p>
        )}

        {mode === "idle" ? (
          <div className="flex gap-2">
            <Button size="sm" onClick={() => setMode("issue")}>
              <Check className="mr-1.5 size-3.5" />
              Mark Issued
            </Button>
            {!failed && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setMode("fail")}
              >
                <X className="mr-1.5 size-3.5" />
                Mark Failed
              </Button>
            )}
          </div>
        ) : (
          <fetcher.Form method="post" className="space-y-3">
            <input type="hidden" name="intent" value={mode} />
            <input type="hidden" name="refundId" value={refund.id} />
            {mode === "issue" && (
              <p className="text-sm text-muted-foreground">
                Issued is final. The learner loses access to the course; their
                progress is kept.
              </p>
            )}
            <div className="space-y-1.5">
              <Label htmlFor={`refundNote-${refund.id}`}>
                Internal Note (optional, never shown to the learner)
              </Label>
              <Textarea id={`refundNote-${refund.id}`} name="internalNote" />
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                type="submit"
                variant={mode === "fail" ? "destructive" : "default"}
                disabled={busy}
              >
                {mode === "issue" ? "Confirm Issued" : "Confirm Failed"}
              </Button>
              <Button
                size="sm"
                type="button"
                variant="ghost"
                onClick={() => setMode("idle")}
              >
                Cancel
              </Button>
            </div>
          </fetcher.Form>
        )}
      </CardContent>
    </Card>
  );
}

function PendingAndFailedRefundsSection({
  refunds,
}: {
  refunds: PendingOrFailedRefund[];
}) {
  return (
    <section className="mb-10">
      <h2 className="mb-4 text-xl font-semibold">
        Pending &amp; Failed Refunds ({refunds.length})
      </h2>
      {refunds.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            <Inbox className="mx-auto mb-3 size-8 text-muted-foreground/50" />
            No Pending or Failed Refunds.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {refunds.map((refund) => (
            <PendingOrFailedRefundCard key={refund.id} refund={refund} />
          ))}
        </div>
      )}
    </section>
  );
}

const REFUND_STATUS_LABELS: Record<RefundStatus, string> = {
  [RefundStatus.Pending]: "Pending",
  [RefundStatus.Failed]: "Failed",
  [RefundStatus.Issued]: "Issued",
};

function HistoryStep({
  label,
  by,
  at,
}: {
  label: string;
  by: { name: string } | null;
  at: string | null;
}) {
  if (!at) return null;
  return (
    <li>
      <span className="font-medium">{label}</span>{" "}
      <span className="text-muted-foreground">
        by {by?.name ?? "unknown"} on {new Date(at).toLocaleString()}
      </span>
    </li>
  );
}

function InternalNote({ label, note }: { label: string; note: string | null }) {
  if (!note) return null;
  return (
    <div className="rounded-md bg-muted/50 p-3 text-sm">
      <div className="mb-1 text-xs uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <p className="whitespace-pre-line">{note}</p>
    </div>
  );
}

function RefundHistoryCard({ entry }: { entry: RefundHistoryEntry }) {
  const declined = entry.status === RefundRequestStatus.Declined;
  const refund = entry.refund;

  return (
    <Card>
      <CardContent className="space-y-3 p-5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div className="font-medium">{entry.learner.name}</div>
            <div className="text-sm text-muted-foreground">
              {entry.learner.email}
            </div>
          </div>
          <div className="text-right">
            <Link
              to={`/courses/${entry.course.slug}`}
              className="font-medium hover:underline"
            >
              {entry.course.title}
            </Link>
            <div className="text-sm text-muted-foreground">
              {formatPrice(refund?.amount ?? entry.amountPaid)}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span
            className={
              declined
                ? "rounded-full bg-destructive/10 px-2 py-0.5 font-medium text-destructive"
                : "rounded-full bg-muted px-2 py-0.5 font-medium"
            }
          >
            {declined ? "Declined" : "Approved"}
          </span>
          {refund && (
            <span className="rounded-full border px-2 py-0.5 font-medium">
              Refund {REFUND_STATUS_LABELS[refund.status]}
            </span>
          )}
        </div>

        <blockquote className="border-l-2 border-border pl-3 text-sm italic">
          {entry.reason}
        </blockquote>

        <ul className="space-y-1 text-sm">
          <HistoryStep
            label={declined ? "Declined" : "Approved"}
            by={entry.decidedBy}
            at={entry.decidedAt}
          />
          {refund && (
            <>
              <HistoryStep
                label="Marked Failed"
                by={refund.failedBy}
                at={refund.failedAt}
              />
              <HistoryStep
                label="Marked Issued"
                by={refund.issuedBy}
                at={refund.issuedAt}
              />
            </>
          )}
        </ul>

        {entry.declineReason && (
          <div className="text-sm">
            <span className="font-medium">Decline Reason:</span>{" "}
            {entry.declineReason}
          </div>
        )}
        <InternalNote
          label="Internal Note on the decision"
          note={entry.internalNote}
        />
        <InternalNote
          label="Internal Note on the Refund"
          note={refund?.internalNote ?? null}
        />
      </CardContent>
    </Card>
  );
}

function RefundHistorySection({ entries }: { entries: RefundHistoryEntry[] }) {
  return (
    <section className="mb-10">
      <h2 className="mb-4 text-xl font-semibold">History ({entries.length})</h2>
      {entries.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            <Inbox className="mx-auto mb-3 size-8 text-muted-foreground/50" />
            No decided Refund Requests yet.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {entries.map((entry) => (
            <RefundHistoryCard key={entry.id} entry={entry} />
          ))}
        </div>
      )}
    </section>
  );
}

export default function AdminRefunds({ loaderData }: Route.ComponentProps) {
  return (
    <div className="mx-auto max-w-5xl p-6 lg:p-8">
      <nav className="mb-6 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          Home
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">Refunds</span>
      </nav>

      <div className="mb-8">
        <h1 className="text-3xl font-bold">Refunds</h1>
        <p className="mt-1 text-muted-foreground">
          Decide Refund Requests. Eligibility facts are for information only.
        </p>
      </div>

      <OpenRefundRequestsSection requests={loaderData.openRefundRequests} />
      <PendingAndFailedRefundsSection
        refunds={loaderData.pendingAndFailedRefunds}
      />
      <RefundHistorySection entries={loaderData.refundHistory} />
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred while loading refunds.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 401) {
      title = "Sign in required";
    } else if (error.status === 403) {
      title = "Access denied";
    } else {
      title = `Error ${error.status}`;
    }
    message = typeof error.data === "string" ? error.data : error.statusText;
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <Link to="/">
          <Button>Go Home</Button>
        </Link>
      </div>
    </div>
  );
}
