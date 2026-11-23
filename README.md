# CANopy

**A browser-based CAN/CAN FD analysis, simulation and testing workbench for Linux.**

CANopy turns a Linux computer and a ZLG USBCANFD-200U into a local web CAN tool. It supports two CAN/CAN FD channels, live Trace, periodic messages, simulation nodes, hardware filtering, hardware scheduled transmission, send queues, bus diagnostics and LIN.

> Current hardware backend: ZLG USBCANFD-200U, Linux x86-64, `VCI_*` ABI.

## Features

The v0.5.0 interface uses a responsive sidebar, a device-status toolbar, and a Wireshark-inspired high-density Trace workbench with a compact decoded-signal table. The mobile layout keeps the original device controls and horizontally scrollable data tables.


- CAN0/CAN1 dual-channel operation
- Classic CAN and CAN FD, ISO/Non-ISO, normal/listen-only modes
- Standard/extended frames, remote frames, BRS, ESI and self reception
- Up to 64-byte CAN FD payloads
- Live Trace, latest-value view, rolling view and CSV export
- Wireshark-style Trace table: compact (32 px) / standard row density, sortable headers, ID/channel/RX-TX filters, draggable column widths and hide/reorder column controls (saved to browser localStorage)
- Signal Inspector and expanded signal details use dense tables, retaining raw values, enum/bitfield labels, search and independent scrolling
- Built-in custom signal editor: right-click a Trace frame to define bits, endian, signed/unsigned/IEEE754, Factor/Offset and unit; Enum/Bitfield state labels and fault flags; occupied-bit highlighting and JSON library import/export without a DBC
- Message library, simulation nodes and software periodic transmission
- 120 Ω termination control and transmission timeout
- Up to 64 hardware ID range filters per channel
- Eight hardware periodic-transmission slots exposed by the bundled header
- Hardware transmit queue, queue capacity, remaining space, delay and clear
- CAN controller state, error counters, error information and channel reset
- Two-channel LIN initialization, transmit/receive, Publish and Subscribe
- Bounded receive buffers and batched WebSocket updates
- Long-running Trace protection: at most 3,000 buffered browser frames and 1,000 displayed rows; only one HTTP snapshot in flight; WebSocket streaming pauses when Trace is hidden
- Mock backend for UI development without hardware

## Wireshark-style Trace layout (v0.5.0)

Use **实时 Trace** for high-density CAN/CAN FD capture.

- **Filter** using a numeric CAN ID (e.g. `0x706` or decimal `1798`), a channel, and RX/TX; these only affect the browser view, **not** the captured frames or CSV export. Clear the filter to show all frames in the bounded snapshot.
- **Sort** by clicking any column heading, including CAN ID, timestamp, frequency and signal name. Click it again to reverse direction. The underlying capture order is unchanged.
- **Density** defaults to *紧凑* (approximately 32 px per row). Select *标准* to increase spacing.
- **Columns**: open *列设置* to show/hide columns, move them up/down, or restore the default layout. Drag the narrow right border of a header to resize its column; keyboard users can focus the separator and press Left/Right arrows.
- **Persistence**: density, visible columns, widths and order are saved in your browser's `localStorage` under `canopy.trace.layout.v1`. They do not modify device configuration or signal definitions. Sorting and filters are temporary to the current browser session.
- **Signal Inspector**: a lower pane below the packet list opens when you click a CAN ID, showing a searchable, compact five-column table (name, decoded value, raw hex, unit, status). *展开全部* below a packet opens a second compact table. Only one packet can be expanded at a time.

Original CAN/CAN FD decoding, right-click signal definition, full raw payload, 1,000 displayed-frame / 3,000 rolling-frame limits and WebSocket visibility pausing are retained. The entire Trace table still redraws on scheduled updates; longer-term virtualization and very-high-rate browser profiling remain potential improvements.

## Custom signal editor (no DBC required)

