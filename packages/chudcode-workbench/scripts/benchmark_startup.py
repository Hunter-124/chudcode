#!/usr/bin/env python3
"""Compare real Linux compiled RPC starts; JSON stdout, no provider calls.

Warm means repeated starts with OS caches left intact, not reused agent state.
Every lifecycle has a fresh private profile/workspace. Warmup pairs are excluded.
Run from any directory with Python 3.10+; repository helpers are imported read-only.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import platform
import re
import statistics
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

sys.dont_write_bytecode = True
REPO = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(REPO / "scripts"), str(REPO / "packages/chudcode-workbench/test")]
from package_chudcode_workbench import digest
from qualification import (
    JsonProcess,
    SmokeError,
    executable,
    install_cleanup_signals,
    isolated_environment,
    positive_timeout,
    run_process,
)

FLAGS = [
    "--mode",
    "rpc",
    "--no-session",
    "--no-tools",
    "--no-lsp",
    "--no-mcp",
    "--no-skills",
    "--no-rules",
    "--no-extensions",
    "--no-title",
    "--no-ui",
]


class ProbeError(SmokeError):
    pass


def count(value: str) -> int:
    result = int(value)
    if result < 1:
        raise argparse.ArgumentTypeError("count must be positive")
    return result


def fingerprint(path: Path) -> dict:
    path = executable(path)
    before = path.stat()
    sha256 = digest(path)
    after = path.stat()
    identity = lambda info: (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)
    if identity(before) != identity(after):
        raise ProbeError("binary_changed_during_fingerprint")
    return {
        "path": str(path),
        "sha256": sha256,
        "bytes": after.st_size,
        "device": after.st_dev,
        "inode": after.st_ino,
        "mtime_ns": after.st_mtime_ns,
    }


def prepare(root: Path, provider_ids: list[str]) -> tuple[dict, Path]:
    environment = isolated_environment(root)
    # Explicitly select the compatibility backend's native baseline on both sides.
    environment["PI_NATIVE_VARIANT"] = "baseline"
    agent = root / "agent"
    agent.mkdir(mode=0o700)
    environment["PI_CODING_AGENT_DIR"] = str(agent)
    (agent / "config.yml").write_text(
        json.dumps(
            {
                "enabledProviders": [],
                "enabledModels": [],
                "disabledProviders": provider_ids,
                "vision": {"autoDownload": False},
                "startup": {"checkUpdate": False},
                "marketplace": {"autoUpdate": "off"},
                "retry": {"enabled": False, "modelFallback": False},
            }
        ),
        encoding="utf-8",
    )
    workspace = root / "workspace"
    workspace.mkdir(mode=0o700)
    return environment, workspace


def version(
    binary: Path, expected: str, environment: dict, workspace: Path, timeout: float
) -> str:
    text = run_process([str(binary), "--version"], workspace, environment, timeout)
    versions = re.findall(r"\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?![\w.-])", text)
    if versions != [expected]:
        raise ProbeError("binary_version_mismatch")
    return versions[0]


def root_process_stat(pid: int) -> dict:
    # stat's comm can contain spaces/parentheses; split after its final ')'.
    text = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8")
    fields = text[text.rindex(")") + 2 :].split()
    ticks = os.sysconf("SC_CLK_TCK")
    pagesize = os.sysconf("SC_PAGE_SIZE")
    user, system = int(fields[11]) / ticks, int(fields[12]) / ticks
    return {
        "status": "sampled",
        "rss_bytes": int(fields[21]) * pagesize,
        "cpu_user_seconds": user,
        "cpu_system_seconds": system,
        "cpu_total_seconds": user + system,
        "cpu_clock_ticks_per_second": ticks,
        "rss_page_size_bytes": pagesize,
        "process_start_ticks_since_boot": int(fields[19]),
        "minor_faults": int(fields[7]),
        "major_faults": int(fields[9]),
        "threads": int(fields[17]),
    }


def readiness_snapshot(pid: int, started: float, ready_at: float) -> dict:
    """Sample ONLY the spawned owned root PID, not descendants or peak RSS."""
    observed = time.perf_counter()
    result = {
        "pid": pid,
        "scope": "spawned_owned_root_pid_only",
        "rss_semantics": "instantaneous_resident_pages_not_peak_not_process_tree",
        "cpu_semantics": "cumulative_user_plus_system_seconds_of_root_pid_not_utilization_not_children",
        "sample_started_after_ready_ms": (observed - ready_at) * 1000,
        "rss_bytes": None,
        "cpu_user_seconds": None,
        "cpu_system_seconds": None,
        "cpu_total_seconds": None,
    }
    try:
        result.update(root_process_stat(pid))
    except (OSError, ValueError, IndexError):
        result["status"] = "unavailable_proc_stat"
    result["sample_finished_after_ready_ms"] = (time.perf_counter() - ready_at) * 1000
    result["sample_finished_after_launch_ms"] = (time.perf_counter() - started) * 1000
    return result


SMAPS_FIELDS = (
    "Size",
    "Rss",
    "Pss",
    "Private_Clean",
    "Private_Dirty",
    "Anonymous",
    "AnonHugePages",
    "Swap",
)


def mapping_snapshot(pid: int, binary: Path) -> dict:
    """Classify OS mappings, not live JS objects or allocator-retained heap."""
    mappings = []
    for line in Path(f"/proc/{pid}/smaps").read_text(encoding="utf-8").splitlines():
        if re.match(r"^[0-9a-f]+-[0-9a-f]+ ", line):
            fields = line.split(maxsplit=5)
            name = fields[5] if len(fields) == 6 else ""
            category = (
                "executable_file"
                if name == str(binary)
                else "brk_heap"
                if name == "[heap]"
                else "anonymous_mapping"
                if not name or name.startswith("[anon:")
                else "other_special_mapping"
                if name.startswith("[")
                else "other_file_mapping"
            )
            mappings.append(
                {
                    "address": fields[0],
                    "permissions": fields[1],
                    "name": name,
                    "category": category,
                    **{field + "_bytes": 0 for field in SMAPS_FIELDS},
                }
            )
        elif mappings:
            key, _, value = line.partition(":")
            if key in SMAPS_FIELDS:
                mappings[-1][key + "_bytes"] = int(value.split()[0]) * 1024
    categories = {}
    for mapping in mappings:
        total = categories.setdefault(
            mapping["category"],
            {"mapping_count": 0, **{field + "_bytes": 0 for field in SMAPS_FIELDS}},
        )
        total["mapping_count"] += 1
        for field in SMAPS_FIELDS:
            total[field + "_bytes"] += mapping[field + "_bytes"]
    return {
        "categories": categories,
        "largest_resident_mappings": sorted(
            mappings, key=lambda mapping: mapping["Rss_bytes"], reverse=True
        )[:8],
    }


class RootResourceTrace:
    """Optional observer of the same JsonProcess-owned root; never a tree peak."""

    def __init__(self, process: JsonProcess, binary: Path, started: float, interval: float):
        self.process = process.process
        self.binary = binary
        self.started = started
        self.interval = interval
        self.samples = []
        self.start_ticks = None
        self.failure = None
        self.lock = threading.Lock()
        self.stopped = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def capture(self, phase: str) -> None:
        with self.lock:
            if self.process.poll() is not None:
                return
            observed = time.perf_counter()
            sample = {"phase": phase, "after_launch_ms": (observed - self.started) * 1000}
            try:
                stat = root_process_stat(self.process.pid)
                if self.start_ticks is None:
                    self.start_ticks = stat["process_start_ticks_since_boot"]
                if self.start_ticks != stat["process_start_ticks_since_boot"]:
                    raise ProbeError("root_pid_identity_changed")
                sample["stat"] = stat
                status = {}
                for line in Path(f"/proc/{self.process.pid}/status").read_text(
                    encoding="utf-8"
                ).splitlines():
                    key, _, value = line.partition(":")
                    if key in ("VmRSS", "VmHWM", "VmSize", "RssAnon", "RssFile", "RssShmem"):
                        status[key + "_bytes"] = int(value.split()[0]) * 1024
                sample["status"] = status
                # schedstat is ONLY the root main thread, unlike process stat CPU.
                scheduler = Path(f"/proc/{self.process.pid}/schedstat").read_text().split()
                sample["main_thread_schedstat"] = {
                    "on_cpu_ns": int(scheduler[0]),
                    "runqueue_wait_ns": int(scheduler[1]),
                    "timeslices": int(scheduler[2]),
                }
                sample["smaps"] = mapping_snapshot(self.process.pid, self.binary)
            except (OSError, ValueError, IndexError) as error:
                sample["unavailable"] = type(error).__name__
            except ProbeError as error:
                self.failure = error
                self.stopped.set()
                sample["unavailable"] = str(error)
            sample["observation_ms"] = (time.perf_counter() - observed) * 1000
            self.samples.append(sample)

    def _run(self) -> None:
        while not self.stopped.is_set():
            self.capture("periodic")
            if self.stopped.wait(self.interval):
                break

    def close(self) -> None:
        self.stopped.set()
        self.thread.join(timeout=5)
        if self.thread.is_alive():
            raise ProbeError("resource_observer_did_not_stop")
        if self.failure is not None:
            raise self.failure


def sample(
    binary: Path,
    environment: dict,
    workspace: Path,
    timeout: float,
    trace_interval: float | None = None,
    post_state_seconds: float = 0,
) -> dict:
    started = time.perf_counter()
    end = time.monotonic() + timeout
    process = JsonProcess([str(binary), *FLAGS], workspace, environment, timeout)
    success = False
    trace = None

    def remaining() -> float:
        value = end - time.monotonic()
        if value <= 0:
            raise ProbeError("lifecycle_deadline_exceeded")
        return value

    def receive(predicate) -> dict:
        process.timeout = remaining()
        return process.receive(predicate)

    def request(command: str, **fields) -> tuple[dict, float]:
        remaining()
        requested = time.perf_counter()
        process.send({"id": command, "type": command, **fields})

        def matches(frame: dict) -> bool:
            if frame.get("type") in ("rpc_chunk", "ready", "extension_error"):
                raise ProbeError("unexpected_rpc_transport_frame")
            return frame.get("type") == "response" and frame.get("id") == command

        response = receive(matches)
        elapsed = (time.perf_counter() - requested) * 1000
        if (
            response.get("success") is not True
            or response.get("command") != command
            or not isinstance(response.get("data"), dict)
        ):
            raise ProbeError("rpc_request_failed_" + command)
        return response["data"], elapsed

    try:
        if trace_interval is not None:
            trace = RootResourceTrace(process, binary, started, trace_interval)
        ready = receive(lambda _: True)
        ready_at = time.perf_counter()
        if (
            ready.get("type") != "ready"
            or ready.get("protocolVersion") != 1
            or not isinstance(ready.get("supportedProtocolVersions"), list)
            or 2 not in ready["supportedProtocolVersions"]
        ):
            raise ProbeError("rpc_v2_readiness_not_advertised")
        resources = readiness_snapshot(process.process.pid, started, ready_at)
        if trace is not None:
            trace.capture("ready")
        negotiated, negotiation_ms = request("negotiate_protocol", protocolVersion=2)
        if negotiated.get("protocolVersion") != 2:
            raise ProbeError("rpc_v2_negotiation_failed")
        handshake_at = time.perf_counter()
        state, state_ms = request("get_state")
        if (
            state.get("isStreaming") is not False
            or state.get("messageCount") != 0
            or not isinstance(state.get("sessionId"), str)
        ):
            raise ProbeError("isolated_rpc_state_not_idle_empty_and_identified")
        result = {
            "ready_ms": (ready_at - started) * 1000,
            "negotiated_ready_ms": (handshake_at - started) * 1000,
            "negotiate_protocol_ms": negotiation_ms,
            "get_state_ms": state_ms,
            "readiness_resource_sample": resources,
            "protocol": 2,
            "state_idle": True,
            "state_message_count": 0,
        }
        if trace is not None:
            trace.capture("get_state")
            if post_state_seconds:
                if remaining() <= post_state_seconds:
                    raise ProbeError("post_state_observation_exceeds_lifecycle_deadline")
                time.sleep(post_state_seconds)
                trace.capture("post_state_idle")
            result["root_resource_trace"] = trace.samples
        success = True
    finally:
        # Existing ownership helper kills the entire owned process group even
        # after successful EOF. Its bounded cleanup is outside readiness timing.
        try:
            if trace is not None:
                trace.close()
        finally:
            try:
                if success:
                    process.timeout = remaining()
            except ProbeError:
                process.close()
                raise
            process.close(require_success=success)
    result["lifecycle_ms"] = (time.perf_counter() - started) * 1000
    result["stdin_eof_exit"] = 0
    return result


def distribution(values: list[float]) -> dict:
    if not values:
        return {"n": 0}
    ordered = sorted(values)

    def quantile(q: float) -> float:
        position = (len(ordered) - 1) * q
        lo, hi = math.floor(position), math.ceil(position)
        return ordered[lo] + (ordered[hi] - ordered[lo]) * (position - lo)

    return {
        "n": len(values),
        "min": ordered[0],
        "max": ordered[-1],
        "mean": statistics.fmean(values),
        "median": statistics.median(values),
        "p90": quantile(0.90),
        "p95": quantile(0.95),
        "sample_stdev": statistics.stdev(values) if len(values) > 1 else None,
    }


def summaries(pairs: list[dict]) -> dict:
    result = {}
    for label in ("baseline", "candidate"):
        entries = [pair["samples"][label] for pair in pairs if label in pair["samples"]]
        result[label] = {
            metric: distribution([entry[metric] for entry in entries])
            for metric in (
                "ready_ms",
                "negotiated_ready_ms",
                "get_state_ms",
                "lifecycle_ms",
            )
        }
        for metric in ("rss_bytes", "cpu_total_seconds"):
            result[label]["readiness_root_pid_" + metric] = distribution(
                [
                    entry["readiness_resource_sample"][metric]
                    for entry in entries
                    if entry["readiness_resource_sample"][metric] is not None
                ]
            )
    result["paired_candidate_minus_baseline"] = {
        metric: distribution(
            [
                pair["samples"]["candidate"][metric]
                - pair["samples"]["baseline"][metric]
                for pair in pairs
                if len(pair["samples"]) == 2
            ]
        )
        for metric in ("ready_ms", "negotiated_ready_ms", "get_state_ms")
    }
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument(
        "--baseline-sha256",
        required=True,
        help="Trusted checksum of the immutable baseline",
    )
    parser.add_argument("--baseline-version", required=True)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--candidate-version", required=True)
    parser.add_argument("--pairs", type=count, default=20)
    parser.add_argument("--warmup-pairs", type=count, default=2)
    parser.add_argument(
        "--timeout",
        type=positive_timeout,
        default=30.0,
        help="seconds per startup/handshake/state/EOF lifecycle, excluding helper cleanup",
    )
    parser.add_argument(
        "--trace-root-resources",
        action="store_true",
        help="opt in to intrusive root-PID stat/status/schedstat/smaps observations",
    )
    parser.add_argument("--trace-interval-seconds", type=positive_timeout, default=0.1)
    parser.add_argument(
        "--post-state-seconds",
        type=positive_timeout,
        help="with resource tracing, keep the idle RPC process alive before stdin EOF",
    )
    args = parser.parse_args()
    if args.post_state_seconds is not None and not args.trace_root_resources:
        parser.error("--post-state-seconds requires --trace-root-resources")
    install_cleanup_signals()
    evidence = {
        "schema": "chudcode-real-rpc-startup-comparison-v1",
        "status": "failed",
        "host": {
            "system": platform.system(),
            "machine": platform.machine(),
            "kernel": platform.release(),
            "logical_cpus": os.cpu_count(),
            "python": platform.python_version(),
        },
        "method": {
            "pairs_requested": args.pairs,
            "warmup_pairs_excluded": args.warmup_pairs,
            "order": "baseline,candidate on even pair index; candidate,baseline on odd index",
            "warm": "repeated executable starts; OS caches not flushed; fresh isolated state each start",
            "readiness": "parent-observed first real RPC ready frame; includes JsonProcess setup and spawn",
            "negotiated_readiness": "RPC v2 negotiation complete; includes resource sampling overhead",
            "roundtrip": "parent send/flush through successful real get_state response",
            "resource_scope": "spawned owned root PID only, sampled immediately after ready; not tree or peak",
            "lifecycle_timeout_seconds": args.timeout,
            "cleanup_bounds_seconds": {
                "process_wait": 15,
                "reader_join_each": 5,
                "reader_join_max_calls": 2,
            },
            "flags": FLAGS,
            "native_variant": "baseline",
            "providers": "all catalog plus implicit provider IDs disabled; no model or prompt requests",
            "state": "fresh private HOME/XDG/agent/workspace per lifecycle; --no-session",
            "quantiles": "linear interpolation at (n-1)*q",
            "interpretation": "raw evidence only; no release threshold or improvement conclusion",
        },
        "binaries": {},
        "pairs": [],
    }
    if args.trace_root_resources:
        evidence["method"]["cleanup_bounds_seconds"]["resource_observer_join"] = 5
        evidence["method"]["root_resource_trace"] = {
            "interval_seconds_after_each_observation": args.trace_interval_seconds,
            "post_state_idle_seconds": args.post_state_seconds or 0,
            "scope": "spawned owned root PID; stat CPU includes its threads; schedstat is main thread only",
            "memory": "sampled stat RSS/status VmHWM and smaps mapping classes; not a tree peak or live JS heap",
            "sampling": "periodic plus ready/get_state/post-state; proc files are sequential, non-atomic observations",
            "confounder": "observer consumes CPU and smaps locks; readiness can shift; never compare traced and untraced distributions",
        }
    stage = "prerequisites"
    try:
        if sys.platform != "linux":
            raise ProbeError("linux_required")
        if not re.fullmatch(r"[0-9a-fA-F]{64}", args.baseline_sha256):
            raise ProbeError("invalid_baseline_checksum")
        binaries = {
            "baseline": executable(args.baseline),
            "candidate": executable(args.candidate),
        }
        expected_versions = {
            "baseline": args.baseline_version,
            "candidate": args.candidate_version,
        }
        evidence["binaries"] = {
            label: fingerprint(path) for label, path in binaries.items()
        }
        if evidence["binaries"]["baseline"]["sha256"] != args.baseline_sha256.lower():
            raise ProbeError("published_baseline_checksum_mismatch")
        catalog = REPO / "packages/catalog/src/compat/rules.json"
        provider_ids = sorted(
            set(json.loads(catalog.read_text(encoding="utf-8"))["providers"])
            | {"local", "web", "ollama", "llama.cpp", "lm-studio", "apple"}
        )
        evidence["method"]["disabled_provider_ids"] = provider_ids
        evidence["probe_sha256"] = digest(Path(__file__))
        evidence["helpers_sha256"] = {
            str(path.relative_to(REPO)): digest(path)
            for path in (
                REPO / "packages/chudcode-workbench/test/qualification.py",
                REPO / "packages/chudcode-workbench/test/windows_job.py",
                REPO / "scripts/package_chudcode_workbench.py",
                catalog,
            )
        }
        with tempfile.TemporaryDirectory(prefix="cc-startup-") as name:
            owned = Path(name)
            for label, binary in binaries.items():
                stage = "version_" + label
                root = owned / stage
                root.mkdir(mode=0o700)
                environment, workspace = prepare(root, provider_ids)
                evidence["binaries"][label]["version"] = version(
                    binary,
                    expected_versions[label],
                    environment,
                    workspace,
                    args.timeout,
                )
            for pair_index in range(args.warmup_pairs + args.pairs):
                warmup = pair_index < args.warmup_pairs
                order = (
                    ["baseline", "candidate"]
                    if pair_index % 2 == 0
                    else ["candidate", "baseline"]
                )
                pair = {
                    "index": pair_index - args.warmup_pairs,
                    "order": order,
                    "samples": {},
                }
                if not warmup:
                    evidence["pairs"].append(pair)
                for label in order:
                    stage = (
                        ("warmup" if warmup else "measured")
                        + f"_pair_{pair_index}_"
                        + label
                    )
                    # Remove this sample's profile only after the ownership helper
                    # has disposed of every process in its process group.
                    with tempfile.TemporaryDirectory(
                        prefix=stage + "-", dir=owned
                    ) as sample_name:
                        environment, workspace = prepare(
                            Path(sample_name), provider_ids
                        )
                        measured = sample(
                            binaries[label],
                            environment,
                            workspace,
                            args.timeout,
                            args.trace_interval_seconds if args.trace_root_resources else None,
                            args.post_state_seconds or 0,
                        )
                    if not warmup:
                        pair["samples"][label] = measured
        stage = "final_fingerprints"
        evidence["binaries_after"] = {
            label: fingerprint(path) for label, path in binaries.items()
        }
        for label in binaries:
            before = {
                key: value
                for key, value in evidence["binaries"][label].items()
                if key != "version"
            }
            if before != evidence["binaries_after"][label]:
                raise ProbeError("binary_changed_during_comparison_" + label)
        evidence["status"] = "passed"
    except (
        KeyboardInterrupt,
        SmokeError,
        OSError,
        ValueError,
        subprocess.SubprocessError,
    ) as error:
        # No provider content, credentials, logs, RPC state, or transcripts enter
        # evidence. Repository-helper exceptions may contain stdout/stderr; redact.
        safe_failures = {
            "Timed out waiting for executable JSONL frame": "rpc_response_timeout",
            "Executable stdout closed before expected response": "rpc_stdout_closed",
            "Invalid JSONL stdout:": "invalid_rpc_jsonl",
            "Executable did not shut down after stdin EOF": "stdin_eof_shutdown_timeout",
            "Executable EOF shutdown failed": "stdin_eof_shutdown_nonzero_exit",
            "Missing executable:": "missing_executable",
            "Not an executable file:": "not_executable",
            "Cannot launch executable:": "executable_launch_failed",
            "Command timed out:": "version_command_timeout",
            "Command failed (": "version_command_nonzero_exit",
        }
        diagnostic = next(
            (
                code
                for prefix, code in safe_failures.items()
                if str(error).startswith(prefix)
            ),
            "prerequisite_or_behavior_failure",
        )
        if isinstance(error, KeyboardInterrupt):
            diagnostic = "interrupted"
        evidence["failure"] = {
            "stage": stage,
            "kind": type(error).__name__,
            "diagnostic": str(error) if isinstance(error, ProbeError) else diagnostic,
        }
    evidence["distributions"] = summaries(evidence["pairs"])
    evidence["complete_pairs"] = sum(
        len(pair["samples"]) == 2 for pair in evidence["pairs"]
    )
    print(json.dumps(evidence, separators=(",", ":"), allow_nan=False))
    return 0 if evidence["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
