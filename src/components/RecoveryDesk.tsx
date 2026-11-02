"use client";

import { useCallback, useEffect, useState } from "react";

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
    "I-3HK9STH33F7F"
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [proposal, setProposal] = useState<ProposalPayload | null>(null);
  const [approveBusy, setApproveBusy] = useState(false);
  const [approveResult, setApproveResult] = useState<unknown>(null);
  const [recovered, setRecovered] = useState<RecoveredRow[]>([]);
  const [recoveredTotal, setRecoveredTotal] = useState(0);
  const [webhookInbox, setWebhookInbox] = useState<WebhookInboxRow[]>([]);

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
        `Approve LIVE capture on ${proposal.proposal.subscriptionId}?\n\nThis calls PayPal OUTSTANDING_BALANCE capture. Only proceed when ready (Step 6 money proof). Cancel to stay on Step 5 dry review.`
      );
      if (!ok) return;
    }
    setApproveBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/proposals/${proposal.proposalId}/approve`,
        { method: "POST" }
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
    const res = await fetch(`/api/proposals/${proposal.proposalId}/deny`, {
      method: "POST",
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || "Deny failed");
      return;
    }
    setApproveResult(data);
  }

  return (
    <main>
      <h1>Renewal Rescue</h1>
      <p className="sub">
        Recovery desk - seeded subscriptions with live PayPal refresh. AI
        propose, policy gate, merchant Approve. Capture only when outstanding
        &gt; 0. Prefer{" "}
        <code>{preferredCaptureId}</code> for the live capture path. Never
        auto-capture; Webhooks Simulator is not money proof.
      </p>

      <div className="banner">
        Step 9B board shows verified recoveries only (money-proof seed + Approve
        RECOVERED). Do not Approve live capture on{" "}
        <code>{preferredCaptureId}</code> until filming (Step PP-26). List +
        Propose are safe. Webhooks Simulator is never money proof.
      </div>

      <section className="panel">
        <h2>
          Recovered MRR{" "}
          <span className="badge live">
            ${recoveredTotal.toFixed(2)} USD verified
          </span>
        </h2>
        <p className="sub" style={{ marginBottom: "0.75rem" }}>
          Real PayPal-backed rows only. Seed: txn{" "}
          <code>7RG29592AA729850V</code> on <code>I-J8R13K0F76X4</code>. Future
          Approve → RECOVERED (outstanding cleared) appends here — e.g.{" "}
          <code>I-3HK9STH33F7F</code> when filmed.
        </p>
        {recovered.length === 0 ? (
          <p className="sub">No verified recoveries yet.</p>
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
                      <span className="badge live">{r.source}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="toolbar">
        <button type="button" className="primary" onClick={() => void refresh()} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh live"}
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
          onClick={() => void propose({ forceRevise: true })}
          disabled={!selectedId}
        >
          Propose revise (retention)
        </button>
        <button
          type="button"
          className="danger"
          onClick={() => void propose({ demoWriteOff: true })}
          disabled={!selectedId}
        >
          Demo deny (write-off)
        </button>
      </div>

      <div className="grid">
        {subs.map((s) => (
          <label
            key={s.id}
            className={`row${s.preferredCaptureTarget ? " preferred" : ""}`}
          >
            <div className="badges">
              {s.preferredCaptureTarget && (
                <span className="badge live">Preferred capture</span>
              )}
              {s.outstandingValue > 0 ? (
                <span className="badge live">Live outstanding</span>
              ) : (
                <span className="badge fixture">FIXTURE $0</span>
              )}
              <span className="badge warn">{s.status}</span>
            </div>
            <div className="meta">
              <span>
                <input
                  type="radio"
                  name="sub"
                  checked={selectedId === s.id}
                  onChange={() => setSelectedId(s.id)}
                />{" "}
                <strong>{s.key}</strong>
              </span>
              <span>
                id <strong>{s.id}</strong>
              </span>
              <span>
                outstanding{" "}
                <strong>
                  {s.outstanding
                    ? `${s.outstanding.value} ${s.outstanding.currency_code}`
                    : "0"}
                </strong>
              </span>
              <span>
                failed <strong>{s.failedPaymentsCount ?? "n/a"}</strong>
              </span>
              <span>path {s.failurePath}</span>
            </div>
          </label>
        ))}
      </div>

      {proposal && (
        <section className="panel">
          <h2>
            Proposal{" "}
            {proposal.proposal.fixtureLabeled ? (
              <span className="badge fixture">FIXTURE</span>
            ) : (
              <span className="badge live">LIVE candidate</span>
            )}{" "}
            · {proposal.status}
          </h2>
          <div className="meta">
            <span>
              action <strong>{proposal.proposal.action}</strong>
            </span>
            <span>
              policy{" "}
              <strong>
                {proposal.policy.ok
                  ? "OK"
                  : `BLOCKED - ${proposal.policy.reason}`}
              </strong>
            </span>
          </div>
          <p className="sub" style={{ marginBottom: 0 }}>
            {proposal.proposal.rationale}
          </p>
          <div className="toolbar" style={{ marginTop: "0.75rem" }}>
            <button
              type="button"
              className="primary"
              disabled={
                approveBusy ||
                !proposal.policy.ok ||
                proposal.status === "BLOCKED"
              }
              onClick={() => void approve()}
            >
              {approveBusy ? "Approving…" : "Approve"}
            </button>
            <button type="button" className="danger" onClick={() => void deny()}>
              Deny
            </button>
          </div>
          <pre>{JSON.stringify(proposal, null, 2)}</pre>
        </section>
      )}

      {approveResult != null && (
        <section className="panel">
          <h2>Approve / Deny result</h2>
          <pre>{JSON.stringify(approveResult, null, 2)}</pre>
        </section>
      )}

      <section className="panel">
        <h2>
          Webhook inbox{" "}
          <span className="badge fixture">verified signatures only</span>
        </h2>
        <p className="sub" style={{ marginBottom: "0.75rem" }}>
          Recent events from <code>POST /api/webhooks/paypal</code> after
          PayPal signature verify. Subscription/payment events highlighted.
          Simulator = optional smoke only — never money proof.
        </p>
        {webhookInbox.length === 0 ? (
          <p className="sub">
            No events yet. Needs public tunnel +{" "}
            <code>PAYPAL_WEBHOOK_ID</code> (see Step 9A doc).
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
                          <span className="badge live">interest</span>
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
                        <span className="badge warn">dup</span>
                      ) : (
                        <span className="badge live">new</span>
                      )}{" "}
                      <span className="badge fixture">not money proof</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {error && <p className="err">{error}</p>}
    </main>
  );
}
