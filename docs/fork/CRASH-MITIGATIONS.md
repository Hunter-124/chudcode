# Host crash mitigations

Why Hunter's workstation was stalling during multi-session Chudcode use, and what was
changed. Every state claim below was re-verified on 2026-08-27 against the live
host; the verification command is given so you can re-check rather than trust it.

## What was actually happening

The near-freeze was **not** primarily chudcode. Measured at the time:

- 10.6 GiB of concurrent compilers — 14x `cc1plus` at 6.45 GiB plus one `rustc`
  at 4.17 GiB.
- A misconfigured 16 GiB zram whose 14.6 GiB of held pages cost 4.9 GiB of
  *physical* RAM.
- 6.89 GiB of committed anonymous memory across 9 chudcode-family processes on a
  30.75 GiB box.

So Chudcode was not the proximate cause, but its resting footprint left almost no
headroom. That distinction is why the upstream issue
([#9908](https://github.com/Hunter-124/chudcode/issues/9908)) was filed as an
accounting/admission-control report and explicitly **not** as a leak — no heap
snapshot was taken, and the one worker that dominates is flat, not growing.

## Chudcode's contribution, measured

| Component | Figure | Nature |
| --- | --- | --- |
| `__omp_worker_mnemopi_embed` | 780 MB, dead flat over 50 s | Loaded ONNX runtime + embedding model. One per Chudcode process, no idle teardown |
| Per interactive session | 0.63–1.47 GiB committed | vs. the 39–49 MB idle baseline in upstream #8003 |
| Subagents | in-process | `task.maxConcurrency` (default 32, kept at 32 by choice) admits up to 32 `AgentSession` objects into **one** Bun heap |

The admission gate is count-only: `Semaphore` is `#max`/`#current`/`#queue` and
nothing else. The only memory call in the entire source tree is `os.freemem()`
in `debug/system-info.ts:66`, which feeds diagnostic output and no decision. So
each session sizes itself as though it were alone on the machine.

## Fixes applied to the host

### 1. `/tmp` capped at 2 GiB (was 8 GiB, RAM-backed)

`/tmp` is `tmpfs`, i.e. RAM. It had grown to 7.54 GB of agent scratch, all of it
resident. Reclaimed, then capped.

Applied live with `mount -o remount` rather than `systemctl restart tmp.mount`,
deliberately: a restart unmounts `/tmp`, and 16 processes had cwds there with 23
open handles. The remount preserved all of them.

Persisted for boot in `/etc/systemd/system/tmp.mount.d/override.conf`:

```ini
[Mount]
Options=mode=1777,strictatime,nosuid,nodev,size=2G,nr_inodes=1m
```

Verify: `findmnt -T /tmp -o SIZE,OPTIONS` → `2G ... size=2097152k`.

### 2. Agent scratch moved off RAM to disk

`~/.config/environment.d/10-tmpdir.conf` (plus a matching `.bashrc` export for
non-systemd shells):

```
TMPDIR=/home/hunter/.cache/tmp
```

This is the change that makes the 2 GiB cap safe — scratch space no longer
competes with the working set for physical memory.

Verify: `cat ~/.config/environment.d/10-tmpdir.conf`.

### 3. Weekly prune of leaked temp directories

`chudcode-tmp-prune.timer` (user scope) — enabled and active. This addresses the
concrete leak filed upstream as
[#9922](https://github.com/Hunter-124/chudcode/issues/9922).

Verify: `systemctl --user is-enabled chudcode-tmp-prune.timer` → `enabled`.

### 4. zram

Corrected locally at the time. Not chudcode-related; recorded here only because it
was half the memory pressure and would otherwise look like an unexplained gap
between Chudcode's footprint and the observed stall.

## What is deliberately NOT changed

- **`task.maxConcurrency` stays at 32.** Hunter's explicit choice ("we want full
  capabilities"). Documented so nobody lowers it thinking it is an oversight.
  The tradeoff is understood: it is a memory knob, not just a parallelism knob.
- **No local patch to the mnemo worker.** Its residency is a policy question
  for upstream, not a bug to fork around; a local hack would diverge the vendored
  packages CAD depends on.

## Still open

- Per-process admission control that consults available memory before admitting
  the Nth subagent. Offered upstream on #9908; local to the spawn path and the
  cheaper half of the problem.
- Cross-session budget. Needs shared state; acknowledged upstream as a much
  larger design question.
- The Windows login crash is unrelated to any of the above and still needs a
  stack trace from an affected machine.
