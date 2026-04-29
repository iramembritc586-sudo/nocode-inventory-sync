# EXE 使用说明（Win7 - Win11）

## 当前可用文件
- 主程序：`nocode/nocode.exe`（最新修复版，2026-04-28 20:20）
- 诊断启动：`nocode/start-nocode-diagnostic.bat`

## 1. 发送给目标电脑
建议把 `nocode` 文件夹整体复制过去（至少要带上 `nocode.exe`）。

## 2. 正常启动
双击 `nocode.exe`。

程序会：
1. 自动启动本地服务
2. 自动打开浏览器
3. 控制台显示 `LAN URL(s)`，手机应访问这个地址

## 3. 手机访问规则
- 手机和电脑必须同一个 Wi-Fi
- 手机打开 `http://192.168.x.x:8080`
- 不要用 `127.0.0.1`（只代表当前设备自己）

## 4. 如果还是“一闪就关”
双击 `start-nocode-diagnostic.bat`，窗口不会立即关闭，会显示退出码和日志尾部。

日志路径：
- `%APPDATA%\nocode-inventory-sync\nocode-runtime.log`

## 5. 防火墙端口（管理员 PowerShell）
```powershell
netsh advfirewall firewall add rule name="NoCodeInventorySync-8080" dir=in action=allow protocol=TCP localport=8080 profile=any
```

## 6. 可选参数
```powershell
nocode.exe --port 8090 --no-open
```
- `--port`：指定端口
- `--no-open`：不自动打开浏览器
