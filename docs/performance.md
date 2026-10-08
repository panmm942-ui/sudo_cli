# Local computer performance

The Performance display measures the computer running SUDO CLI. It continues to show that computer when the selected AI runs in the cloud. It does not receive, estimate, or display a cloud provider's CPU, RAM, GPU, or VRAM usage.

The dashboard labels this block **Performance (This PC)** beside the antenna.

Version 0.6.6 shows each detected graphics card by name. System RAM and graphics memory are separate: an integrated card with 512 MiB does not replace a discrete card with about 8 GiB. Dedicated VRAM and shared system RAM have separate lines. Wider terminals place the named blocks beside the antenna; smaller terminals put them below the status fields. `/performance` prints the full details.

```text
/performance
/performance status
/performance refresh
```

`/performance` and `status` print the cached readings. `refresh` requests a new sample. The interactive monitor runs while idle and makes no model requests.

CPU and RAM refresh every 1.5 seconds. GPU and graphics memory refresh every 3 seconds. CPU starts with a baseline and shows a percentage after a second sample. A genuine idle reading can be 0%; an unsupported, denied, failed, or missing reading is **Unavailable**. A first delta sample is **Measuring**. A memory reading can show current usage while its capacity remains unavailable.

## What is measured

| Field | Measurement |
| --- | --- |
| CPU | Busy time divided by total time across the OS-visible logical processors, using differences between `node:os` CPU counters. This is whole-computer activity, including applications besides SUDO CLI. |
| RAM | OS-visible total memory minus current free memory, shown as bytes and a percentage. Free-memory definitions differ by OS; cache or compressed-memory accounting can differ from a system monitor's presentation. |
| GPU | Each named card's measured utilization. On Windows this is its busiest GPU engine, after summing process-instance time deltas. It is an interval average. Unmatched counters are labeled as unidentified, not claimed to be another physical card. |
| Dedicated VRAM | That card's dedicated graphics memory usage and capacity. A known capacity remains visible when usage is unavailable. Shared/unified memory uses a separate **Shared RAM** line. |

CPU/RAM reads use Node's built-in OS module. They run independently of GPU probes. GPU commands run asynchronously, without a shell or interactive profiles, using an environment that excludes AI credentials. Probe output is capped at 512 KiB and normal GPU queries time out after 2.5 seconds. A Windows inventory probe allows 4 seconds and 32 KiB. The display reads cached snapshots; it never waits for a driver query to redraw.

## Platform support

**Windows:** The GPU sampler reads `Win32_PerfRawData_GPUPerformanceCounters_GPUEngine` and `GPUAdapterMemory` through CIM. It does not depend on localized `Get-Counter` paths. The engine counter is a 100 ns timer: the sampler retains each process/engine baseline, subtracts 64-bit integer values, combines process time for the same engine, and chooses the busiest engine. It obtains memory usage at the adapter level rather than summing process memory, which could count allocations shared between processes more than once.

A bounded inventory caches usable DXGI adapter identities and pointer-sized dedicated/shared capacities, plus installed Windows graphics devices. Installed cards without a DXGI entry remain visible. Their capacity can come from an exact device-instance-to-display-driver association and a valid 64-bit memory-size value; `/performance` identifies this as driver-reported capacity. It never uses the 32-bit `Win32_VideoController.AdapterRAM` field or guesses capacity from a model name. The inventory excludes Microsoft's software renderer. Unknown or invalid capacity stays unavailable. Restart SUDO CLI after changing hardware or repairing a driver to refresh the inventory. No elevation is requested by the monitor.

A valid healthy inventory stays cached. Missing, incomplete or device-error inventory is retried at most once every 60 seconds, and a failed retry preserves the last known capacities. Restarting after a hardware or driver change requests a fresh inventory immediately.

