# 官方 ZLG Linux SDK

此版本已内置用户提供的官方包：

- `usbcanfd_libusb_x64_1.0.14_260701.zip`
- `official_sdk/libusbcanfd.so`（x86-64）
- `official_sdk/libzuds.so`
- `zcan.h`、`zuds.h` 和官方 Python Demo

无需联网下载。首次使用只需安装系统依赖并执行检查：

```bash
sudo apt install -y libusb-1.0-0 libudev1 libcap2 file
./tools/install_zlg_sdk.sh
```

注意：官方 ZIP 中名为 `libusb-1.0.so` 的文件实际是 ARM64，不能用于该 x86-64 包。本项目不会复制或加载它，而是使用系统的 `libusb-1.0.so.0`。
