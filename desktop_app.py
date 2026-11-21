"""讯课桌面壳：pywebview 主窗口 + 可置顶迷你待办小窗 + 系统托盘图标。"""
from __future__ import annotations

import argparse
import ctypes
import http.cookiejar
import json
import os
import re
import secrets
import socket
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
CONTROL_FILE = DATA_DIR / "desktop-control.json"
ICON_FILE = DATA_DIR / "xunke-app.ico"
WEBVIEW_PROFILE_DIR = DATA_DIR / "webview-profile"
ERROR_LOG_FILE = DATA_DIR / "desktop-error.log"
MUTEX_NAME = "Local\\XunkeWorkbenchDesktopShellMutex"
ERROR_ALREADY_EXISTS = 183

SWP_NOSIZE = 0x0001
SWP_NOMOVE = 0x0002
SWP_NOACTIVATE = 0x0010
SWP_SHOWWINDOW = 0x0040
HWND_TOPMOST = -1
HWND_NOTOPMOST = -2

_MUTEX_HANDLE = None


def log_error(context: str, err: BaseException | None = None) -> None:
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y-%m-%d %H:%M:%S")
        detail = "".join(traceback.format_exception(err)) if err else traceback.format_exc()
        with ERROR_LOG_FILE.open("a", encoding="utf-8") as fh:
            fh.write(f"[{stamp}] {context}\n{detail}\n")
    except Exception:
        pass


def acquire_single_instance_mutex() -> bool:
    """获取 Windows 命名互斥体，确保启动过程中绝不会并发拉起多个桌面壳进程。"""
    global _MUTEX_HANDLE
    if os.name != "nt":
        return True
    try:
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.CreateMutexW(None, True, MUTEX_NAME)
        last_err = kernel32.GetLastError()
        _MUTEX_HANDLE = handle
        return last_err != ERROR_ALREADY_EXISTS
    except Exception:
        return True


def load_runtime() -> dict:
    """优先直接读取 workbench.json 与 .env（<1ms），异常时回退 node runtime-config.mjs。"""
    try:
        cfg_file = ROOT / "config" / "workbench.json"
        pkg_file = ROOT / "package.json"
        env_file = ROOT / ".env"
        cfg = json.loads(cfg_file.read_text(encoding="utf-8-sig"))
        pkg = json.loads(pkg_file.read_text(encoding="utf-8-sig"))
        port = int(cfg["server"]["port"])
        if env_file.is_file():
            for line in env_file.read_text(encoding="utf-8-sig").splitlines():
                m = re.match(r"^\s*PORT\s*=\s*['\"]?(\d+)['\"]?\s*$", line)
                if m:
                    port = int(m.group(1))
        if "PORT" in os.environ and os.environ["PORT"].isdigit():
            port = int(os.environ["PORT"])
        return {
            "app": pkg.get("name", "qq-school-workbench"),
            "version": pkg.get("version", "0.5.2"),
            "port": port,
            "url": f"http://127.0.0.1:{port}",
        }
    except Exception:
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
        time.sleep(0.25)
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


