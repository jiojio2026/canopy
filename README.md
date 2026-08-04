# CANopy

**A browser-based CAN/CAN FD analysis, simulation and testing workbench for Linux.**

CANopy turns a Linux computer and a ZLG USBCANFD-200U into a local web CAN tool. It supports two CAN/CAN FD channels, live Trace, periodic messages, simulation nodes, hardware filtering, hardware scheduled transmission, send queues, bus diagnostics and LIN.

> Current hardware backend: ZLG USBCANFD-200U, Linux x86-64, `VCI_*` ABI.

## Features

- CAN0/CAN1 dual-channel operation
- Classic CAN and CAN FD, ISO/Non-ISO, normal/listen-only modes
- Standard/extended frames, remote frames, BRS, ESI and self reception
- Up to 64-byte CAN FD payloads
- Live Trace, latest-value view, rolling view and CSV export
- Message library, simulation nodes and software periodic transmission
- 120 Ω termination control and transmission timeout
- Up to 64 hardware ID range filters per channel
- Eight hardware periodic-transmission slots exposed by the bundled header
- Hardware transmit queue, queue capacity, remaining space, delay and clear
- CAN controller state, error counters, error information and channel reset
- Two-channel LIN initialization, transmit/receive, Publish and Subscribe
- Bounded receive buffers and batched WebSocket updates
- Mock backend for UI development without hardware

## Supported platform

| Item | Supported configuration |
|---|---|
| Host OS | Linux x86-64 |
| Adapter | ZLG USBCANFD-200U |
| USB ID | `3068:0009` |
| Vendor library | `libusbcanfd.so` 1.0.14 |
| Python | 3.8+ |

The repository includes the x86-64 SDK package supplied for this adapter. The vendor binary files are not covered by CANopy's MIT license; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Quick start

```bash
git clone https://github.com/jiojio2026/canopy.git
cd canopy

sudo apt update
sudo apt install -y \
  python3 python3-venv usbutils file \
  libusb-1.0-0 libudev1 libcap2

python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

./tools/install_zlg_sdk.sh
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

Open:

```text
http://127.0.0.1:8000
```

To access it from another computer on the LAN:

```bash
CAN_WEB_HOST=0.0.0.0 ./run_real.sh
```

Then open `http://<linux-host-ip>:8000`.

## Mock mode

```bash
./run_mock.sh
```

Mock mode exercises the web UI and APIs without opening USB hardware.

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

Project layout:

```text
app/                    FastAPI backend and browser UI
app/drivers/            Mock and ZLG VCI backends
tests/                  ABI, model, store and driver tests
tools/                  SDK, udev and device diagnostics
vendor/official_sdk/    Extracted ZLG x86-64 SDK files
vendor/packages/        Original SDK ZIP package
data/                    Runtime configuration and captures
```

## Current validation boundary

Automated tests cover model validation, bounded storage, the Mock backend, VCI ABI structure sizes, queue encoding and loading the bundled x86-64 vendor library. A behavior-compatible test library covers open/init/start/close and timeout paths.

Real bus behavior—especially electrical termination, bus-off recovery, high-load loss testing, hardware periodic accuracy, queue timing and LIN—must still be verified with physical hardware and a correctly terminated CAN network.

## License

CANopy source code is released under the [MIT License](LICENSE).

Files under `vendor/official_sdk/` and `vendor/packages/` are third-party ZLG materials and are excluded from the MIT grant. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
