"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  captureNowHint,
  noMoneyApproveMessage,
  shouldShowCaptureNow,
} from "@/lib/desk/approve-copy";
import {
  coerceRecoveredBoardRow,
  mergeRecoveredBoard,
  serverHasRecovery,
  sumRecoveredBoardUsd,
  upsertOptimisticRecovered,
  type RecoveredBoardRow,
} from "@/lib/desk/merge-recovered";

type Money = { currency_code: string; value: string };

type DeskSub = {
  key: string;
  id: string;
  status: string;
  outstanding: Money | null;
  outstandingValue: number;
  failurePath: string;
  preferredCaptureTarget: boolean;
  fixtureLabeled: boolean;
  failedPaymentsCount: number | null;
  refreshedAt: string;
};

type ProposalPayload = {
  proposalId: string;
  status: string;
  proposal: {
    subscriptionId: string;
    action: string;
    rationale: string;
    impact?: Money;
    proposedPrice?: Money;
    fixtureLabeled?: boolean;
  };
  policy: { ok: true } | { ok: false; reason: string };
  ai?: {
    source: "gemini" | "fallback" | "rule";
    model: string;
    reason?: string;
  };
  customerMessage?: string | null;
  subscription?: {
    id: string;
    status: string;
    outstanding: Money | null;
    preferredCaptureTarget?: boolean;
    fixtureLabeled?: boolean;
  };
};

type ApproveResult = {
  ok?: boolean;
  pending?: boolean;
  deskStatus?: string;
  message?: string;
  error?: string;
  detail?: string;
  proposalId?: string;
  outstandingAfter?: Money | null;
  recovered?: unknown;
  activate?: unknown;
  paypal?: unknown;
  proposal?: unknown;
};

type WebhookInboxRow = {
  receivedAt: string;
  eventId: string | null;
  eventType: string | null;
  resourceId: string | null;
  duplicate: boolean;
  verification: string;
  interesting: boolean;
  moneyProof: false;
};

/** Customer-facing card titles — hide internal seed path keys on the desk. */
const CUSTOMER_LABELS: Record<string, string> = {
  "outstanding-smoke": "Northwind Yoga",
  "outstanding-film": "Harbor Coffee Club",
  "outstanding-judge-1": "Brightline Studio",
  "outstanding-judge-2": "Cedar Fitness",
  "setup-fee-continue": "Cleared renewal (archive)",
};

const POLL_MAX_ATTEMPTS = 12;
const POLL_INTERVAL_MS = 5_000;
/** Bounded post-settle MRR confirm polls (same cadence, fewer rounds). */
const MRR_POLL_MAX_ATTEMPTS = 6;

function customerLabel(key: string): string {
  return CUSTOMER_LABELS[key] || key.replace(/-/g, " ");
}