A Windows device error does not become a fake idle reading. For example, a card with Code 43 can show `Unavailable / 8.0 GiB` and `Driver error 43`; its live utilization and memory usage stay unknown. Code 43 means a driver reported a device failure. The CLI displays the status and does not repair or reinstall system drivers. See [Microsoft's Code 43 explanation](https://learn.microsoft.com/en-us/windows-hardware/drivers/install/cm-prob-failed-post-start).

**Linux:** When an installed NVIDIA driver exposes `nvidia-smi`, a bounded query reads `utilization.gpu`, `memory.used`, and `memory.total`. Memory is converted from MiB to bytes. Unsupported fields such as `N/A` remain unknown. The monitor does not install NVIDIA tools or drivers. Linux GPU vendors without this utility currently show unavailable GPU/VRAM readings. In a container or WSL, CPU and RAM describe the OS-visible environment, and GPU availability depends on what that environment exposes.

**macOS:** A bounded read of the system `ioreg` utility inspects `IOAccelerator` driver statistics. Only explicit `Device Utilization %`, `vramUsedBytes`, and `vramTotalBytes` values are accepted. Driver properties are optional and are not a stable cross-device telemetry API; absent values remain unavailable. AGX/Apple GPU memory is labeled shared and never assigned a fictitious dedicated VRAM capacity. A driver service name alone is not counted as an identified physical GPU. The monitor does not request `sudo`, run continuous `powermetrics`, or install an SDK.

GPU usage, memory usage and capacity can have different availability. A card can have a known installed capacity with no valid live counters, or provide memory use before the first utilization delta. Failure of a live counter query does not erase a valid cached installed-card inventory.

**Unavailable** is a supported outcome. It is not a 0% reading. **Measuring** is a baseline waiting for its next delta. A measured memory count with no reliable capacity shows **total unavailable**. The app does not install drivers or invent remote cloud statistics to fill these fields.

## Lifecycle and API

`createSystemPerformance()` returns `start()`, `stop()`, `sample()`, and `snapshot()`. `start()` immediately returns a plain snapshot and starts the independent background timers. `sample()` provides an asynchronous manual refresh for checks. Concurrent GPU refreshes share one outstanding probe. `stop()` clears timers, aborts the outstanding subprocess, rejects its late updates, and resets delta baselines so a later restart does not average across the stopped period.

Snapshots contain `scope: 'local-computer'`, lifecycle status, timestamps, and separate `cpu`, `ram`, `gpu`, and `vram` objects. `null` means unknown. Metric status is `available`, `warming-up`, `unavailable`, or (for memory with known usage and unknown capacity) `partial`. GPU entries include identity, name, utilization, dedicated/shared bytes, memory kind, device status, error code and capacity source. Caller changes cannot modify the monitor's state. Errors never expose child diagnostic text, environment values, or provider credentials.

The monitor has no npm dependencies, network requests, model calls, or API-key requirement. Timers are unreferenced and do not keep an otherwise idle process alive. The app owns stopping the monitor when its UI exits.

## Verification and primary references

Focused automated tests cover CPU deltas/resets, real zero versus unknown, NVIDIA CSV and MiB parsing, exact Windows 64-bit deltas, per-engine aggregation, shared macOS memory, DXGI capacity matching/caching, snapshot isolation, nonblocking startup, concurrent refreshes, cleanup, restart baselines, timeout, output caps, and credential isolation. Read-only host probes verified Windows CIM/DXGI metrics and WSL/Linux CPU/RAM with truthful unavailable GPU data. A macOS host was not available for a live probe; macOS parsing was tested with driver-output fixtures.

- [Node OS counters and memory API](https://nodejs.org/api/os.html)
- [Microsoft GPU utilization and dedicated/shared memory semantics](https://devblogs.microsoft.com/directx/gpus-in-the-task-manager/)
- [Microsoft raw/formatted performance data](https://learn.microsoft.com/en-us/windows/win32/wmisdk/retrieving-raw-and-formatted-performance-data)
- [Microsoft raw counter formulas](https://learn.microsoft.com/en-us/windows/win32/perfctrs/calculating-counter-values)
- [DXGI adapter description and memory fields](https://learn.microsoft.com/en-us/windows/win32/api/dxgi/ns-dxgi-dxgi_adapter_desc)
- [DXGI adapter enumeration](https://learn.microsoft.com/en-us/windows/win32/api/dxgi/nf-dxgi-idxgifactory-enumadapters)
- [NVIDIA System Management Interface](https://docs.nvidia.com/deploy/nvidia-smi/)
- [Apple's ioreg manual source](https://github.com/apple-oss-distributions/IOKitTools/blob/main/ioreg.tproj/ioreg.8)
