#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Websocket_Server.py
J-Link RTT 二进制帧 RuntimeOnce WebSocket 后端

MCU RTT 帧格式固定 8 字节：

    [0] 0xAA
    [1] 0x55
    [2] taskId / runnableId
    [3] type
        0xCC = Task
        0xDD = Runnable
    [4] value bit0~7
    [5] value bit8~15
    [6] value bit16~23
    [7] value bit24~31

Python 转发给 HTML 的格式：

    OS_TASK_0_RuntimeOnce = 12345
    RUNNABLE_1_RuntimeOnce = 67890

启动流程：

    1. 清理旧的 WebSocket 8765 占用
    2. 清理旧的 JLinkGDBServerCL.exe
    3. 启动 JLinkGDBServerCL.exe
    4. 通过 GDB 2331 端口发送 monitor halt / reset / go
    5. Python 连接 RTT Telnet 19021
    6. 解析 AA55 二进制帧
    7. WebSocket 批量转发到 ws://127.0.0.1:8765

依赖：

    pip install websockets
"""

import asyncio
import atexit
import os
import queue
import socket
import struct
import subprocess
import threading
import time
import sys
import locale

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

WIN_CMD_ENCODING = "mbcs" if os.name == "nt" else locale.getpreferredencoding(False)


def run_win_cmd(cmd, timeout=5):
    """
    安全运行 Windows 命令并读取输出。

    Electron 启动 Python 时通常会强制 PYTHONUTF8=1。
    但是 netstat/taskkill 这类 Windows 命令输出仍可能是系统 ANSI/GBK。
    这里显式使用 mbcs 并 errors=replace，避免 UnicodeDecodeError。
    """
    return subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding=WIN_CMD_ENCODING,
        errors="replace",
        timeout=timeout
    )


import websockets


# ============================================================
# 配置区
# ============================================================

# 是否清理占用 8765 的旧进程
AUTO_KILL_OLD_WS_PORT = True

# 是否清理旧的 JLinkGDBServerCL
AUTO_KILL_OLD_GDBSERVER = True

# 是否自动启动 JLinkGDBServerCL
AUTO_START_JLINK_GDBSERVER = True

# 是否通过 GDB 2331 端口发送 halt/reset/go
AUTO_RESET_GO_VIA_GDB_PORT = True

# SEGGER J-Link GDB Server 路径
JLINK_GDBSERVER_EXE = os.environ.get("JLINK_GDBSERVER_EXE", r"C:\Program Files\SEGGER\JLink\JLinkGDBServerCL.exe")

# 目标芯片配置
JLINK_DEVICE = "Z20K116N"
JLINK_IF = "SWD"
JLINK_SPEED = "4000"

# GDBServer 控制端口
GDB_HOST = "127.0.0.1"
GDB_PORT = 2331

# RTT Telnet 数据端口
RTT_TELNET_HOST = "127.0.0.1"
RTT_TELNET_PORT = 19021

# WebSocket 端口，HTML 连接 ws://127.0.0.1:8765
WS_HOST = "0.0.0.0"
WS_PORT = 8765

# 启动 GDBServer 后等待时间
WAIT_AFTER_GDBSERVER_START_S = 3.0

# monitor reset 后等待时间
WAIT_AFTER_MONITOR_RESET_S = 0.8

# monitor go 后等待 MCU 运行和 RTT 初始化
WAIT_AFTER_MONITOR_GO_S = 1.0

# RTT 连接失败重试间隔
RECONNECT_S = 3.0

# GDBServer 是否新开窗口。
# 桌面版默认隐藏 SEGGER GDBServer 窗口，连接过程由 Electron 启动页展示。
GDBSERVER_NEW_CONSOLE = False

# 调试打印
# 重要：高频运行时必须保持 False，否则 CMD 控制台刷屏会严重拖慢甚至假死
DEBUG_PRINT_RAW_RTT = False
DEBUG_PRINT_FRAME = False

# 队列最大缓存行数，防止内存无限增长
LINE_QUEUE_MAXSIZE = 5000

# WebSocket 每次最多发送多少行
MAX_LINES_PER_SEND = 300

# WebSocket 批量发送周期，单位秒
SEND_INTERVAL_S = 0.05


# ============================================================
# MCU 二进制帧定义
# ============================================================

FRAME_SYNC0 = 0xAA
FRAME_SYNC1 = 0x55
FRAME_SIZE = 8

TYPE_TASK = 0xCC
TYPE_RUNNABLE = 0xDD

VALID_TYPES = (TYPE_TASK, TYPE_RUNNABLE)


# ============================================================
# 全局变量
# ============================================================

line_queue = queue.Queue(maxsize=LINE_QUEUE_MAXSIZE)
connected_clients = set()
gdbserver_proc = None
stop_event = threading.Event()


# ============================================================
# 基础工具函数
# ============================================================

def frame_to_line(fid: int, ftype: int, value: int):
    """
    将 MCU 8 字节二进制帧转换成 HTML 前端可识别的文本行。
    """
    if ftype == TYPE_TASK:
        key = f"OS_TASK_{fid}_RuntimeOnce"
    elif ftype == TYPE_RUNNABLE:
        key = f"RUNNABLE_{fid}_RuntimeOnce"
    else:
        return None

    return f"{key} = {value}"


def safe_put_line(line: str):
    """
    安全写入队列。

    队列满时丢弃最旧数据，再写入新数据。
    这样可以避免 WebSocket 或前端处理不过来时 Python 内存无限增长。
    """
    try:
        line_queue.put_nowait(line)
    except queue.Full:
        try:
            line_queue.get_nowait()
        except queue.Empty:
            pass

        try:
            line_queue.put_nowait(line)
        except queue.Full:
            pass


def kill_process_on_port(port: int):
    """
    根据端口查找占用进程并关闭。

    主要用于清理旧的 WebSocket 8765 占用。
    """
    try:
        result = run_win_cmd(["netstat", "-ano"], timeout=5)

        current_pid = str(os.getpid())
        pids = set()

        for line in result.stdout.splitlines():
            if f":{port}" not in line:
                continue

            parts = line.split()
            if len(parts) < 5:
                continue

            pid = parts[-1]

            if pid.isdigit() and pid != current_pid:
                pids.add(pid)

        for pid in pids:
            print(f"[CLEAN] Port {port} is occupied by PID {pid}, killing ...", flush=True)

            run_win_cmd(["taskkill", "/F", "/PID", pid], timeout=5)

    except Exception as e:
        print(f"[WARN] Failed to clean port {port}: {e}", flush=True)


def kill_old_gdbserver():
    """
    清理旧的 JLinkGDBServerCL，避免旧进程占用 19021 / 2331 或占用 J-Link。
    """
    if not AUTO_KILL_OLD_GDBSERVER:
        return

    print("[CLEAN] Cleaning old JLinkGDBServerCL.exe ...", flush=True)

    try:
        run_win_cmd(["taskkill", "/F", "/IM", "JLinkGDBServerCL.exe"], timeout=5)
    except Exception:
        pass

    time.sleep(0.5)


def start_jlink_gdbserver():
    """
    启动 JLinkGDBServerCL，打开：
    - GDB 端口 2331
    - RTT Telnet 端口 19021

    不主动 socket 探测 19021。
    RTT Telnet 通常只允许一个活动连接，探测连接可能抢占数据连接。
    """
    global gdbserver_proc

    if not AUTO_START_JLINK_GDBSERVER:
        print("[INFO] Auto start J-Link GDB Server is disabled.", flush=True)
        return

    if not os.path.exists(JLINK_GDBSERVER_EXE):
        print(f"[ERROR] JLinkGDBServerCL.exe not found: {JLINK_GDBSERVER_EXE}", flush=True)
        print("   Please update JLINK_GDBSERVER_EXE to your actual installation path.", flush=True)
        return

    cmd = [
        JLINK_GDBSERVER_EXE,
        "-device", JLINK_DEVICE,
        "-if", JLINK_IF,
        "-speed", JLINK_SPEED,
        "-port", str(GDB_PORT),
        "-RTTTelnetPort", str(RTT_TELNET_PORT),
        "-noreset",
        "-nohalt",
        "-nogui",
        "-silent"
    ]

    print("[START] Starting J-Link GDB Server:", flush=True)
    print("   " + " ".join(f'"{x}"' if " " in x else x for x in cmd), flush=True)

    try:
        creationflags = 0
        startupinfo = None

        if os.name == "nt":
            if GDBSERVER_NEW_CONSOLE:
                creationflags |= subprocess.CREATE_NEW_CONSOLE
            else:
                creationflags |= subprocess.CREATE_NO_WINDOW
                startupinfo = subprocess.STARTUPINFO()
                startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                startupinfo.wShowWindow = 0

        gdbserver_proc = subprocess.Popen(
            cmd,
            creationflags=creationflags,
            startupinfo=startupinfo
        )

        print(f"[WAIT] Waiting for GDBServer initialization: {WAIT_AFTER_GDBSERVER_START_S:.1f}s", flush=True)
        time.sleep(WAIT_AFTER_GDBSERVER_START_S)
        print("[OK] J-Link GDBServer process started.", flush=True)

    except Exception as e:
        print(f"[ERROR] Failed to start J-Link GDB Server: {e}", flush=True)


# ============================================================
# GDB Remote Serial Protocol
# 用于通过 2331 端口发送 monitor halt / reset / go
# ============================================================

def rsp_checksum(payload: str) -> str:
    """
    GDB Remote Serial Protocol checksum。
    """
    s = sum(payload.encode("ascii")) & 0xFF
    return f"{s:02x}"


def rsp_packet(payload: str) -> bytes:
    """
    生成 RSP 数据包：$payload#checksum
    """
    return f"${payload}#{rsp_checksum(payload)}".encode("ascii")


def rsp_recv_packet(sock: socket.socket, timeout_s: float = 2.0) -> str:
    """
    读取一个 RSP 数据包，返回 payload 字符串。
    """
    sock.settimeout(timeout_s)

    while True:
        ch = sock.recv(1)
        if not ch:
            return ""

        if ch == b"$":
            break

    payload = bytearray()

    while True:
        ch = sock.recv(1)
        if not ch:
            return ""

        if ch == b"#":
            _ = sock.recv(2)

            try:
                sock.sendall(b"+")
            except Exception:
                pass

            return payload.decode("ascii", errors="ignore")

        payload.extend(ch)


def rsp_send_packet(sock: socket.socket, payload: str, wait_reply: bool = True) -> str:
    """
    发送一个 RSP 包，并读取回复。
    """
    pkt = rsp_packet(payload)

    sock.sendall(pkt)

    try:
        ack = sock.recv(1)
        if ack != b"+":
            pass
    except socket.timeout:
        pass

    if wait_reply:
        return rsp_recv_packet(sock, timeout_s=3.0)

    return ""


def rsp_monitor_command(sock: socket.socket, command: str) -> str:
    """
    发送 monitor 命令。

    GDB 中的：
        monitor halt
        monitor reset
        monitor go

    RSP 中对应：
        qRcmd,<ascii hex>
    """
    hex_cmd = command.encode("ascii").hex()
    payload = f"qRcmd,{hex_cmd}"

    print(f"   monitor {command}", flush=True)

    resp = rsp_send_packet(sock, payload, wait_reply=True)

    if resp:
        print(f"   monitor {command} response: {resp[:120]}", flush=True)

    return resp


def reset_go_via_gdbserver():
    """
    连接 GDBServer 2331 端口，通过 monitor 命令执行 halt/reset/go。
    """
    if not AUTO_RESET_GO_VIA_GDB_PORT:
        print("[INFO] GDB port reset/go is disabled.", flush=True)
        return

    print(f"[START] Sending halt/reset/go through GDBServer port {GDB_PORT} ...", flush=True)

    sock = None

    try:
        sock = socket.create_connection((GDB_HOST, GDB_PORT), timeout=5)
        sock.settimeout(3.0)

        try:
            initial = rsp_recv_packet(sock, timeout_s=2.0)
            if initial:
                print(f"   GDB initial response: {initial[:120]}", flush=True)
        except Exception:
            pass

        rsp_monitor_command(sock, "halt")
        time.sleep(0.2)

        rsp_monitor_command(sock, "reset")
        time.sleep(WAIT_AFTER_MONITOR_RESET_S)

        rsp_monitor_command(sock, "go")
        time.sleep(WAIT_AFTER_MONITOR_GO_S)

        print("[OK] GDBServer monitor halt/reset/go sent.", flush=True)

    except Exception as e:
        print(f"[ERROR] Failed to send halt/reset/go through GDBServer: {e}", flush=True)
        print("   If this fails, open J-Link Commander and send r/g manually for verification.", flush=True)

    finally:
        if sock is not None:
            try:
                sock.close()
            except Exception:
                pass


def cleanup():
    """
    程序退出时关闭本脚本启动的 GDBServer。
    """
    global gdbserver_proc

    stop_event.set()

    if gdbserver_proc is not None:
        try:
            print("[STOP] Closing J-Link GDB Server started by this script ...", flush=True)
            gdbserver_proc.terminate()
            try:
                gdbserver_proc.wait(timeout=2)
            except Exception:
                if os.name == "nt":
                    run_win_cmd(["taskkill", "/T", "/F", "/PID", str(gdbserver_proc.pid)], timeout=5)
                else:
                    gdbserver_proc.kill()
        except Exception:
            pass


atexit.register(cleanup)


# ============================================================
# 二进制帧解析器
# ============================================================

class BinaryFrameParser:
    """
    只解析 MCU 发出的 8 字节二进制帧。

    解析策略：
    1. 在字节流中搜索 0xAA 0x55
    2. 找到后检查后续是否满 8 字节
    3. 检查 frame[3] 是否为 0xCC 或 0xDD
    4. 合法则解析 value
    5. 非法则丢弃当前 0xAA，继续搜索下一个同步头
    """

    def __init__(self):
        self.buf = bytearray()

    def feed(self, data: bytes):
        self.buf.extend(data)
        out = []

        while True:
            if len(self.buf) < 2:
                break

            sync_index = self._find_sync()

            if sync_index < 0:
                # 没找到 AA55，只保留最后一个字节，防止 AA 被拆包
                self.buf = self.buf[-1:]
                break

            if sync_index > 0:
                # 丢弃 AA55 前面的无效数据
                del self.buf[:sync_index]

            if len(self.buf) < FRAME_SIZE:
                # 找到 AA55，但是不够 8 字节，等待下次 recv
                break

            frame = bytes(self.buf[:FRAME_SIZE])

            if frame[0] != FRAME_SYNC0 or frame[1] != FRAME_SYNC1:
                del self.buf[0]
                continue

            fid = frame[2]
            ftype = frame[3]

            if ftype not in VALID_TYPES:
                # 不是合法帧，只丢掉当前 AA，继续搜索
                del self.buf[0]
                continue

            value = struct.unpack_from("<I", frame, 4)[0]

            line = frame_to_line(fid, ftype, value)
            if line:
                out.append(line)

                if DEBUG_PRINT_FRAME:
                    print(
                        f"[OK] RTT帧: "
                        f"AA 55 id={fid} type=0x{ftype:02X} value={value} -> {line}"
                    )

            del self.buf[:FRAME_SIZE]

        return out

    def _find_sync(self):
        for i in range(len(self.buf) - 1):
            if self.buf[i] == FRAME_SYNC0 and self.buf[i + 1] == FRAME_SYNC1:
                return i
        return -1


# ============================================================
# RTT Telnet 读取线程
# ============================================================

def rtt_reader_thread():
    parser = BinaryFrameParser()

    while not stop_event.is_set():
        sock = None

        try:
            print(f"[CONNECT] Connecting J-Link RTT Telnet {RTT_TELNET_HOST}:{RTT_TELNET_PORT} ...", flush=True)

            sock = socket.create_connection(
                (RTT_TELNET_HOST, RTT_TELNET_PORT),
                timeout=5
            )
            sock.settimeout(1.0)

            print("[OK] RTT Telnet connected. Start reading binary frames ...", flush=True)
            print("   Expected frame: AA 55 id type value[4]", flush=True)
            print("   type: 0xCC = Task, 0xDD = Runnable", flush=True)
            print("", flush=True)

            while not stop_event.is_set():
                try:
                    data = sock.recv(4096)
                except socket.timeout:
                    continue

                if not data:
                    raise ConnectionError("RTT Telnet 端口已关闭")

                if DEBUG_PRINT_RAW_RTT:
                    preview = data[:128]
                    print("[RAW] RTT raw data:", preview.hex(" "), repr(preview), flush=True)

                lines = parser.feed(data)

                for line in lines:
                    safe_put_line(line)

        except ConnectionRefusedError as e:
            print(f"[ERROR] RTT Telnet connection refused: {e}", flush=True)
            print("   Common causes:", flush=True)
            print("   1. GDBServer is not fully started.", flush=True)
            print("   2. Port 19021 is already connected by another client.", flush=True)
            print("   3. Old Python/Telnet/RTT Viewer is still running.", flush=True)
            print(f"   Retry after {RECONNECT_S:.0f}s ...", flush=True)
            time.sleep(RECONNECT_S)

        except OSError as e:
            print(f"[ERROR] RTT Telnet connection error: {e}", flush=True)
            print(f"   Retry after {RECONNECT_S:.0f}s ...", flush=True)
            time.sleep(RECONNECT_S)

        except Exception as e:
            print(f"[ERROR] RTT read error: {e}", flush=True)
            print(f"   Reconnect after {RECONNECT_S:.0f}s ...", flush=True)
            time.sleep(RECONNECT_S)

        finally:
            if sock is not None:
                try:
                    sock.close()
                except Exception:
                    pass


# ============================================================
# WebSocket
# ============================================================

async def ws_handler(websocket):
    connected_clients.add(websocket)
    print(f"[FRONTEND] Connected. Clients: {len(connected_clients)}", flush=True)

    try:
        await websocket.wait_closed()
    finally:
        connected_clients.discard(websocket)
        print(f"[FRONTEND] Disconnected. Clients: {len(connected_clients)}", flush=True)


async def broadcast_loop():
    """
    从 line_queue 取数据并广播给所有前端。

    稳定性修复：
    1. 遍历 connected_clients 时使用 list() 快照，避免 set 变化导致 RuntimeError；
    2. 每次最多发送 MAX_LINES_PER_SEND 行，避免 WebSocket 被高频 RTT 打爆；
    3. 使用 SEND_INTERVAL_S 固定节奏发送，避免每帧都触发 WebSocket；
    4. 客户端断开时统一从 connected_clients 移除。
    """
    while True:
        lines = []

        try:
            while len(lines) < MAX_LINES_PER_SEND:
                lines.append(line_queue.get_nowait())
        except queue.Empty:
            pass

        if lines and connected_clients:
            payload = "\n".join(lines)

            dead_clients = set()

            # 关键：使用 list() 快照，避免 RuntimeError: Set changed size during iteration
            for ws in list(connected_clients):
                try:
                    await ws.send(payload)
                except Exception:
                    dead_clients.add(ws)

            for ws in dead_clients:
                connected_clients.discard(ws)

        await asyncio.sleep(SEND_INTERVAL_S)


async def main_async():
    print(f"[START] WebSocket server started: ws://{WS_HOST}:{WS_PORT}", flush=True)

    async with websockets.serve(ws_handler, WS_HOST, WS_PORT):
        await broadcast_loop()


# ============================================================
# 主入口
# ============================================================

def main():
    print("============================================================", flush=True)
    print(" J-Link RTT Binary Frame RuntimeOnce WebSocket Backend", flush=True)
    print("============================================================", flush=True)
    print("", flush=True)

    # 1. 清理旧的 WebSocket 端口占用
    if AUTO_KILL_OLD_WS_PORT:
        kill_process_on_port(WS_PORT)

    # 2. 清理旧 GDBServer
    kill_old_gdbserver()

    # 3. 启动 GDBServer
    start_jlink_gdbserver()

    # 4. GDBServer 启动后，通过 2331 端口发送 halt/reset/go
    reset_go_via_gdbserver()

    # 5. 启动 RTT 读取线程
    t = threading.Thread(target=rtt_reader_thread, daemon=True)
    t.start()

    # 6. 启动 WebSocket
    try:
        asyncio.run(main_async())
    except KeyboardInterrupt:
        print("", flush=True)
        print("Ctrl+C received. Exit ...", flush=True)
    finally:
        cleanup()


if __name__ == "__main__":
    main()
