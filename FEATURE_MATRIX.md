# USBCANFD-200U Linux 功能矩阵

| 能力 | v2.0.6 后端 | 自动验证 | 实机状态 |
|---|---|---:|---|
| 双路 Classic CAN | `VCI_InitCAN/Transmit/Receive` | ABI + 假库冒烟 | 待目标设备验证 |
| 双路 CAN FD、BRS、ESI | `VCI_TransmitFD/ReceiveFD` | ABI + 12 字节发送 | 待 64 字节和满载验证 |
| ISO/Non-ISO、只听 | `ZCANFD_INIT.mode` | 结构和配置测试 | 待总线验证 |
| 波特率 | 60 MHz 位时序计算 | 40k–5M 精确计算测试 | 待不同采样点验证 |
| 64 条硬件过滤 | Reference `0x14` | 结构大小测试 | 待边界验证 |
| 120Ω 终端电阻 | Reference `0x18` | 调用冒烟 | 待电气验证 |
| 硬件定时发送 | Reference `0x16/0x17` | 8 项结构测试 | 当前公共 ABI 仅确认 8 项 |
| 硬件发送队列 | Reference `0x100..0x103` + 帧标志 | 延时编码测试 | 待精度/容量验证 |
| 状态与 Bus-Off | `VCI_ReadCANStatus/ReadErrInfo` | 假库冒烟 | 待故障注入 |
| LIN 基础功能 | `VCI_Init/Transmit/ReceiveLIN`、Publish/Subscribe | 符号探测 | 取决于库/硬件版本 |
| LIN Schedule | Linux 库未发现公开符号 | 明确拒绝 | 不支持 |
| 接收合并 | `0x32/0x33`，需 `VCI_ReceiveData` | 防误开启 | 暂未开放 |
| UDS | 可选 `VCI_UDS_*` | 仅符号探测 | 尚未接入网页 API |
| Trace/CSV/负载 | Web 后端 | 已测试 | 可用 |
