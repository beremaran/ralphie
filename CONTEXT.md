# Ralphie

Ralphie carries out GitHub issue work and repairs failing pipelines. Its delivery
language distinguishes a locally created repair from a repair confirmed at the
remote branch.

## Language

**Created pipeline commit**:
A local commit containing a pipeline repair, whose presence at the intended
remote branch may still be unconfirmed.

**Pipeline commit delivery**:
The delivery of an already-created pipeline commit to its intended remote
branch, including the evidence establishing whether it arrived.
_Avoid_: Pipeline repair (which also includes producing the repair)

**Confirmed pipeline push**:
A pipeline commit delivery for which an authoritative remote branch read
matches the created commit.

**External movement during pipeline push reconciliation**:
An authoritative remote branch result that matches neither the expected prior
commit nor the created pipeline commit.
_Avoid_: Ambiguous push (when this remote evidence is available)

**Pipeline repair attempt**:
One prospective repair cycle for a failing pipeline snapshot; only a
Confirmed pipeline push charges the budget.
_Avoid_: attempt, implementation attempt, review attempt, transport retry, run attempt

**Pipeline snapshot**:
Normalized all-visible-checks evidence for one exact commit.
_Avoid_: maintenance snapshot, PR snapshot, check snapshot