export function RecoveryDesk() {
  const [subs, setSubs] = useState<DeskSub[]>([]);
  const [preferredCaptureId, setPreferredCaptureId] = useState(
    "I-CNCX69GD2UD8"
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [proposal, setProposal] = useState<ProposalPayload | null>(null);
  const [approveBusy, setApproveBusy] = useState(false);
  const [approveResult, setApproveResult] = useState<ApproveResult | null>(
    null
  );
  const [demoPasscode, setDemoPasscode] = useState("");
  const [serverRecovered, setServerRecovered] = useState<RecoveredBoardRow[]>(
    []
  );
  const [optimisticRecovered, setOptimisticRecovered] = useState<
    RecoveredBoardRow[]
  >([]);
  const [mrrPulse, setMrrPulse] = useState(false);
  const [webhookInbox, setWebhookInbox] = useState<WebhookInboxRow[]>([]);
  const [showFixtures, setShowFixtures] = useState(false);
  const [pendPoll, setPendPoll] = useState<{
    subscriptionId: string;
    proposalId: string;
    attempt: number;
    max: number;
  } | null>(null);
  const mrrPrev = useRef<number | null>(null);
  const pollTimer = useRef<number | null>(null);
  const mrrPollTimer = useRef<number | null>(null);
  const passcodeRef = useRef(demoPasscode);
  passcodeRef.current = demoPasscode;
  const optimisticRef = useRef(optimisticRecovered);
  optimisticRef.current = optimisticRecovered;

  const recovered = mergeRecoveredBoard(serverRecovered, optimisticRecovered);
  const recoveredTotal = sumRecoveredBoardUsd(recovered);

  const applyServerMrr = useCallback((rows: RecoveredBoardRow[]) => {
    setServerRecovered(rows);
  }, []);

  const ingestOptimisticRecovery = useCallback((raw: unknown) => {
    const row = coerceRecoveredBoardRow(raw);
    if (!row) return null;
    setOptimisticRecovered((prev) => upsertOptimisticRecovered(prev, row));
    return row;
  }, []);

  const refreshBoards = useCallback(async (): Promise<{
    rows: RecoveredBoardRow[];
    totalUsd: number;
  } | null> => {
    try {
      const [mrrRes, whRes] = await Promise.all([
        fetch("/api/recovered-mrr", { cache: "no-store" }),
        fetch("/api/webhooks/inbox", { cache: "no-store" }),
      ]);
      const mrr = await mrrRes.json();
      let board: { rows: RecoveredBoardRow[]; totalUsd: number } | null = null;
      if (mrrRes.ok) {
        const rows = (mrr.rows || []) as RecoveredBoardRow[];
        // Merge overlay in display; never wipe optimistic on lag/empty.
        applyServerMrr(rows);
        board = {
          rows: mergeRecoveredBoard(rows, optimisticRef.current),
          totalUsd: sumRecoveredBoardUsd(
            mergeRecoveredBoard(rows, optimisticRef.current)
          ),
        };
      }
      const wh = await whRes.json();
      if (whRes.ok) {
        setWebhookInbox(wh.events || []);
      }
      return board;
    } catch {
      /* boards are secondary — don't block desk */
      return null;
    }
  }, [applyServerMrr]);

  /** After RECOVERED: poll board until PayPal txn appears or total rises. */
  function startMrrConfirmPoll(opts: {
    baselineTotal: number;
    transactionId: string | null;
    proposalId?: string;
    rowId?: string;
  }) {
    if (mrrPollTimer.current != null) {
      window.clearTimeout(mrrPollTimer.current);
      mrrPollTimer.current = null;
    }

    const tick = async (attempt: number) => {
      if (attempt >= MRR_POLL_MAX_ATTEMPTS) {
        mrrPollTimer.current = null;
        return;
      }
      try {
        const board = await refreshBoards();
        if (board) {
          const totalUp = board.totalUsd > opts.baselineTotal + 1e-9;
          const txnSeen = serverHasRecovery(board.rows, {
            transactionId: opts.transactionId,
            proposalId: opts.proposalId,
            id: opts.rowId,
          });
          if (totalUp || txnSeen) {
            mrrPollTimer.current = null;
            return;
          }
        }
      } catch {
        /* keep polling */
      }
      mrrPollTimer.current = window.setTimeout(() => {
        void tick(attempt + 1);
      }, POLL_INTERVAL_MS);
    };

    mrrPollTimer.current = window.setTimeout(() => {
      void tick(0);
    }, POLL_INTERVAL_MS);
  }

  function handleRecoveredResult(data: ApproveResult) {
    const baseline = recoveredTotal;
    const row = ingestOptimisticRecovery(data.recovered);
    startMrrConfirmPoll({
      baselineTotal: baseline,
      transactionId: row?.transactionId ?? null,
      proposalId: row?.proposalId,
      rowId: row?.id,
    });
  }

  /** Reload subscriptions without wiping proposal / approve UI (poll + settle). */
  const refreshSubsSilent = useCallback(async (): Promise<DeskSub[]> => {
    const res = await fetch("/api/subscriptions", { cache: "no-store" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const list = (data.subscriptions || []) as DeskSub[];
    setSubs(list);
    if (data.preferredCaptureId) {
      setPreferredCaptureId(data.preferredCaptureId);
    }
    await refreshBoards();
    return list;
  }, [refreshBoards]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    // Clear desk proposal UI so Refresh does not leave a stale Propose panel.
    setProposal(null);
    setApproveResult(null);
    setApproveBusy(false);
    setDemoPasscode("");
    setSelectedId(null);
    setPendPoll(null);
    if (pollTimer.current != null) {
      window.clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
    try {
      const list = await refreshSubsSilent();
      const preferred =
        list.find((s) => s.preferredCaptureTarget) || list[0];
      if (preferred) setSelectedId(preferred.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Refresh failed");
    } finally {
      setLoading(false);
    }
  }, [refreshSubsSilent]);

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount once
  }, []);

  useEffect(() => {
    if (mrrPrev.current === null) {
      mrrPrev.current = recoveredTotal;
      return;
    }
    if (mrrPrev.current !== recoveredTotal) {
      mrrPrev.current = recoveredTotal;
      setMrrPulse(true);
      const t = window.setTimeout(() => setMrrPulse(false), 700);
      return () => window.clearTimeout(t);
    }
  }, [recoveredTotal]);

  useEffect(() => {
    return () => {
      if (pollTimer.current != null) window.clearTimeout(pollTimer.current);
      if (mrrPollTimer.current != null)
        window.clearTimeout(mrrPollTimer.current);
    };
  }, []);

  async function propose(opts?: {
    demoWriteOff?: boolean;
    forceRevise?: boolean;
    forceCapture?: boolean;
  }) {
    setError(null);
    setApproveResult(null);
    setPendPoll(null);
    const subscriptionId = selectedId || preferredCaptureId;
    const res = await fetch("/api/proposals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscriptionId, ...opts }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || `Propose HTTP ${res.status}`);
      return;
    }
    setProposal(data);
  }

  async function settlePending(proposalId: string): Promise<ApproveResult> {
    const res = await fetch(
      `/api/proposals/${encodeURIComponent(proposalId)}/approve`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-demo-passcode": passcodeRef.current,
        },
        body: JSON.stringify({ passcode: passcodeRef.current }),
      }
    );
    return (await res.json()) as ApproveResult;
  }

  function startPendPoll(opts: {
    subscriptionId: string;
    proposalId: string;
  }) {
    setPendPoll({
      subscriptionId: opts.subscriptionId,
      proposalId: opts.proposalId,
      attempt: 0,
      max: POLL_MAX_ATTEMPTS,
    });

    const tick = async (attempt: number, proposalId: string) => {
      if (attempt >= POLL_MAX_ATTEMPTS) {
        setPendPoll(null);
        setApproveResult((prev) => ({
          ...(prev || {}),
          pending: true,
          deskStatus: "CAPTURE_PEND",
          message:
            "Pending PayPal confirmation — still outstanding after poll. Use Refresh later.",
        }));
        return;
      }
      setPendPoll({
        subscriptionId: opts.subscriptionId,
        proposalId,
        attempt: attempt + 1,
        max: POLL_MAX_ATTEMPTS,
      });
      try {
        const list = await refreshSubsSilent();
        const row = list.find((s) => s.id === opts.subscriptionId);
        if (row && row.outstandingValue <= 0) {
          const settled = await settlePending(proposalId);
          if (settled.proposalId) {
            setProposal((p) =>
              p
                ? { ...p, proposalId: settled.proposalId || p.proposalId }
                : p
            );
          }
          setApproveResult(settled);
          if (settled.deskStatus === "RECOVERED" || settled.ok) {
            setPendPoll(null);
            if (settled.deskStatus === "RECOVERED") {
              handleRecoveredResult(settled);
            }
            await refreshSubsSilent();
            return;
          }
        }
      } catch {
        /* keep polling */
      }
      pollTimer.current = window.setTimeout(() => {
        void tick(attempt + 1, proposalId);
      }, POLL_INTERVAL_MS);
    };

    pollTimer.current = window.setTimeout(() => {
      void tick(0, opts.proposalId);
    }, POLL_INTERVAL_MS);
  }

  async function approve() {
    if (!proposal?.proposalId) return;
    const isCapture = proposal.proposal.action === "capture_outstanding";
    if (isCapture) {
      const ok = window.confirm(
        `Approve LIVE capture on ${proposal.proposal.subscriptionId}?\n\nThis calls PayPal OUTSTANDING_BALANCE capture. Only proceed when ready for a live recovery. Cancel to stay on dry review.`
      );
      if (!ok) return;
    }
    setApproveBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/proposals/${encodeURIComponent(proposal.proposalId)}/approve`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-demo-passcode": demoPasscode,
          },
          body: JSON.stringify({ passcode: demoPasscode }),
        }
      );
      const data = (await res.json()) as ApproveResult;

      if (data.deskStatus === "CAPTURE_PEND" || data.pending) {
        const nextId = data.proposalId || proposal.proposalId;
        setProposal((p) =>
          p ? { ...p, proposalId: nextId } : p
        );
        setApproveResult(data);
        startPendPoll({
          subscriptionId: proposal.proposal.subscriptionId,
          proposalId: nextId,
        });
        return;
      }

      if (!res.ok || data.ok === false) {
        setError(data.error || data.message || `Approve HTTP ${res.status}`);
        setApproveResult(data);
        return;
      }
      setApproveResult(data);
      if (data.deskStatus === "RECOVERED") {
        handleRecoveredResult(data);
      }
      await refreshSubsSilent();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Approve failed");
    } finally {
      setApproveBusy(false);
    }
  }

  async function deny() {
    if (!proposal?.proposalId) return;
    const res = await fetch(
      `/api/proposals/${encodeURIComponent(proposal.proposalId)}/deny`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-demo-passcode": demoPasscode,
        },
        body: JSON.stringify({ passcode: demoPasscode }),
      }
    );
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || "Deny failed");
      return;
    }
    setApproveResult(data);
  }

  const policyOk =
    Boolean(proposal?.policy.ok) && proposal?.status !== "BLOCKED";
  const aiSource = proposal?.ai?.source;
  const aiIsGemini = aiSource === "gemini";
  const aiIsRule = aiSource === "rule";
  const isPend =
    approveResult?.deskStatus === "CAPTURE_PEND" || approveResult?.pending;
  const isRecovered = approveResult?.deskStatus === "RECOVERED";
  const isNoMoney = approveResult?.deskStatus === "NO_MONEY";
  const selectedSub = subs.find((s) => s.id === selectedId);
  const showCaptureNow = shouldShowCaptureNow({
    outstandingValue: selectedSub?.outstandingValue ?? 0,
    proposalAction: proposal?.proposal.action,
  });
  const captureHint =
    showCaptureNow && proposal
      ? captureNowHint({
          action: proposal.proposal.action,
          aiSource: proposal.ai?.source,
          outstandingValue: selectedSub?.outstandingValue ?? 0,
          currencyCode:
            selectedSub?.outstanding?.currency_code ||
            proposal.proposal.impact?.currency_code ||
            "USD",
        })
      : null;

  const visibleSubs = showFixtures
    ? subs
    : subs.filter((s) => !(s.fixtureLabeled || s.outstandingValue <= 0));

  return (
    <main className="desk">
      <header className="brand-block">
        <h1 className="brand">Renewal Rescue</h1>
        <p className="lede">
          Recover failed subscription renewals — propose with AI, gate with
          policy, approve as the merchant. Capture only when outstanding is
          live; never auto-capture.
        </p>
      </header>

      <div className="toolbar" aria-label="Desk actions">
        <button
          type="button"
          className="primary"
          onClick={() => void refresh()}
          disabled={loading}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
        <button
          type="button"
          onClick={() => void propose()}
          disabled={!selectedId}
        >
          Propose
        </button>
        <button
          type="button"
          className="ghost"
          onClick={() => void propose({ forceRevise: true })}
          disabled={!selectedId}
        >
          Revise
        </button>
        <button
          type="button"
          className="danger"
          onClick={() => void propose({ demoWriteOff: true })}
          disabled={!selectedId}
        >
          Deny demo
        </button>
      </div>

      <section className="section" aria-labelledby="subs-heading">
        <div className="section-head">
          <h2 id="subs-heading">Subscriptions</h2>
          <p className="hint">
            Select a customer, then Propose. Live outstanding only by default.
          </p>
        </div>
        <label className="toggle-fixtures">
          <input
            type="checkbox"
            checked={showFixtures}
            onChange={(e) => setShowFixtures(e.target.checked)}
          />
          Show fixture / $0 rows
        </label>
        <div className="sub-grid">
          {visibleSubs.length === 0 ? (
            <p className="empty">
              No live outstanding subscriptions. Toggle fixtures to review
              archive rows.
            </p>
          ) : (
            visibleSubs.map((s) => {
              const selected = selectedId === s.id;
              const label = customerLabel(s.key);
              return (
                <label
                  key={s.id}
                  className={`sub-row${selected ? " selected" : ""}`}
                >
                  <input
                    type="radio"
                    name="sub"
                    checked={selected}
                    onChange={() => setSelectedId(s.id)}
                    aria-label={`Select ${label}`}
                  />
                  <div className="sub-row-body">
                    <div className="sub-row-top">
                      <span className="path">{label}</span>
                      {s.preferredCaptureTarget ? (
                        <span className="badge quiet-live">Preferred</span>
                      ) : null}
                      {s.outstandingValue > 0 ? (
                        <span className="badge quiet-live">Outstanding</span>
                      ) : (
                        <span className="badge quiet-fixture">Fixture</span>
                      )}
                      <span className="badge quiet-status">{s.status}</span>
                    </div>
                    <div className="sub-metrics">
                      <div>
                        <span className="label">Id</span>
                        <strong>{s.id}</strong>
                      </div>
                      <div>
                        <span className="label">Outstanding</span>
                        <strong>
                          {s.outstanding
                            ? `${s.outstanding.value} ${s.outstanding.currency_code}`
                            : "0"}
                        </strong>
                      </div>
                      <div>
                        <span className="label">Status</span>
                        <strong>{s.status}</strong>
                      </div>
                      <div>
                        <span className="label">Failed</span>
                        <strong>{s.failedPaymentsCount ?? "n/a"}</strong>
                      </div>
                    </div>
                  </div>
                </label>
              );
            })
          )}
        </div>
      </section>

      {proposal && (
        <section
          className="proposal-panel"
          aria-labelledby="proposal-heading"
        >
          <h2 id="proposal-heading" className="proposal-title">
            Proposal
            {proposal.proposal.fixtureLabeled ? (
              <span className="badge quiet-fixture">Fixture</span>
            ) : (
              <span className="badge quiet-live">Live candidate</span>
            )}
            <span className="muted">· {proposal.status}</span>
          </h2>

          <div
            className={`ai-spotlight${aiIsGemini ? "" : " fallback"}${aiIsRule ? " rule" : ""}`}
          >
            <div className="ai-label">
              {aiIsGemini ? (
                <>
                  <span className="badge ai-gemini">Gemini</span>
                  {proposal.ai?.model ? (
                    <span className="muted">{proposal.ai.model}</span>
                  ) : null}
                </>
              ) : aiIsRule ? (
                <span className="badge ai-rule">
                  RULE
                  {proposal.ai?.reason ? ` · ${proposal.ai.reason}` : ""}
                </span>
              ) : (
                <>
                  <span className="badge ai-fallback">
                    Fallback
                    {proposal.ai?.reason ? ` · ${proposal.ai.reason}` : ""}
                  </span>
                  {proposal.ai?.model ? (
                    <span className="muted">{proposal.ai.model}</span>
                  ) : null}
                </>
              )}
            </div>
            <p className="customer-draft">
              <em>Customer draft</em>
              {proposal.customerMessage?.trim()
                ? proposal.customerMessage
                : "No customer draft from this propose path."}
            </p>
          </div>

          <div className="proposal-meta">
            <span>
              Action <strong>{proposal.proposal.action}</strong>
            </span>
            <span>
              Policy{" "}
              <strong>
                {proposal.policy.ok
                  ? "OK"
                  : `Blocked — ${proposal.policy.reason}`}
              </strong>
            </span>
          </div>
          {showCaptureNow && captureHint ? (
            <div className="capture-override">
              <p className="hint">{captureHint}</p>
              <button
                type="button"
                onClick={() => void propose({ forceCapture: true })}
                disabled={!selectedId}
              >
                Capture now
              </button>
            </div>
          ) : null}
          <p className="rationale">{proposal.proposal.rationale}</p>

          <label className="passcode-field">
            Demo passcode
            <input
              type="password"
              autoComplete="off"
              value={demoPasscode}
              onChange={(e) => setDemoPasscode(e.target.value)}
              placeholder="Required for Approve / Deny"
            />
          </label>

          <div className="proposal-actions">
            <button
              type="button"
              className={policyOk ? "primary" : "ghost"}
              disabled={approveBusy || !policyOk || Boolean(pendPoll)}
              onClick={() => void approve()}
            >
              {approveBusy ? "Approving…" : "Approve"}
            </button>
            <button type="button" className="danger" onClick={() => void deny()}>
              Deny
            </button>
          </div>

          <details className="raw-json">
            <summary>Raw proposal JSON</summary>
            <pre>{JSON.stringify(proposal, null, 2)}</pre>
          </details>
        </section>
      )}

      {approveResult != null && (
        <section className="section">
          <div className="section-head">
            <h2>Approve / Deny result</h2>
          </div>
          {isPend ? (
            <div className="result-banner pend" role="status">
              <strong>Pending PayPal confirmation</strong>
              <span>
                {approveResult.message ||
                  "Capture accepted; waiting for outstanding to clear."}
              </span>
              {pendPoll ? (
                <span className="muted">
                  Checking outstanding… {pendPoll.attempt}/{pendPoll.max}
                </span>
              ) : null}
            </div>
          ) : null}
          {isRecovered ? (
            <div className="result-banner ok" role="status">
              <strong>Recovered</strong>
              <span>
                Outstanding cleared
                {approveResult.activate ? "; subscription activate attempted" : ""}
                .
              </span>
            </div>
          ) : null}
          {isNoMoney && !isPend && !isRecovered ? (
            <div className="result-banner neutral" role="status">
              <strong>Approved</strong>
              <span>
                {approveResult.message ||
                  noMoneyApproveMessage(
                    proposal?.proposal.action === "escalate"
                      ? "escalate"
                      : "retry_later"
                  )}
              </span>
            </div>
          ) : null}
          <div className="board">
            <details className="raw-json">
              <summary>Result payload</summary>
              <pre>{JSON.stringify(approveResult, null, 2)}</pre>
            </details>
          </div>
        </section>
      )}

      <section className="section" aria-labelledby="mrr-heading">
        <div className="section-head">
          <h2 id="mrr-heading">Recovered MRR</h2>
          <span className={`mrr-total${mrrPulse ? " pulse" : ""}`}>
            ${recoveredTotal.toFixed(2)} USD
          </span>
        </div>
        <p className="hint" style={{ marginBottom: "0.65rem" }}>
          Verified PayPal recoveries only — outstanding cleared after Approve.
          Approve rows stay visible until PayPal txn list catches up.
        </p>
        <div className="board">
          {recovered.length === 0 ? (
            <p className="empty">No verified recoveries yet.</p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Subscription</th>
                    <th>Amount</th>
                    <th>Txn</th>
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {recovered.map((r) => (
                    <tr key={r.id}>
                      <td>{new Date(r.recoveredAt).toLocaleString()}</td>
                      <td>
                        <code>{r.subscriptionId}</code>
                        {r.pathKey ? (
                          <span className="muted">
                            {" "}
                            · {customerLabel(r.pathKey)}
                          </span>
                        ) : null}
                      </td>
                      <td>
                        <strong>
                          {r.amountRecovered.value}{" "}
                          {r.amountRecovered.currency_code}
                        </strong>
                      </td>
                      <td>
                        {r.transactionId ? (
                          <code>{r.transactionId}</code>
                        ) : (
                          <span className="muted">n/a</span>
                        )}
                      </td>
                      <td>
                        <span className="badge quiet-live">{r.source}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {webhookInbox.length > 0 ? (
        <section className="section" aria-labelledby="wh-heading">
          <div className="section-head">
            <h2 id="wh-heading">Webhook inbox</h2>
            <p className="hint">Verified signatures only — not money proof.</p>
          </div>
          <div className="board">
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Received</th>
                    <th>Event</th>
                    <th>Resource</th>
                    <th>Flags</th>
                  </tr>
                </thead>
                <tbody>
                  {webhookInbox.map((e, i) => (
                    <tr key={`${e.eventId || "ev"}-${i}`}>
                      <td>{new Date(e.receivedAt).toLocaleString()}</td>
                      <td>
                        <code>{e.eventType || "unknown"}</code>
                        {e.interesting ? (
                          <>
                            {" "}
                            <span className="badge quiet-live">interest</span>
                          </>
                        ) : null}
                      </td>
                      <td>
                        {e.resourceId ? (
                          <code>{e.resourceId}</code>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td>
                        {e.duplicate ? (
                          <span className="badge quiet-status">dup</span>
                        ) : (
                          <span className="badge quiet-live">new</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      ) : null}

      {error && <p className="err">{error}</p>}
    </main>
  );
}
