#!/usr/bin/env python3
"""Probe the supplied x86-64 USBCANFD SDK, USB enumeration and access permissions."""
from __future__ import annotations
import argparse
import json
import sys
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from app.drivers.zlgcan import ZlgCanDriver, probe_runtime_environment
from app.models import DeviceConfig


def main() -> int:
    parser=argparse.ArgumentParser()
    parser.add_argument("--open-test",action="store_true",help="call VCI_OpenDevice, initialize both CAN channels, then close")
    args=parser.parse_args()
    result=probe_runtime_environment()
    print(json.dumps(result,ensure_ascii=False,indent=2))
    if not result.get("ready"):
        return 2
    if args.open_test:
        driver=ZlgCanDriver(lambda frame: None)
        try:
            opened=driver.open(DeviceConfig(device_type=33))
            print("\nVCI open/init test: OK")
            print(json.dumps(opened,ensure_ascii=False,indent=2,default=str))
        finally:
            driver.close()
    return 0

if __name__=="__main__":
    raise SystemExit(main())
