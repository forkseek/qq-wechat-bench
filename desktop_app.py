"""讯课桌面壳：pywebview 主窗口 + 可置顶迷你待办小窗 + 系统托盘图标。"""
from __future__ import annotations

import argparse
import ctypes
import http.cookiejar
import json
import os
import secrets
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
import pystray
import webview

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
CONTROL_FILE = DATA_DIR / "desktop-control.json"
ICON_FILE = DATA_DIR / "xunke-app.ico"


def load_runtime() -> dict:
    """复用仓库统一的 runtime-config.mjs 读取端口和地址。"""
    try:
        out = subprocess.check_output(
            ["node", str(ROOT / "scripts" / "runtime-config.mjs"), str(ROOT)],
            cwd=str(ROOT),
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            text=True,
            encoding="utf-8",
            timeout=10,
        )
        return json.loads(out)
    except Exception:
        return {"app": "qq-school-workbench", "port": 4318, "url": "http://127.0.0.1:4318"}


def server_healthy(base_url: str, expected_app: str) -> bool:
    try:
        with urllib.request.urlopen(f"{base_url}/api/health", timeout=2) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return bool(data.get("ok")) and data.get("app") == expected_app
    except Exception:
        return False


def ensure_backend(runtime: dict) -> bool:
    base_url = runtime["url"]
    app_name = runtime.get("app", "qq-school-workbench")
    if server_healthy(base_url, app_name):
        return True
    subprocess.Popen(
        [
            "powershell.exe",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-WindowStyle",
            "Hidden",
            "-File",
            str(ROOT / "start.ps1"),
            "-NoBrowser",
        ],
        cwd=str(ROOT),
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    deadline = time.time() + 20
    while time.time() < deadline:
        if server_healthy(base_url, app_name):
            return True
        time.sleep(0.35)
    return False


def stop_backend() -> None:
    try:
        subprocess.run(
            [
                "powershell.exe",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-WindowStyle",
                "Hidden",
                "-File",
                str(ROOT / "start.ps1"),
                "-Stop",
            ],
            cwd=str(ROOT),
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=15,
        )
    except Exception:
        pass


def make_seal_image(size: int = 64) -> Image.Image:
    """绘制松柏底 + 朱砂印章「讯」图标，用于系统托盘和 .ico。"""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    pad = max(2, size // 16)
    radius = max(6, size // 5)
    # 墨绿底
    draw.rounded_rectangle([pad, pad, size - pad, size - pad], radius=radius, fill=(23, 50, 39, 255))
    # 内嵌朱砂印章
    inner = max(6, size // 7)
    draw.rounded_rectangle(
        [inner, inner, size - inner, size - inner],
        radius=max(4, size // 9),
        fill=(184, 59, 40, 255),
        outline=(247, 240, 230, 140),
        width=max(1, size // 32),
    )
    font = None
    for candidate in (
        "C:/Windows/Fonts/simkai.ttf",
        "C:/Windows/Fonts/msyhbd.ttc",
        "C:/Windows/Fonts/msyh.ttc",
    ):
        if Path(candidate).is_file():
            try:
                font = ImageFont.truetype(candidate, int(size * 0.48))
                break
            except Exception:
                pass
    if font is not None:
        bbox = draw.textbbox((0, 0), "讯", font=font)
        tw = bbox[2] - bbox[0]
        th = bbox[3] - bbox[1]
        tx = (size - tw) / 2 - bbox[0]
        ty = (size - th) / 2 - bbox[1]
        draw.text((tx, ty), "讯", font=font, fill=(253, 248, 242, 255))
    else:
        c = size // 2
        r = size // 6
        draw.rectangle([c - r, c - r, c + r, c + r], outline=(253, 248, 242, 255), width=max(2, size // 16))
    return img


def ensure_ico_file() -> Path:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not ICON_FILE.exists():
        img = make_seal_image(256)
        img.save(ICON_FILE, format="ICO", sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    return ICON_FILE


def send_control_command(cmd: str) -> bool:
    """尝试向已运行的桌面壳实例发送控制指令；成功表示已有实例在运行。"""
    if not CONTROL_FILE.exists():
        return False
    try:
        info = json.loads(CONTROL_FILE.read_text(encoding="utf-8"))
        port = int(info["port"])
        token = str(info["token"])
        with socket.create_connection(("127.0.0.1", port), timeout=1.2) as sock:
            sock.sendall((json.dumps({"token": token, "cmd": cmd}) + "\n").encode("utf-8"))
            reply = sock.recv(64).decode("utf-8", errors="ignore").strip()
            return reply == "OK"
    except Exception:
        return False


def get_screen_size() -> tuple[int, int]:
    try:
        user32 = ctypes.windll.user32
        return int(user32.GetSystemMetrics(0)), int(user32.GetSystemMetrics(1))
    except Exception:
        return 1366, 768


class WorkbenchApiClient:
    """托盘菜单调用本机工作台接口（带 cookie 会话与 Origin）。"""

    def __init__(self, base_url: str):
        self.base_url = base_url
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))

    def _ensure_session(self) -> None:
        if not list(self.jar):
            self.opener.open(self.base_url + "/", timeout=4).read()

    def request(self, route: str, method: str = "GET", body: dict | None = None) -> dict:
        self._ensure_session()
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(
            self.base_url + route,
            data=data,
            method=method,
            headers={
                "Origin": self.base_url,
                **({"Content-Type": "application/json"} if data is not None else {}),
            },
        )
        try:
            with self.opener.open(req, timeout=8) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as err:
            if err.code == 403:
                self.jar.clear()
                self._ensure_session()
                with self.opener.open(req, timeout=8) as resp:
                    return json.loads(resp.read().decode("utf-8"))
            raise


class DesktopShell:
    def __init__(self, runtime: dict, start_mode: str):
        self.runtime = runtime
        self.base_url = runtime["url"]
        self.start_mode = start_mode  # 'main' | 'widget' | 'background'
        self.client = WorkbenchApiClient(self.base_url)
        self.main_window = None
        self.widget_window = None
        self.widget_visible = start_mode == "widget"
        self.quitting = False
        self.tray = None
        self.control_socket = None
        self.control_token = secrets.token_hex(24)

    # ---- JS Bridge Methods (exposed via window.pywebview.api) ----
    def show_main(self):
        if self.main_window:
            try:
                self.main_window.show()
                self.main_window.restore()
            except Exception:
                pass
        return True

    def hide_main(self):
        if self.main_window:
            try:
                self.main_window.hide()
            except Exception:
                pass
        return True

    def show_widget(self):
        if self.widget_window:
            try:
                self.widget_window.show()
                self.widget_window.restore()
                self.widget_visible = True
            except Exception:
                pass
        return True

    def hide_widget(self):
        if self.widget_window:
            try:
                self.widget_window.hide()
                self.widget_visible = False
            except Exception:
                pass
        return True

    def toggle_widget(self):
        if self.widget_visible:
            return self.hide_widget()
        return self.show_widget()

    def set_widget_on_top(self, value: bool):
        if self.widget_window:
            try:
                self.widget_window.on_top = bool(value)
            except Exception:
                pass
        return bool(value)

    # ---- Window Close Interceptors ----
    def _on_main_closing(self):
        if self.quitting:
            return True
        self.hide_main()
        return False

    def _on_widget_closing(self):
        if self.quitting:
            return True
        self.hide_widget()
        return False

    # ---- Single-instance local control listener ----
    def _start_control_server(self):
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.bind(("127.0.0.1", 0))
        srv.listen(5)
        port = srv.getsockname()[1]
        self.control_socket = srv
        CONTROL_FILE.write_text(
            json.dumps({"port": port, "token": self.control_token, "pid": os.getpid()}),
            encoding="utf-8",
        )

        def serve():
            while not self.quitting:
                try:
                    srv.settimeout(1.0)
                    conn, _ = srv.accept()
                except socket.timeout:
                    continue
                except OSError:
                    break
                with conn:
                    try:
                        raw = conn.recv(1024).decode("utf-8", errors="ignore").strip()
                        msg = json.loads(raw)
                        if msg.get("token") != self.control_token:
                            conn.sendall(b"DENY\n")
                            continue
                        cmd = msg.get("cmd")
                        if cmd == "show_main":
                            self.show_main()
                        elif cmd == "show_widget":
                            self.show_widget()
                        elif cmd == "toggle_widget":
                            self.toggle_widget()
                        elif cmd == "quit":
                            threading.Thread(target=self.quit_app, daemon=True).start()
                        conn.sendall(b"OK\n")
                    except Exception:
                        pass

        threading.Thread(target=serve, daemon=True).start()

    # ---- System Tray ----
    def _toggle_qq_capture(self):
        try:
            qq = self.client.request("/api/qq/status")
            if qq.get("keepRunning"):
                self.client.request("/api/qq/stop", "POST", {})
            else:
                self.client.request("/api/qq/start", "POST", {})
        except Exception:
            # 例如桌面 QQ 冲突时，打开主窗口让用户查看明确原因
            self.show_main()

    def _start_tray(self):
        icon_img = make_seal_image(64)
        menu = pystray.Menu(
            pystray.MenuItem("打开讯课主工作台", lambda icon, item: self.show_main(), default=True),
            pystray.MenuItem("显示 / 隐藏迷你待办", lambda icon, item: self.toggle_widget()),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("开启 / 停止 QQ 采集", lambda icon, item: threading.Thread(target=self._toggle_qq_capture, daemon=True).start()),
            pystray.MenuItem("在浏览器中打开", lambda icon, item: webbrowser.open(self.base_url)),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("退出讯课工作台", lambda icon, item: threading.Thread(target=self.quit_app, daemon=True).start()),
        )
        self.tray = pystray.Icon("xunke-workbench", icon_img, "讯课 · QQ 与微信工作台", menu)
        threading.Thread(target=self.tray.run, daemon=True).start()

    def quit_app(self):
        if self.quitting:
            return
        self.quitting = True
        try:
            if self.control_socket:
                self.control_socket.close()
        except Exception:
            pass
        try:
            CONTROL_FILE.unlink(missing_ok=True)
        except Exception:
            pass
        try:
            if self.tray:
                self.tray.stop()
        except Exception:
            pass
        for win in (self.widget_window, self.main_window):
            if win:
                try:
                    win.destroy()
                except Exception:
                    pass
        stop_backend()

    def run(self):
        ensure_ico_file()
        self._start_control_server()
        sw, sh = get_screen_size()
        main_w = min(1240, max(920, sw - 90))
        main_h = min(780, max(600, sh - 100))
        widget_w, widget_h = 336, 490
        widget_x = max(20, sw - widget_w - 28)
        widget_y = max(20, sh - widget_h - 72)

        self.main_window = webview.create_window(
            "讯课 · QQ 与微信工作台",
            url=self.base_url + "/",
            js_api=self,
            width=main_w,
            height=main_h,
            min_size=(820, 560),
            hidden=(self.start_mode != "main"),
            background_color="#F7F4ED",
        )
        self.widget_window = webview.create_window(
            "讯课 · 今日待办",
            url=self.base_url + "/widget",
            js_api=self,
            width=widget_w,
            height=widget_h,
            x=widget_x,
            y=widget_y,
            min_size=(290, 360),
            on_top=True,
            hidden=(self.start_mode != "widget"),
            background_color="#F7F4ED",
        )
        self.main_window.events.closing += self._on_main_closing
        self.widget_window.events.closing += self._on_widget_closing

        def on_started():
            self._start_tray()

        webview.start(on_started, gui="edgechromium", icon=str(ICON_FILE))


def main() -> int:
    parser = argparse.ArgumentParser(description="讯课工作台桌面外壳")
    parser.add_argument("--widget", action="store_true", help="打开迷你待办小窗")
    parser.add_argument("--background", action="store_true", help="后台启动到系统托盘（开机自启使用）")
    parser.add_argument("--quit", action="store_true", help="退出运行中的桌面壳与服务")
    parser.add_argument("--prepare-icon", action="store_true", help="仅生成桌面图标 .ico 后退出")
    args = parser.parse_args()

    if args.prepare_icon:
        ico = ensure_ico_file()
        print(str(ico))
        return 0

    if args.quit:
        if not send_control_command("quit"):
            stop_backend()
        return 0

    # 如果桌面壳已在运行，直接唤醒对应窗口，不重复启动第二个托盘。
    if not args.background:
        if send_control_command("show_widget" if args.widget else "show_main"):
            return 0
    else:
        if send_control_command("noop"):
            return 0

    runtime = load_runtime()
    if not ensure_backend(runtime):
        return 1

    mode = "widget" if args.widget else "background" if args.background else "main"
    shell = DesktopShell(runtime, mode)
    shell.run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
