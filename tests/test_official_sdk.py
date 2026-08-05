import ctypes as C
from pathlib import Path


def test_bundled_official_sdk_exports_vci_api():
    root = Path(__file__).resolve().parents[1]
    so = root / "vendor" / "official_sdk" / "libusbcanfd.so"
    assert so.is_file() and so.stat().st_size > 0
    lib = C.CDLL(str(so), mode=getattr(C, "RTLD_GLOBAL", 0))
    required = (
        "VCI_OpenDevice", "VCI_CloseDevice", "VCI_InitCAN", "VCI_StartCAN",
        "VCI_Transmit", "VCI_Receive", "VCI_TransmitFD", "VCI_ReceiveFD",
        "VCI_SetReference", "VCI_GetReference", "VCI_InitLIN", "VCI_StartLIN",
        "VCI_UDS_Request", "VCI_UDS_Control",
    )
    assert not [name for name in required if not hasattr(lib, name)]
