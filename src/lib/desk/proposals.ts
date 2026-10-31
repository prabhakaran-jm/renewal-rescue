import type { PolicyResult, RenewalProposal } from "@/types/renewal";

export type StoredProposal = {
  id: string;
  createdAt: string;
  proposal: RenewalProposal;
  policy: PolicyResult;
  status: "PROPOSED" | "BLOCKED" | "APPROVED" | "DENIED";
  result?: unknown;
};

const store = new Map<string, StoredProposal>();

export function saveProposal(
  proposal: RenewalProposal,
  policy: PolicyResult
): StoredProposal {
  const id = `prop_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const row: StoredProposal = {
    id,
    createdAt: new Date().toISOString(),
    proposal,
    policy,
    status: policy.ok ? "PROPOSED" : "BLOCKED",
  };
  store.set(id, row);
  return row;
}

export function getProposal(id: string) {
  return store.get(id) ?? null;
}

export function updateProposal(id: string, patch: Partial<StoredProposal>) {
  const cur = store.get(id);
  if (!cur) return null;
  const next = { ...cur, ...patch };
  store.set(id, next);
  return next;
}
