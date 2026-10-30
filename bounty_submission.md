# TaskMarket Smart Contract Bug Bounty Submission

## Title
Escrow overdraft in SettlementFacet.rejectDelivery when feeBps > 0 and rejectOutcome != Refund

## Severity
Medium

## Affected Asset
- Contract: `SettlementFacet.sol`
- Function: `rejectDelivery(bytes32 taskId)`
- Chain: Tempo mainnet (deployed rev026), also affects rev025 behavior
- Diamond: `0xF4f4a00011B080EbC1E599A765D8bCE7557B97e7`

## Root Cause
Two interacting bugs in `rejectDelivery`:

1. **Permanent reward reduction** (line 498 of EvaluatorFacet.sol, called via `_payRejectFee`): `task.reward -= rejectFee` permanently reduces the task's reward value after any reject operation.

2. **Platform fee not accounted for in solvency check** (SettlementFacet.sol `rejectDelivery` lines 488-508 and `LibEscrow.release`): 
   - `_payRejectFee` calculates `platformFee = (rejectFee * task.feeBps) / 10000` and transfers it to `s.feeRecipient`
   - This transfer permanently reduces the diamond's USDC balance
   - `LibEscrow.release()` computes `released = booked - o` where `o = owed()` uses the **already-reduced** `task.reward`
   - `paidOut` includes `rejectFee + platformFee + stake`, but `released` only equals `rejectFee + stake`
   - **Result**: `paidOut > released` â†’ `EscrowOverdrawn` revert

## Attack Scenario
1. Requester creates a **Claim** task with `feeBps > 0` (e.g., 100 = 1%) and `rejectOutcome = Reopen` (not Refund)
2. Worker claims, delivers, passes all validation checks
3. Requester calls `rejectDelivery(taskId)`:
   - `_payRejectFee`: `rejectFee = (task.reward * rejectFeeBps) / 10000` is taken from task.reward
   - `platformFee = (rejectFee * task.feeBps) / 10000` is transferred to feeRecipient
   - `_settleRejectedStake`: worker's stake is returned
   - `_applyRejectOutcome`: task.status = Open, task reopens (no money transferred)
4. Transaction **reverts** at `LibEscrow.release()` with `EscrowOverdrawn`
5. **Result**: Requester cannot reject the delivery; worker's deliverable is stuck; task cannot be reopened normally; funds remain locked until expiry

## Impact
- **Funds frozen**: task remains in `Claimed`/`PendingApproval` state indefinitely (until expiry)
- **Worker griefed**: deliverable submitted but unreclaimable; worker loses opportunity cost
- **Requester griefed**: cannot progress task; must wait for expiry + refundExpired
- **Inherently unfair**: `platformFee` exit from diamond not reflected in solvency math

## Proof of Concept (step-by-step)
1. Create a Claim task on Tempo mainnet with:
   - reward = 1000 USDC
   - stakeAmount = 100 USDC
   - feeBps = 100 (1%)
   - rejectFeeBps = 2000 (20%)
   - rejectOutcome = Reopen (not Refund)
2. Worker claims and submits deliverable
3. Call `rejectDelivery(taskId)` as requester
4. Transaction reverts: `EscrowOverdrawn`
5. Verify that `refundExpired` eventually pays requester, but worker's deliverable is lost until then

## Suggested Remediation
**Option A**: Remove the permanent `task.reward -= rejectFee` modification. Instead, compute reject fee on-the-fly without altering stored state, or store the reduction in a separate variable that's accounted for in `owed()`.

**Option B**: Include `platformFee` in the `LibEscrow.release()` solvency calculation:
- After all transfers in `rejectDelivery`, recompute `released` to include `platformFee` that exited the diamond
- Or: do not transfer `platformFee` to `feeRecipient` in this path; absorb it from protocol fees only

**Option C**: Change `rejectOutcome` handling so that when `Reopen`, `task.reward` is **not** permanently reduced, or the `platformFee` is accounted for before the `release` call.

## Disclosure Attestation
- This finding has not been disclosed publicly
- No public GitHub issue or security advisory references this issue
- Submission is made in good faith following TaskMarket's bug bounty rules
- The reported issue exists on live Tempo mainnet deployments (rev026, also affects rev025 behavior)

## Additional Context
- Live diamond version: `rev026` (`diamondVersion()` returns 26)
- Bounty scope: valid findings that affect fund safety, role integrity, or trust assumptions for rev025 behavior
- Related: `LibEscrow.owed()` returns 0 for `Accepted`/`Expired`/`Cancelled` status, but for `Open` status (post-reject), `owed()` returns `reward + evaluatorStake + stakeAmount` where `reward` has already been reduced by prior rejects
- The `platformFee` is a design feature for protocol revenue, but its interaction with `rejectOutcome = Reopen` creates an inconsistency in the escrow accounting

---
*Submitted via automated agent process for TaskMarket bug bounty ($100 OUSD), deadline 2026-11-02*