#!/usr/bin/env bash
# Create a populated demo repo so every shellphone tool can be exercised without
# first running a real Claude Code session.
#
# A local extension has no "test account" to hand a reviewer — the equivalent is
# a repeatable seed. This uses only the shellphone CLI, so it works before any
# hooks are installed.
#
#   bash scripts/demo-seed.sh            # creates ./shellphone-demo
#   bash scripts/demo-seed.sh /some/path
#   shellphone forget shellphone-demo    # undo (then delete the directory)
set -euo pipefail

DEMO="${1:-$PWD/shellphone-demo}"
SP="${SHELLPHONE_BIN:-shellphone}"

if ! command -v "$SP" >/dev/null 2>&1; then
  echo "shellphone not on PATH. Install with 'npm install -g shellphone', or set SHELLPHONE_BIN." >&2
  exit 1
fi

rm -rf "$DEMO"
mkdir -p "$DEMO/src"
cd "$DEMO"

git init -q
git config user.email demo@example.com
git config user.name "shellphone demo"
cat > README.md <<'EOF'
# lattice-relax

Masked bit-lattice relaxation kernel. Demo repo for shellphone.
EOF
printf 'int relax(void) { return 0; }\n' > src/relax.c
printf '#pragma once\n' > src/lattice.h
git add -A
git commit -qm "initial kernel"
git checkout -qb gibbs-relax-v2

"$SP" init --name lattice-relax >/dev/null

"$SP" survey --stdin >/dev/null <<'EOF'
{
  "name": "lattice-relax",
  "one_liner": "A masked bit-lattice relaxation kernel in C, used to study Gibbs sampling on sparse lattices.",
  "purpose": "Explores whether masked relaxation converges faster than naive Gibbs sweeps on sparse 2D lattices, with an eye to a GPU port later.",
  "stack": ["C11", "make"],
  "layout": [
    { "path": "src/relax.c", "role": "the relaxation kernel and its inner sweep" },
    { "path": "src/lattice.h", "role": "lattice representation and masking macros" }
  ],
  "entry_points": { "build": "make", "test": "make check" },
  "decisions": [
    { "what": "bit-packed lattice rather than one byte per site", "why": "the 4x4 working set has to stay in L1 during a sweep" },
    { "what": "masking instead of branching in the inner loop", "why": "branch misprediction dominated the first profile" }
  ],
  "constraints": ["2D lattices only for now", "no GPU path in this version"],
  "gotchas": ["the mask assumes row-major order; transposing silently corrupts results"],
  "open": ["whether the adaptive schedule needs its own PRNG stream"]
}
EOF

"$SP" digest --repo lattice-relax --status shipped \
  --summary "Bit-packed the lattice representation and moved the inner sweep to masking instead of branching. Sweeps are roughly 3x faster on the 4x4 synthetic cases and results match the reference implementation." \
  --changed src/lattice.h >/dev/null

"$SP" digest --repo lattice-relax --status needs-input \
  --summary "Implemented the masked relaxation kernel; passing on synthetic 4x4 lattices. Cannot tune the sampler until the temperature schedule is settled, so this is parked rather than blocked on a bug." \
  --next "fixed vs adaptive temperature schedule for Gibbs steps" \
  --question "does an adaptive schedule need its own PRNG stream, or can it share the sweep stream?" \
  --changed src/relax.c,src/lattice.h >/dev/null

"$SP" send lattice-relax "Use the adaptive schedule, and seed it from the repo state hash so runs stay reproducible." >/dev/null

cat <<EOF

Demo repo ready: $DEMO

Try these in Claude with the shellphone extension installed:
  "What am I working on?"                          -> list_repos
  "Where is lattice-relax at?"                     -> get_state
  "Did Code pick up what I sent to lattice-relax?" -> get_queue_status
  "Tell lattice-relax to add a regression test for the transpose gotcha."
                                                   -> send_instruction

Clean up with:
  $SP forget lattice-relax && rm -rf "$DEMO"
EOF
