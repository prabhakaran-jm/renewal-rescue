"use client";

import { useCallback, useEffect, useRef, useState } from "react";

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
    source: "gemini" | "fallback";
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

type RecoveredRow = {
  id: string;
  subscriptionId: string;
  pathKey?: string;
  amountRecovered: Money;
  transactionId: string | null;
  transactionStatus: string | null;
  recoveredAt: string;
  source: string;
  note?: string;
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
  const [approveResult, setApproveResult] = useState<unknown>(null);
  const [demoPasscode, setDemoPasscode] = useState("");
  const [recovered, setRecovered] = useState<RecoveredRow[]>([]);
  const [recoveredTotal, setRecoveredTotal] = useState(0);
  const [mrrPulse, setMrrPulse] = useState(false);
  const [webhookInbox, setWebhookInbox] = useState<WebhookInboxRow[]>([]);
  const mrrPrev = useRef<number | null>(null);

  const refreshBoards = useCallback(async () => {
    try {
      const [mrrRes, whRes] = await Promise.all([
        fetch("/api/recovered-mrr", { cache: "no-store" }),
        fetch("/api/webhooks/inbox", { cache: "no-store" }),
      ]);
      const mrr = await mrrRes.json();
      if (mrrRes.ok) {
        setRecovered(mrr.rows || []);
        setRecoveredTotal(typeof mrr.totalUsd === "number" ? mrr.totalUsd : 0);
      }
      const wh = await whRes.json();
      if (whRes.ok) {
        setWebhookInbox(wh.events || []);
      }
    } catch {
      /* boards are secondary — don't block desk */
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/subscriptions", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setSubs(data.subscriptions || []);
      if (data.preferredCaptureId) {
        setPreferredCaptureId(data.preferredCaptureId);
      }
      const preferred =
        (data.subscriptions as DeskSub[] | undefined)?.find(
          (s) => s.preferredCaptureTarget
        ) || (data.subscriptions as DeskSub[] | undefined)?.[0];
      if (preferred && !selectedId) setSelectedId(preferred.id);
      await refreshBoards();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Refresh failed");
    } finally {
      setLoading(false);
    }
  }, [selectedId, refreshBoards]);

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

  async function propose(opts?: {
    demoWriteOff?: boolean;
    forceRevise?: boolean;
  }) {
    setError(null);
    setApproveResult(null);
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
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || data.reason || `Approve HTTP ${res.status}`);
        setApproveResult(data);
        return;
      }
      setApproveResult(data);
      await refresh();
      await refreshBoards();
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
  const aiIsGemini = proposal?.ai?.source === "gemini";

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
            Select a row, then Propose. Quiet badges mark live balance vs
            fixture.
          </p>
        </div>
        <div className="sub-grid">
          {subs.map((s) => {
            const selected = selectedId === s.id;
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
                  aria-label={`Select ${s.key}`}
                />
                <div className="sub-row-body">
                  <div className="sub-row-top">
                    <span className="path">{s.key}</span>
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
          })}
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
            className={`ai-spotlight${aiIsGemini ? "" : " fallback"}`}
          >
            <div className="ai-label">
              {aiIsGemini ? (
                <span className="badge ai-gemini">Gemini</span>
              ) : (
                <span className="badge ai-fallback">
                  Fallback
                  {proposal.ai?.reason ? ` · ${proposal.ai.reason}` : ""}
                </span>
              )}
              {proposal.ai?.model ? (
                <span className="muted">{proposal.ai.model}</span>
              ) : null}
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
              disabled={approveBusy || !policyOk}
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
          <div className="board">
            <details className="raw-json" open>
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
                          <span className="muted"> · {r.pathKey}</span>
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

      <section className="section" aria-labelledby="wh-heading">
        <div className="section-head">
          <h2 id="wh-heading">Webhook inbox</h2>
          <p className="hint">Verified signatures only — not money proof.</p>
        </div>
        <div className="board">
          {webhookInbox.length === 0 ? (
            <p className="empty">
              No events yet. Register the production webhook URL with PayPal
              and set PAYPAL_WEBHOOK_ID.
            </p>
          ) : (
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
          )}
        </div>
      </section>

      {error && <p className="err">{error}</p>}
    </main>
  );
}
