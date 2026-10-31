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
    } catch (e) {
      setError(e instanceof Error ? e.message : "Refresh failed");
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

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
        Step 5 wires Approve → capture/revise. Do not click Approve on a live
        capture until Step 6 (filmed money proof). List + Propose are safe.
      </div>

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

      {error && <p className="err">{error}</p>}
    </main>
  );
}
