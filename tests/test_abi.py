import ctypes as C

from app.drivers.zlgcan import (
    VCI_BIT_TIMING,
    VCI_BOARD_INFO,
    VCI_CANFD_INIT_CONFIG,
    VCI_CANFD_MSG,
    VCI_CAN_MSG,
    VCI_CAN_STATUS,
    VCI_FILTER,
    VCI_FILTER_TABLE,
    VCI_LIN_INIT_CONFIG,
    VCI_TTX,
    VCI_TTX_CONFIG,
    calculate_bit_timing,
)


def test_core_vci_abi_sizes_and_offsets():
    assert C.sizeof(VCI_BIT_TIMING) == 6
    assert C.sizeof(VCI_CANFD_INIT_CONFIG) == 20
    assert VCI_CANFD_INIT_CONFIG.abit.offset == 8
    assert VCI_CANFD_INIT_CONFIG.dbit.offset == 14
    assert C.sizeof(VCI_CAN_MSG) == 24
    assert C.sizeof(VCI_CANFD_MSG) == 80
    assert VCI_CAN_MSG.flags.offset == 8
    assert VCI_CAN_MSG.delay.offset == 12
    assert VCI_CAN_MSG.channel.offset == 14
    assert VCI_CAN_MSG.length.offset == 15
    assert C.sizeof(VCI_BOARD_INFO) == 79
    assert C.sizeof(VCI_CAN_STATUS) == 12
    assert C.sizeof(VCI_FILTER) == 12
    assert C.sizeof(VCI_FILTER_TABLE) == 772
    assert C.sizeof(VCI_TTX) == 88
    assert C.sizeof(VCI_TTX_CONFIG) == 708
    assert C.sizeof(VCI_LIN_INIT_CONFIG) == 8


def test_common_rates_have_exact_60mhz_timing():
    for bitrate in (40_000, 125_000, 250_000, 500_000, 1_000_000, 2_000_000, 4_000_000, 5_000_000):
        t = calculate_bit_timing(bitrate, 0.75 if bitrate >= 5_000_000 else 0.80)
        actual = 60_000_000 // ((int(t.brp) + 1) * (int(t.tseg1) + int(t.tseg2) + 3))
        assert actual == bitrate