1. Open **实时 Trace**, right-click any CAN/CAN FD row (for example CAN1, \`0x706\`) and select **定义信号**. Clicking the CAN ID opens a live signal inspector; the **信号库** toolbar button opens management for all definitions.
2. Enter a descriptive **信号名称**, **Start Bit** and **Bit Length**, choose **Intel / Little Endian** or **Motorola / Big Endian** and the correct data type. If necessary, set **Factor**, **Offset** and **Unit**. A selected frame provides a clickable byte/bit map and decoded sample preview.
3. Click **保存并实时解析**. The Trace table gains a decoded-signal summary **next to CAN ID**; for messages with more than two signals, click **展开全部 N 项** to show a bounded, scrollable panel with every decoded signal below that one row. Click the CAN ID for a separate live inspector with search and its own scrolling region. In the signal library, edit, remove, or export your definitions.
4. Definitions are saved automatically to **\`data/signals.json\`** (or \`$CAN_WEB_DATA/signals.json\`) and are loaded on the next launch. Export JSON from the library for backup. Exporting a standard DBC file is not part of this first release.

4. For **Enum**, choose "枚举 Enum" and enter one raw-value mapping per line (e.g. `0=初始化`, `4=运行`, `5=错误`). For fault **Bitfield**, choose "位标志 Bitfield" and use bit-index mappings (e.g. `0=驱动芯片故障`, `1=母线过压`, `4=编码器故障`). Multiple set bits appear together; unknown set bits are indicated explicitly. Both modes operate on unsigned raw data with Factor=1 and Offset=0.
5. When defining another signal on the same channel / CAN ID / frame type, the bit map highlights previously saved fields in purple, your current selection in blue and overlaps in amber. Existing signal chips can be clicked to edit. Overlaps remain permitted for fault bit fields and raw-word views.
6. Open **信号库** and click **导入信号库 JSON** to restore the JSON previously exported by CANopy. By default conflicting signals are **skipped**, preserving the local definition; selecting **覆盖同名信号** explicitly replaces a matching signal. Import validates the full file (up to 512 signals) before saving; importing a file preserves existing unrelated signals. This is a local JSON backup/restore workflow, **not** a standard DBC import.

**Protocol caution:** This editor decodes according to definitions you supply; it cannot infer the semantic meaning of unknown vendor bytes. Bit numbering follows DBC conventions (Intel start bit is LSB of the signal; Motorola start bit is MSB of the signal with per-byte sawtooth bit numbering). Classic CAN is limited to 8 bytes, CAN FD to 64 bytes. Message matching is scoped to channel, CAN/CAN FD kind, frame ID and standard/extended ID type. Truncated frames produce a decoding error rather than a fabricated value.

The decoder runs on HTTP snapshots and WebSocket broadcast batches, not the hardware receive callback. Trace data buffers remain bounded (1,000 regular Trace rows / 3,000 rolling browser frames); at most one extra decoded-detail row is expanded at once, and the inspector/detail panels scroll independently. Long-running, high-load verification still requires real hardware.

## Supported platform

| Item | Supported configuration |
|---|---|
| Host OS | Linux x86-64 |
| Adapter | ZLG USBCANFD-200U |
| USB ID | `3068:0009` |
| Vendor library | `libusbcanfd.so` 1.0.15 |
| Python | 3.8+ |

Install the official x86-64 SDK separately. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for vendor licensing information.

## Quick start

Download the [official ZLG Linux x86-64 SDK 1.0.15](https://manual.zlg.cn/server/index.php?s=/api/attachment/visitFile/sign/f76024fda59e77e1b403127ee9764990) and save it as `usbcanfd_libusb_x64_1.0.15_260827.zip` in your Downloads directory.

```bash
git clone https://github.com/jiojio2026/canopy.git
cd canopy

sudo apt update
sudo apt install -y \
  python3 python3-venv usbutils file unzip binutils \
  libusb-1.0-0 libudev1 libcap2

python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

./tools/install_zlg_sdk.sh "$HOME/Downloads/usbcanfd_libusb_x64_1.0.15_260827.zip"
sudo ./tools/install_udev_rule.sh
```

Reconnect the adapter, then verify it:

```bash
lsusb -d 3068:0009
python3 tools/probe_device.py
python3 tools/probe_device.py --open-test
```

`--open-test` opens the adapter, initializes CAN0/CAN1 and closes it without transmitting CAN frames.

Start CANopy:

```bash
./run_real.sh
```

Open `http://127.0.0.1:8000`.

For LAN access:

```bash
CAN_WEB_HOST=0.0.0.0 ./run_real.sh
```

Then open `http://<linux-host-ip>:8000`.

## Mock mode

```bash
./run_mock.sh
```

## Opening-device diagnostics

The dashboard contains a persistent operation-status panel and a **Connection diagnostics** action. Common failures are reported explicitly:

- USB device not found: check power, cable and `lsusb -d 3068:0009`.
- USB permission denied: run `sudo ./tools/install_udev_rule.sh` and reconnect the adapter.
- `VCI_OpenDevice` failed: CANopy reports each attempted device type and return value.
- CAN channel initialization failed: CANopy reports the channel and calculated timing configuration.
- Vendor call timeout: the API returns a timeout instead of leaving the browser button stuck.

The uploaded Linux demo uses device type `33`; CANopy tries `33` first and falls back to `41` for SDK variants that use the product-specific identifier.

## Development

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
pytest -q
```

Environment and ABI check:

```bash
source vendor/zlgcan_env.sh
python3 tools/check_environment.py
```

## Project layout

```text
app/                    FastAPI backend and browser UI
app/drivers/            Mock and ZLG VCI backends
tests/                  ABI, model, store and driver tests
tools/                  SDK, udev and device diagnostics
vendor/official_sdk/    Extracted ZLG x86-64 SDK files
vendor/packages/        Original SDK ZIP package
data/                    Runtime configuration and captures
```

## Validation boundary

Automated tests cover model validation, bounded storage, the Mock backend, VCI ABI structure sizes, queue encoding and loading the installed x86-64 vendor library. A behavior-compatible test library covers open/init/start/close and timeout paths.

Real bus behavior—especially electrical termination, bus-off recovery, high-load loss testing, hardware periodic accuracy, queue timing and LIN—must still be verified with physical hardware and a correctly terminated CAN network.

## License

CANopy source code is released under the [MIT License](LICENSE).

Files under `vendor/official_sdk/` and `vendor/packages/` are third-party ZLG materials and are excluded from the MIT grant. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
