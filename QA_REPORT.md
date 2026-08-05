# QA 报告 — v2.0.6

构建日期：2026-08-04

## 自动测试

- `PYTHONPATH=. pytest -q`：12 项通过。
- Python 编译检查通过。
- JavaScript `node --check` 通过。
- 上传包中的真实 `libusbcanfd.so`：x86-64 ELF、`ldd` 依赖和必需 `VCI_*` 符号通过。
- ABI 尺寸：位时序、CAN/CAN FD、板卡信息、状态、过滤、硬件周期和 LIN 初始化通过。
- 无硬件 HTTP 测试：`/api/device/preflight` 能识别无 `3068:0009`，`/api/device/open` 返回明确错误，操作状态持久保存。
- 模拟 VCI 动态库测试：设备类型 33 打开成功，CAN0/CAN1 初始化成功，状态为已连接，关闭成功。
- 阻塞 VCI 动态库测试：后端按配置超时返回 HTTP 504，不再让网页无限等待。
- 浏览器自动化：打开失败时错误持久展示且按钮恢复；打开成功时徽标和操作状态正确。
- 静态资源响应包含 `Cache-Control: no-store`。

## 实际上传驱动包验证

使用：

```text
usbcanfd_libusb_x64_1.0.14_260701.zip
```

实际加载：

```text
vendor/official_sdk/libusbcanfd.so
```

确认其依赖系统 `libusb-1.0.so.0`，并导出 CAN、CAN FD、Reference、LIN 和 UDS 相关接口。

## 尚需用户实机验证

- `lsusb -d 3068:0009` 能否枚举设备。
- 当前用户对 `/dev/bus/usb/...` 是否具有读写权限。
- 真实 `VCI_OpenDevice(33, 0, 0)` 返回值。
- 真实 CAN0/CAN1 收发、CAN FD 64 字节+BRS、硬件过滤、周期发送、队列、终端电阻、Bus-Off 恢复和 LIN 电气功能。