def make_seal_image(size: int = 64):
    """绘制松柏底 + 朱砂印章「讯」图标，用于系统托盘和 .ico。"""
    from PIL import Image, ImageDraw, ImageFont

    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    pad = max(2, size // 16)
    radius = max(6, size // 5)
    draw.rounded_rectangle([pad, pad, size - pad, size - pad], radius=radius, fill=(23, 50, 39, 255))
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


def _is_pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name != "nt":
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    STILL_ACTIVE = 259
    kernel32 = ctypes.windll.kernel32
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
    if not handle:
        return False
    try:
        code = ctypes.c_ulong()
        if kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
            return code.value == STILL_ACTIVE
        return False
    finally:
        kernel32.CloseHandle(handle)


def _cleanup_stale_pid(stale_pid: int) -> None:
    if stale_pid <= 0 or stale_pid == os.getpid() or not _is_pid_alive(stale_pid):
        return
    try:
        subprocess.run(
            ["taskkill", "/F", "/PID", str(stale_pid)],
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=3,
        )
    except Exception:
        pass


def send_control_command(cmd: str, cleanup_on_fail: bool = True) -> bool:
    """尝试向已运行的桌面壳实例发送控制指令。"""
    if not CONTROL_FILE.exists():
        return False
    stale_pid = 0
    try:
        info = json.loads(CONTROL_FILE.read_text(encoding="utf-8"))
        port = int(info["port"])
        token = str(info["token"])
        stale_pid = int(info.get("pid") or 0)
        if stale_pid and not _is_pid_alive(stale_pid):
            CONTROL_FILE.unlink(missing_ok=True)
            return False
        with socket.create_connection(("127.0.0.1", port), timeout=0.6) as sock:
            sock.sendall((json.dumps({"token": token, "cmd": cmd}) + "\n").encode("utf-8"))
            reply = sock.recv(64).decode("utf-8", errors="ignore").strip()
            if reply == "OK":
                return True
    except Exception:
        pass
    if cleanup_on_fail:
        if stale_pid:
            _cleanup_stale_pid(stale_pid)
        try:
            CONTROL_FILE.unlink(missing_ok=True)
        except Exception:
            pass
    return False


def get_screen_size() -> tuple[int, int]:
    try:
        user32 = ctypes.windll.user32
        return int(user32.GetSystemMetrics(0)), int(user32.GetSystemMetrics(1))
    except Exception:
        return 1366, 768


def _get_hwnd(win) -> int:
    try:
        if win and getattr(win, "native", None) is not None:
            return int(win.native.Handle.ToInt32())
    except Exception:
        pass
    return 0


def _set_hwnd_topmost(hwnd: int, on_top: bool) -> None:
    if not hwnd or os.name != "nt":
        return
    try:
        ctypes.windll.user32.SetWindowPos(
            hwnd,
            HWND_TOPMOST if on_top else HWND_NOTOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        )
    except Exception:
        pass


def _bring_hwnd_to_front(hwnd: int, keep_topmost: bool = False) -> None:
    if not hwnd or os.name != "nt":
        return
    try:
        user32 = ctypes.windll.user32
        user32.SetWindowPos(
            hwnd,
            HWND_TOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
        )
        if not keep_topmost:
            user32.SetWindowPos(
                hwnd,
                HWND_NOTOPMOST,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
            )
        user32.SetForegroundWindow(hwnd)
    except Exception:
        pass


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


class JsBridge:
    """仅暴露给前端 window.pywebview.api 的轻量对象。
    注意：内部引用必须以 _ 开头，防止 pywebview 递归反射 WinForms 窗口对象导致无限递归卡死。
    """

    def __init__(self, shell: "DesktopShell"):
        self._shell = shell

    def show_main(self) -> bool:
        return self._shell.show_main()

    def hide_main(self) -> bool:
        return self._shell.hide_main()

    def show_widget(self) -> bool:
        return self._shell.show_widget()

    def hide_widget(self) -> bool:
        return self._shell.hide_widget()

    def toggle_widget(self) -> bool:
        return self._shell.toggle_widget()

    def set_widget_on_top(self, value: bool) -> bool:
        return self._shell.set_widget_on_top(value)


class DesktopShell:
    def __init__(self, runtime: dict, start_mode: str):
        self.runtime = runtime
        self.base_url = runtime["url"]
        self.start_mode = start_mode  # 'main' | 'widget' | 'background'
        self.client = WorkbenchApiClient(self.base_url)
        self.bridge = JsBridge(self)
        self.main_window = None
        self.widget_window = None
        self.widget_visible = start_mode == "widget"
        self.widget_on_top = True
        self.quitting = False
        self.tray = None
        self.control_socket = None
        self.control_token = secrets.token_hex(24)

    def show_main(self) -> bool:
        if self.main_window:
            try:
                self.main_window.show()
                self.main_window.restore()
                _bring_hwnd_to_front(_get_hwnd(self.main_window), keep_topmost=False)
            except Exception as err:
                log_error("show_main", err)
        return True

    def hide_main(self) -> bool:
        if self.main_window:
            try:
                self.main_window.hide()
            except Exception as err:
                log_error("hide_main", err)
        return True

    def show_widget(self) -> bool:
        if self.widget_window:
            try:
                self.widget_window.show()
                self.widget_window.restore()
                self.widget_visible = True
                _bring_hwnd_to_front(_get_hwnd(self.widget_window), keep_topmost=self.widget_on_top)
            except Exception as err:
                log_error("show_widget", err)
        return True

    def hide_widget(self) -> bool:
        if self.widget_window:
            try:
                self.widget_window.hide()
                self.widget_visible = False
            except Exception as err:
                log_error("hide_widget", err)
        return True

    def toggle_widget(self) -> bool:
        if self.widget_visible:
            return self.hide_widget()
        return self.show_widget()

    def set_widget_on_top(self, value: bool) -> bool:
        self.widget_on_top = bool(value)
        if self.widget_window:
            _set_hwnd_topmost(_get_hwnd(self.widget_window), self.widget_on_top)
        return self.widget_on_top

    # ---- Window Close Interceptors ----
    def _on_main_closing(self):
        if self.quitting:
            return True
        threading.Thread(target=self.hide_main, daemon=True).start()
        return False

    def _on_widget_closing(self):
        if self.quitting:
            return True
        threading.Thread(target=self.hide_widget, daemon=True).start()
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
                        conn.sendall(b"OK\n")
                        if cmd == "show_main":
                            threading.Thread(target=self.show_main, daemon=True).start()
                        elif cmd == "show_widget":
                            threading.Thread(target=self.show_widget, daemon=True).start()
                        elif cmd == "toggle_widget":
                            threading.Thread(target=self.toggle_widget, daemon=True).start()
                        elif cmd == "quit":
                            threading.Thread(target=self.quit_app, daemon=True).start()
                    except Exception as err:
                        log_error("control_server", err)

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
            self.show_main()

    def _start_tray(self):
        import pystray

        icon_img = make_seal_image(64)
        menu = pystray.Menu(
            pystray.MenuItem("打开讯课主工作台", lambda icon, item: threading.Thread(target=self.show_main, daemon=True).start(), default=True),
            pystray.MenuItem("显示 / 隐藏迷你待办", lambda icon, item: threading.Thread(target=self.toggle_widget, daemon=True).start()),
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
        import webview

        ensure_ico_file()
        WEBVIEW_PROFILE_DIR.mkdir(parents=True, exist_ok=True)
        if not self.control_socket:
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
            js_api=self.bridge,
            width=main_w,
            height=main_h,
            min_size=(820, 560),
            hidden=(self.start_mode != "main"),
            background_color="#F7F4ED",
        )
        self.widget_window = webview.create_window(
            "讯课 · 今日待办",
            url=self.base_url + "/widget",
            js_api=self.bridge,
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
            if self.start_mode == "main":
                _bring_hwnd_to_front(_get_hwnd(self.main_window), keep_topmost=False)
            elif self.start_mode == "widget":
                _bring_hwnd_to_front(_get_hwnd(self.widget_window), keep_topmost=True)

        webview.start(
            on_started,
            gui="edgechromium",
            icon=str(ICON_FILE),
            private_mode=False,
            storage_path=str(WEBVIEW_PROFILE_DIR),
        )


def main() -> int:
    parser = argparse.ArgumentParser(description="讯课工作台桌面外壳")
    parser.add_argument("--widget", action="store_true", help="打开迷你待办小窗")
    parser.add_argument("--background", action="store_true", help="后台启动到系统托盘（开机自启使用）")
    parser.add_argument("--quit", action="store_true", help="退出运行中的桌面壳与服务")
    parser.add_argument("--prepare-icon", action="store_true", help="仅生成桌面图标 .ico 后退出")
    args = parser.parse_args()

    try:
        if args.prepare_icon:
            ico = ensure_ico_file()
            print(str(ico))
            return 0

        if args.quit:
            if not send_control_command("quit"):
                stop_backend()
            return 0

        target_cmd = "noop" if args.background else ("show_widget" if args.widget else "show_main")

        # 1. 通过 Windows 命名互斥体防止启动期间连点拉起多个进程
        if not acquire_single_instance_mutex():
            deadline = time.time() + 8.0
            while time.time() < deadline:
                if send_control_command(target_cmd, cleanup_on_fail=False):
                    return 0
                time.sleep(0.2)
            return 0

        # 2. 已持有唯一实例互斥体，若仍有旧实例或残留 control 文件则唤醒或清理
        if send_control_command(target_cmd, cleanup_on_fail=True):
            return 0

        runtime = load_runtime()
        mode = "widget" if args.widget else "background" if args.background else "main"
        shell = DesktopShell(runtime, mode)
        shell._start_control_server()

        if not ensure_backend(runtime):
            log_error("ensure_backend failed")
            return 1

        shell.run()
        return 0
    except Exception as err:
        log_error("main", err)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
