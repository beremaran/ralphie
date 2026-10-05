# Ralphie

Ralphie turns open GitHub issues into reviewed commits on a branch. Its delivery
language distinguishes a locally created commit from a commit confirmed at the
remote branch.

## Language

**Created commit**:
A local commit that may not yet be present at the intended remote branch.

**Commit delivery**:
The delivery of an already-created commit to its intended remote branch,
including the evidence establishing whether it arrived.

**Confirmed push**:
A commit delivery for which an authoritative remote branch read matches the
created commit.

**External movement during push reconciliation**:
An authoritative remote branch result that matches neither the expected prior
commit nor the created commit.
_Avoid_: Ambiguous push (when this remote evidence is available)
