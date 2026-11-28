"""讯课桌面壳：pywebview 主窗口 + 可置顶迷你待办小窗 + 系统托盘图标。"""
from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes
import http.cookiejar
import json
import os
import re
import secrets
import shutil
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
PET_STATE_FILE = DATA_DIR / "pet-state.json"
ICON_FILE = DATA_DIR / "xunke-app.ico"
PET_WIDTH = 240
PET_HEIGHT = 440  # 角色在中间，上下各留一块透明空位放气泡 / 菜单（贴屏幕顶时翻到下方）
WEBVIEW_PROFILE_DIR = DATA_DIR / "webview-profile"
ERROR_LOG_FILE = DATA_DIR / "desktop-error.log"
STDOUT_LOG_FILE = DATA_DIR / "desktop-runtime.log"
RESTART_LOG_FILE = DATA_DIR / "backend-restarts.log"
# start.ps1 -Stop 会留下这个标记：用户自己关的后台，看护不要再拉起来。
STOPPED_FLAG = DATA_DIR / "backend-stopped.flag"
ERROR_ALREADY_EXISTS = 183

SWP_NOSIZE = 0x0001
SWP_NOMOVE = 0x0002
SWP_NOACTIVATE = 0x0010
SWP_SHOWWINDOW = 0x0040
HWND_TOPMOST = -1
HWND_NOTOPMOST = -2

_MUTEX_HANDLE = None


def _ensure_stdio() -> None:
    """pythonw.exe 下 sys.stdout / sys.stderr 为 None，重定向到日志文件避免第三方库 print 报错。"""
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        if sys.stdout is None or sys.stderr is None:
            fh = STDOUT_LOG_FILE.open("a", encoding="utf-8", buffering=1)
            if sys.stdout is None:
                sys.stdout = fh
            if sys.stderr is None:
                sys.stderr = fh
    except Exception:
        pass




def log_error(context: str, err: BaseException | None = None) -> None:
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y-%m-%d %H:%M:%S")
        detail = "".join(traceback.format_exception(err)) if err else traceback.format_exc()
        with ERROR_LOG_FILE.open("a", encoding="utf-8") as fh:
            fh.write(f"[{stamp}] {context}\n{detail}\n")
    except Exception:
        pass


def get_desktop_name() -> str:
    """获取当前线程所在的 Win32 桌面名称（例如真实桌面为 'Default'）。"""
    if os.name != "nt":
        return "default"
    try:
        user32 = ctypes.windll.user32
        kernel32 = ctypes.windll.kernel32
        user32.GetThreadDesktop.restype = wintypes.HANDLE
        user32.GetUserObjectInformationW.argtypes = [wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
        h_desk = user32.GetThreadDesktop(kernel32.GetCurrentThreadId())
        if not h_desk:
            return "default"
        buf = ctypes.create_unicode_buffer(256)
        needed = ctypes.c_ulong()
        if user32.GetUserObjectInformationW(h_desk, 2, buf, 512, ctypes.byref(needed)):
            raw = buf.value.strip()
            return re.sub(r"[^A-Za-z0-9_.-]", "_", raw) or "default"
    except Exception:
        pass
    return "default"


def acquire_single_instance_mutex() -> bool:
    """获取当前 Win32 桌面对应的命名互斥体，防止连点启动多个窗口，且不与后台测试沙箱互相阻塞。"""
    global _MUTEX_HANDLE
    if os.name != "nt":
        return True
    mutex_name = f"Local\\XunkeWorkbenchDesktopShellMutex_{get_desktop_name()}"
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateMutexW.argtypes = [wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR]
    kernel.CreateMutexW.restype = wintypes.HANDLE
    handle = kernel.CreateMutexW(None, False, mutex_name)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    if ctypes.get_last_error() == ERROR_ALREADY_EXISTS:
        kernel.CloseHandle(wintypes.HANDLE(handle))
        return False
    _MUTEX_HANDLE = handle
    return True


def control_path() -> Path:
    session = wintypes.DWORD()
    if os.name == "nt" and not ctypes.windll.kernel32.ProcessIdToSessionId(os.getpid(), ctypes.byref(session)):
        raise ctypes.WinError()
    return CONTROL_FILE.with_name(f"desktop-control-{session.value}-{get_desktop_name()}.json")


def _find_node_exe() -> str:
    # 发给别人的免安装包会把 node.exe 放在 runtime\node 里，优先用它
    bundled = ROOT / "runtime" / "node" / "node.exe"
    if bundled.is_file():
        return str(bundled)
    found = shutil.which("node") or shutil.which("node.exe")
    if found:
        return found
    for candidate in (
        r"C:\Program Files\nodejs\node.exe",
        r"C:\Program Files (x86)\nodejs\node.exe",
    ):
        if Path(candidate).is_file():
            return candidate
    return "node"


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
                [_find_node_exe(), str(ROOT / "scripts" / "runtime-config.mjs"), str(ROOT)],
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
        with urllib.request.urlopen(f"{base_url}/api/health", timeout=1.5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return bool(data.get("ok")) and data.get("app") == expected_app
    except Exception:
        return False


def port_open(port: int) -> bool:
    """端口有没有人在听。忙不过来和真的没在跑要分开：只有连不上才算停了。"""
    try:
        # Windows 会重试几次，约 2 秒后才报“拒绝连接”，超时要比它长。
        with socket.create_connection(("127.0.0.1", port), timeout=5):
            return True
    except ConnectionRefusedError:
        return False
    except OSError:
        # 超时等情况说不准，按“还在”处理，不贸然再启动一份。
        return True


def log_restart(message: str) -> None:
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        with RESTART_LOG_FILE.open("a", encoding="utf-8") as fh:
            fh.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {message}\n")
    except Exception:
        pass


def _spawn_backend() -> subprocess.Popen:
    out_log = (DATA_DIR / "runtime.log").open("a", encoding="utf-8")
    err_log = (DATA_DIR / "runtime-error.log").open("a", encoding="utf-8")
    args = [_find_node_exe(), f"--env-file-if-exists={ROOT / '.env'}", str(ROOT / "server.mjs")]
    options = {"cwd": str(ROOT), "stdin": subprocess.DEVNULL, "stdout": out_log, "stderr": err_log}
    try:
        if os.name == "nt":
            base = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP
            try:
                # 脱离启动者的作业组：从别的工具里打开讯课时，那个工具关掉不会把后台一起带走。
                return subprocess.Popen(args, creationflags=base | subprocess.CREATE_BREAKAWAY_FROM_JOB, **options)
            except OSError:
                return subprocess.Popen(args, creationflags=base, **options)
        return subprocess.Popen(args, **options)
    finally:
        out_log.close()
        err_log.close()


_ENSURE_LOCK = threading.Lock()


def backend_pid(base_url: str) -> int:
    try:
        with urllib.request.urlopen(f"{base_url}/api/health", timeout=1.5) as resp:
            return int(json.loads(resp.read().decode("utf-8")).get("pid") or 0)
    except Exception:
        return 0


def ensure_backend(runtime: dict) -> bool:
    with _ENSURE_LOCK:
        return _ensure_backend(runtime)


def _ensure_backend(runtime: dict) -> bool:
    base_url = runtime["url"]
    app_name = runtime.get("app", "qq-school-workbench")
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    try:
        STOPPED_FLAG.unlink(missing_ok=True)
    except OSError:
        pass
    if server_healthy(base_url, app_name):
        return True
    proc = None
    try:
        proc = _spawn_backend()
        (DATA_DIR / "runtime.pid").write_text(str(proc.pid), encoding="ascii")
    except Exception as err:
        log_error("spawn node backend failed, falling back to start.ps1", err)
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
    deadline = time.time() + 18
    while time.time() < deadline:
        if server_healthy(base_url, app_name):
            return True
        if proc is not None and proc.poll() is not None:
            log_restart(f"后台启动后马上退出，退出码 {proc.returncode}，原因见 runtime-error.log")
            return False
        time.sleep(0.2)
    return False


class BackendGuard:
    """看护后台：确认停了就自动拉起；连续失败就歇手，等用户点“现在重启”。"""

    INTERVAL = 5.0
    WAITS = (0, 10, 30, 60, 120)
    WINDOW = 900.0

    def __init__(self, runtime: dict, ensure=ensure_backend, on_replaced=None):
        self.runtime = runtime
        self.on_replaced = on_replaced  # 后台换了一份时调用，返回 True 表示页面都已刷新
        self._pid = 0
        self._reload_due = False
        self.ensure = ensure
        self.state = "ok"  # ok | restarting | stopped | failed
        self._misses = 0
        self._attempts: list[float] = []
        self._next_at = 0.0
        self._manual = False
        self._wake = threading.Event()
        self._stopping = threading.Event()
        self._thread = None
        self._restart_lock = threading.Lock()

    def start(self) -> None:
        if self._thread is None:
            self._thread = threading.Thread(target=self._loop, daemon=True)
            self._thread.start()

    def stop(self) -> None:
        self._stopping.set()
        self._wake.set()

        # 等正在执行的拉起操作结束，再由退出流程关闭后台。
        with self._restart_lock:
            pass

    def request_restart(self) -> None:
        """用户明确要求：忽略停止标记和歇手状态，马上检查一次。"""
        self._manual = True
        self._wake.set()

    def _is_down(self) -> bool:
        app = self.runtime.get("app", "qq-school-workbench")
        return not server_healthy(self.runtime["url"], app) and not port_open(int(self.runtime["port"]))

    def _loop(self) -> None:
        while not self._stopping.is_set():
            self._wake.wait(self.INTERVAL)
            self._wake.clear()
            if self._stopping.is_set():
                return
            try:
                self.tick()
            except Exception as err:
                log_error("backend guard", err)

    def _notice_replaced(self) -> None:
        pid = backend_pid(self.runtime["url"])
        if pid:
            if self._pid and pid != self._pid:
                self._reload_due = True
            self._pid = pid
        if self._reload_due and self.on_replaced is not None:
            self._reload_due = not self.on_replaced()

    def tick(self) -> None:
        manual, self._manual = self._manual, False
        if not self._is_down():
            self._misses = 0
            self.state = "ok"
            self._notice_replaced()
            return
        self._misses += 1
        # 连着两次都连不上才动手，躲开正常重启的空当。
        if not manual and self._misses < 2:
            return
        if not manual and STOPPED_FLAG.exists():
            self.state = "stopped"
            return
        now = time.time()
        if manual:
            self._attempts = []
        else:
            self._attempts = [at for at in self._attempts if now - at < self.WINDOW]
            if len(self._attempts) >= len(self.WAITS):
                if self.state != "failed":
                    log_restart(f"{int(self.WINDOW / 60)} 分钟内重启 {len(self._attempts)} 次都没稳住，先停手")
                self.state = "failed"
                return
            if now < self._next_at:
                return
        self._attempts.append(now)
        self.state = "restarting"
        log_restart("后台连不上，" + ("按用户要求重启" if manual else f"自动重启（第 {len(self._attempts)} 次）"))
        with self._restart_lock:
            if self._stopping.is_set():
                return
            ok = self.ensure(self.runtime)
        if self._stopping.is_set():
            return
        self._next_at = time.time() + self.WAITS[min(len(self._attempts), len(self.WAITS) - 1)]
        log_restart("后台已恢复" if ok else "这次没拉起来")
        if ok:
            self._misses = 0
            self.state = "ok"

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


# 图标版本：换图标时改这里，旧的 .ico 会被自动重画（快捷方式和开机自启都指向同一个文件名）
ICON_VERSION = "c-calendar-tick-1"
ICON_SIZES = (16, 24, 32, 48, 64, 128, 256)


def make_seal_image(size: int = 64):
    """手账风台历 + 绿色大勾（图标 C，和 assets/icon/xunke-icon.svg 一致），用于系统托盘和 .ico。

    按 256 的设计稿坐标画在 4 倍大画布上再缩小，边缘才不会有锯齿。
    """
    from PIL import Image, ImageDraw

    ink, page, rose, mint = (35, 33, 30, 255), (255, 253, 245, 255), (251, 113, 133, 255), (134, 239, 172, 255)
    big = size * 4
    k = big / 256

    def s(*v):
        return [round(n * k) for n in v]

    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    def stroke(points, width, color):
        pts = [tuple(s(x, y)) for x, y in points]
        w = max(1, round(width * k))
        d.line(pts, fill=color, width=w, joint="curve")
        r = w / 2
        for x, y in (pts[0], pts[-1]):
            d.ellipse([x - r, y - r, x + r, y + r], fill=color)

    # 右下实心墨影
    d.rounded_rectangle(s(34, 48, 230, 238), radius=round(30 * k), fill=ink)
    # 纸面
    d.rounded_rectangle(s(22, 36, 218, 226), radius=round(30 * k), fill=page)
    # 玫红页眉 + 分隔线
    d.rounded_rectangle(s(22, 36, 218, 92), radius=round(30 * k), fill=rose, corners=(True, True, False, False))
    d.rectangle(s(22, 85, 218, 99), fill=ink)
    # 外框（描边居中 14 → 往外扩 7）
    d.rounded_rectangle(s(15, 29, 225, 233), radius=round(37 * k), outline=ink, width=round(14 * k))
    # 两个装订环
    stroke([(80, 14), (80, 58)], 18, ink)
    stroke([(160, 14), (160, 58)], 18, ink)
    # 大勾：先粗墨边再荧光绿
    check = [(66, 154), (106, 192), (178, 116)]
    stroke(check, 34, ink)
    stroke(check, 18, mint)
    return img.resize((size, size), Image.LANCZOS)


def ensure_ico_file(force: bool = False) -> Path:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    ver_file = ICON_FILE.with_name(ICON_FILE.name + ".ver")
    try:
        current = ver_file.read_text(encoding="utf-8").strip()
    except Exception:
        current = ""
    if force or not ICON_FILE.exists() or current != ICON_VERSION:
        # 每个尺寸单独画（小尺寸直接按原尺寸缩，比从 256 一刀缩下来清楚）
        images = [make_seal_image(n) for n in ICON_SIZES]
        images[-1].save(ICON_FILE, format="ICO", sizes=[(n, n) for n in ICON_SIZES], append_images=images[:-1])
        ver_file.write_text(ICON_VERSION, encoding="utf-8")
        refresh_shell_icons()
    return ICON_FILE


def refresh_shell_icons() -> None:
    """让资源管理器重新读图标（桌面快捷方式换图标后不用重启电脑）。"""
    if os.name != "nt":
        return
    try:
        ctypes.windll.shell32.SHChangeNotify(0x08000000, 0, None, None)  # SHCNE_ASSOCCHANGED
    except Exception:
        pass


def send_control_command(cmd: str) -> bool:
    path = control_path()
    # 升级时仍能唤醒正在运行的旧版本；只有持有互斥体的实例可以发布新记录。
    if not path.exists():
        path = CONTROL_FILE
    try:
        info = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(info, dict) or info.get("desktop") != get_desktop_name():
            return False
        with socket.create_connection(("127.0.0.1", int(info["port"])), timeout=0.6) as sock:
            sock.sendall((json.dumps({"token": info["token"], "cmd": cmd}) + "\n").encode())
            with sock.makefile("rb") as stream:
                return stream.readline(64) == b"OK\n"
    except (OSError, ValueError, KeyError, TypeError, OverflowError):
        return False


def claim_or_notify(cmd: str, timeout: float = 40.0) -> str:
    deadline = time.monotonic() + timeout
    while True:
        if acquire_single_instance_mutex():
            return "owner"
        if send_control_command(cmd):
            return "delivered"
        if time.monotonic() >= deadline:
            return "unavailable"
        time.sleep(0.2)


def get_screen_size() -> tuple[int, int]:
    try:
        user32 = ctypes.windll.user32
        return int(user32.GetSystemMetrics(0)), int(user32.GetSystemMetrics(1))
    except Exception:
        return 1366, 768


def get_work_area() -> tuple[int, int, int, int]:
    """返回 Windows 主屏可用工作区 (left, top, right, bottom)，避开任务栏。"""
    sw, sh = get_screen_size()
    if os.name != "nt":
        return 0, 0, sw, max(200, sh - 48)
    try:
        rect = wintypes.RECT()
        if ctypes.windll.user32.SystemParametersInfoW(0x0030, 0, ctypes.byref(rect), 0):
            return int(rect.left), int(rect.top), int(rect.right), int(rect.bottom)
    except Exception:
        pass
    return 0, 0, sw, max(200, sh - 48)


def pet_work_area(x: int, y: int, w: int, h: int, hwnd: int = 0) -> tuple[int, int, int, int]:
    if os.name == "nt":
        from pet_touch import _SameDpiAs, _work_area_at
        with _SameDpiAs(hwnd):
            return _work_area_at(x + w / 2, y + h / 2)
    return get_work_area()


def _get_hwnd_rect(hwnd: int) -> tuple[int, int, int, int] | None:
    if not hwnd or os.name != "nt":
        return None
    try:
        from pet_touch import _SameDpiAs, _rect
        with _SameDpiAs(hwnd):
            return _rect(hwnd)
    except Exception:
        pass
    return None


def _move_hwnd(hwnd: int, x: int, y: int, on_top: bool) -> None:
    if not hwnd or os.name != "nt":
        return
    try:
        from pet_touch import _SameDpiAs
        with _SameDpiAs(hwnd):
            ctypes.windll.user32.SetWindowPos(hwnd, HWND_TOPMOST if on_top else HWND_NOTOPMOST,
                                               int(x), int(y), 0, 0, SWP_NOSIZE | SWP_NOACTIVATE)
    except Exception:
        pass


def _apply_pet_window_style(win, on_top: bool) -> None:
    """为桌宠 WinForms 窗口启用 TransparencyKey 透明抠图 + 隐藏任务栏图标 + 置顶状态。"""
    if not win or os.name != "nt":
        return
    try:
        form = getattr(win, "native", None)
        if form is None:
            return
        from System import Action
        from System.Drawing import Color

        key_color = Color.FromArgb(1, 2, 3)

        def configure():
            try:
                form.ShowInTaskbar = False
                form.BackColor = key_color
                form.TransparencyKey = key_color
                form.TopMost = bool(on_top)
                if getattr(form, "webview", None) is not None:
                    form.webview.DefaultBackgroundColor = Color.Transparent
            except Exception as err:
                log_error("configure_pet_form", err)

        if getattr(form, "InvokeRequired", False):
            form.Invoke(Action(configure))
        else:
            configure()

        hwnd = _get_hwnd(win)
        if hwnd:
            GWL_EXSTYLE = -20
            WS_EX_TOOLWINDOW = 0x00000080
            WS_EX_APPWINDOW = 0x00040000
            user32 = ctypes.windll.user32
            ex = user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
            user32.SetWindowLongW(hwnd, GWL_EXSTYLE, (ex | WS_EX_TOOLWINDOW) & ~WS_EX_APPWINDOW)
            _set_hwnd_topmost(hwnd, on_top)
    except Exception as err:
        log_error("apply_pet_window_style", err)


def load_pet_state() -> dict:
    wl, wt, wr, wb = get_work_area()
    default_x = max(wl + 16, wr - PET_WIDTH - 24)
    default_y = max(wt + 16, wb - PET_HEIGHT - 12)
    state = {"visible": True, "on_top": True, "x": default_x, "y": default_y}
    try:
        if PET_STATE_FILE.is_file():
            raw = json.loads(PET_STATE_FILE.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                if isinstance(raw.get("visible"), bool):
                    state["visible"] = raw["visible"]
                if isinstance(raw.get("on_top"), bool):
                    state["on_top"] = raw["on_top"]
                if all(isinstance(raw.get(k), (int, float)) for k in ("x", "y")):
                    wl, wt, wr, wb = pet_work_area(raw["x"], raw["y"], PET_WIDTH, PET_HEIGHT)
                if isinstance(raw.get("x"), (int, float)):
                    state["x"] = int(max(wl - 40, min(wr - 60, raw["x"])))
                if isinstance(raw.get("y"), (int, float)):
                    state["y"] = int(max(wt - 20, min(wb - 80, raw["y"])))
    except Exception:
        pass
    return state


def save_pet_state(state: dict) -> None:
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        PET_STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass


def _get_hwnd(win) -> int:
    try:
        form = getattr(win, "native", None)
        if form is None or form.IsDisposed or not form.IsHandleCreated:
            return 0
        from System import Func, IntPtr
        def read_handle():
            return form.Handle if form.IsHandleCreated and not form.IsDisposed else IntPtr.Zero
        handle = form.Invoke(Func[IntPtr](read_handle)) if form.InvokeRequired else read_handle()
        return int(handle.ToInt64())
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
        user32.ShowWindow(hwnd, 9)  # SW_RESTORE
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

    def show_pet(self) -> bool:
        return self._shell.show_pet()

    def hide_pet(self) -> bool:
        return self._shell.hide_pet()

    def toggle_pet(self) -> bool:
        return self._shell.toggle_pet()

    def set_pet_on_top(self, value: bool) -> bool:
        return self._shell.set_pet_on_top(value)

    def get_pet_state(self) -> dict:
        return self._shell.get_pet_state()

    def get_pet_bounds(self) -> dict:
        return self._shell.get_pet_bounds()

    def move_pet(self, x: int, y: int, persist: bool = False) -> bool:
        return self._shell.move_pet(x, y, persist)

    # ---- 桌宠触感层：页面上报可点区域、让身体走路 ----
    def set_pet_hotzones(self, zones: list, sprite: dict | None = None, ground: float | None = None) -> bool:
        touch = self._shell.touch
        if touch:
            touch.set_zones(zones, sprite, ground)
        return bool(touch)

    def pet_walk(self, dx: float, speed: float = 70) -> bool:
        touch = self._shell.touch
        return bool(touch and touch.walk(float(dx), float(speed)))

    def pet_stop(self) -> bool:
        touch = self._shell.touch
        if touch:
            touch.stop_motion()
        return True

    def backend_state(self) -> str:
        return self._shell.guard.state

    def restart_backend(self) -> bool:
        self._shell.guard.request_restart()
        return True


class DesktopShell:
    def __init__(self, runtime: dict, start_mode: str):
        self.runtime = runtime
        self.base_url = runtime["url"]
        self.start_mode = start_mode  # 'main' | 'widget' | 'background'
        self.client = WorkbenchApiClient(self.base_url)
        self.bridge = JsBridge(self)
        self.guard = BackendGuard(runtime, on_replaced=self._reload_pages)
        self.main_window = None
        self.widget_window = None
        self.pet_window = None
        self.widget_visible = start_mode == "widget"
        self.widget_on_top = True
        pet_state = load_pet_state()
        self.pet_visible = True if start_mode == "pet" else bool(pet_state.get("visible", True))
        self.pet_on_top = bool(pet_state.get("on_top", True))
        self.pet_x = int(pet_state["x"])
        self.pet_y = int(pet_state["y"])
        self.touch = None  # 桌宠的隐形触感层（pet_touch.PetTouch），窗口起来后再建
        self._touch_lock = threading.Lock()
        self._quit_lock = threading.Lock()
        self.quitting = False
        self.tray = None
        self.control_socket = None
        self.control_token = secrets.token_hex(24)

    def show_main(self, intro: bool = False) -> bool:
        if self.guard.state in ("stopped", "failed"):
            self.guard.request_restart()
        if self.main_window:
            if intro:
                # 双击程序 / 托盘打开：先在页面里铺好打开动画（public/boot.js），窗口一露面就在播
                try:
                    self.main_window.evaluate_js("window.__xunkeBoot && window.__xunkeBoot()")
                except Exception as err:
                    log_error("boot intro", err)
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

    def _reload_pages(self) -> bool:
        """后台重启后旧页面的会话已失效，替它们刷新；正在写东西的先不打断，下一轮再试。"""
        script = (
            "(function(){var busy=Array.prototype.some.call(document.querySelectorAll('textarea,input'),"
            "function(e){return /^(text|textarea|search|password|)$/.test(e.type||'')&&e.value.trim()});"
            "if(busy)return false;setTimeout(function(){location.reload()},50);return true})()"
        )
        done = True
        for win in (self.main_window, self.widget_window, self.pet_window):
            if not win or self.quitting:
                continue
            try:
                done = bool(win.evaluate_js(script)) and done
            except Exception as err:
                log_error("reload page", err)
        return done

    def set_widget_on_top(self, value: bool) -> bool:
        self.widget_on_top = bool(value)
        if self.widget_window:
            _set_hwnd_topmost(_get_hwnd(self.widget_window), self.widget_on_top)
        return self.widget_on_top

    def _persist_pet_state(self) -> None:
        save_pet_state({
            "visible": bool(self.pet_visible),
            "on_top": bool(self.pet_on_top),
            "x": int(self.pet_x),
            "y": int(self.pet_y),
        })

    def show_pet(self) -> bool:
        self.pet_visible = True
        self._persist_pet_state()
        if self.pet_window:
            try:
                _apply_pet_window_style(self.pet_window, self.pet_on_top)
                self.pet_window.show()
                _move_hwnd(_get_hwnd(self.pet_window), self.pet_x, self.pet_y, self.pet_on_top)
            except Exception as err:
                log_error("show_pet", err)
        if self.touch:
            self.touch.set_visible(True)
        return True

    def hide_pet(self) -> bool:
        self.pet_visible = False
        self._persist_pet_state()
        if self.touch:
            self.touch.set_visible(False)
        if self.pet_window:
            try:
                self.pet_window.hide()
            except Exception as err:
                log_error("hide_pet", err)
        return True

    def toggle_pet(self) -> bool:
        if self.pet_visible:
            return self.hide_pet()
        return self.show_pet()

    def set_pet_on_top(self, value: bool) -> bool:
        self.pet_on_top = bool(value)
        self._persist_pet_state()
        if self.pet_window:
            _apply_pet_window_style(self.pet_window, self.pet_on_top)
        if self.touch:
            self.touch.set_on_top(self.pet_on_top)
        return self.pet_on_top

    def get_pet_state(self) -> dict:
        return {
            "visible": bool(self.pet_visible),
            "on_top": bool(self.pet_on_top),
            "x": int(self.pet_x),
            "y": int(self.pet_y),
        }

    def get_pet_bounds(self) -> dict:
        sw, sh = get_screen_size()
        hwnd = _get_hwnd(self.pet_window)
        rect = _get_hwnd_rect(hwnd)
        if rect:
            x, y, w, h = rect
            self.pet_x, self.pet_y = x, y
        else:
            x, y, w, h = self.pet_x, self.pet_y, PET_WIDTH, PET_HEIGHT
        wl, wt, wr, wb = pet_work_area(x, y, w, h, hwnd)
        return {
            "x": int(x),
            "y": int(y),
            "width": int(w),
            "height": int(h),
            "screenWidth": int(sw),
            "screenHeight": int(sh),
            "workLeft": int(wl),
            "workTop": int(wt),
            "workRight": int(wr),
            "workBottom": int(wb),
        }

    def move_pet(self, x: int, y: int, persist: bool = False) -> bool:
        if self.touch and self.touch.running:
            self.touch.move_to(x, y)
            if persist:
                self._persist_pet_state()
            return True
        hwnd = _get_hwnd(self.pet_window)
        rect = _get_hwnd_rect(hwnd)
        cur_w = rect[2] if rect else PET_WIDTH
        cur_h = rect[3] if rect else PET_HEIGHT
        wl, wt, wr, wb = pet_work_area(x, y, cur_w, cur_h, hwnd)
        clamped_x = int(max(wl - 48, min(wr - cur_w + 48, round(x))))
        clamped_y = int(max(wt - 30, min(wb - cur_h + 24, round(y))))
        self.pet_x = clamped_x
        self.pet_y = clamped_y
        if hwnd:
            _move_hwnd(hwnd, clamped_x, clamped_y, self.pet_on_top)
        if persist:
            self._persist_pet_state()
        return True

    def pet_handle(self) -> int:
        return _get_hwnd(self.pet_window)

    def restore_pet_style(self):
        _apply_pet_window_style(self.pet_window, self.pet_on_top)

    def _start_pet_touch(self) -> bool:
        """给桌宠装上隐形触感层（只在 Windows 上；失败就保持老样子，不影响别的窗口）。
        透明窗口是先藏着、导航时才真正建出来的，刚启动时可能还拿不到句柄，所以拿不到就返回 False 让调用方重试。"""
        if not self.pet_window or os.name != "nt" or self.quitting:
            return True
        with self._touch_lock:
            if self.touch and self.touch.running:
                return True
            hwnd = _get_hwnd(self.pet_window)
            if not hwnd:
                return False
            try:
                from pet_touch import PetTouch

                if not self.touch:
                    self.touch = PetTouch(self, PET_WIDTH, PET_HEIGHT, log_error)
                self.touch.start(hwnd, self.pet_visible, self.pet_on_top)
                return self.touch.running
            except Exception as err:
                self.touch = None
                log_error("start pet touch", err)
                return True

    def _start_pet_touch_soon(self) -> None:
        def worker():
            for _ in range(60):  # 最多等 30 秒
                if self._start_pet_touch():
                    return
                time.sleep(0.5)
            log_error("start pet touch: pet window handle never became available")

        threading.Thread(target=worker, name="pet-touch-start", daemon=True).start()

    def _on_pet_loaded(self):
        if not self.pet_window:
            return
        _apply_pet_window_style(self.pet_window, self.pet_on_top)
        _move_hwnd(_get_hwnd(self.pet_window), self.pet_x, self.pet_y, self.pet_on_top)
        if self.touch and self.touch.running:
            self.touch.fit_pet_size()
        else:
            self._start_pet_touch_soon()
        if not self.pet_visible:
            try:
                self.pet_window.hide()
            except Exception:
                pass

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

    def _on_pet_closing(self):
        if self.quitting:
            return True
        threading.Thread(target=self.hide_pet, daemon=True).start()
        return False

    # ---- Single-instance local control listener ----
    def _start_control_server(self):
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.bind(("127.0.0.1", 0))
        srv.listen(5)
        port = srv.getsockname()[1]
        self.control_socket = srv
        record = control_path()
        pending = record.with_suffix(f".{os.getpid()}.tmp")
        pending.write_text(
            json.dumps({
                "port": port,
                "token": self.control_token,
                "pid": os.getpid(),
                "desktop": get_desktop_name(),
            }),
            encoding="utf-8",
        )

        pending.replace(record)

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
                        conn.settimeout(1.0)
                        with conn.makefile("rb") as stream:
                            raw = stream.readline(1024)
                        msg = json.loads(raw)
                        if msg.get("token") != self.control_token:
                            conn.sendall(b"DENY\n")
                            continue
                        cmd = msg.get("cmd")
                        conn.sendall(b"OK\n")
                        if cmd == "show_main":
                            threading.Thread(target=self.show_main, kwargs={"intro": True}, daemon=True).start()
                        elif cmd == "show_widget":
                            threading.Thread(target=self.show_widget, daemon=True).start()
                        elif cmd == "toggle_widget":
                            threading.Thread(target=self.toggle_widget, daemon=True).start()
                        elif cmd == "show_pet":
                            threading.Thread(target=self.show_pet, daemon=True).start()
                        elif cmd == "toggle_pet":
                            threading.Thread(target=self.toggle_pet, daemon=True).start()
                        elif cmd == "quit":
                            threading.Thread(target=self.quit_app, daemon=True).start()
                    except (TimeoutError, ConnectionError):
                        continue
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
            pystray.MenuItem("打开讯课主工作台", lambda icon, item: threading.Thread(target=self.show_main, kwargs={"intro": True}, daemon=True).start(), default=True),
            pystray.MenuItem("显示 / 隐藏迷你待办", lambda icon, item: threading.Thread(target=self.toggle_widget, daemon=True).start()),
            pystray.MenuItem("显示 / 隐藏日历桌宠", lambda icon, item: threading.Thread(target=self.toggle_pet, daemon=True).start()),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("开启 / 停止 QQ 采集", lambda icon, item: threading.Thread(target=self._toggle_qq_capture, daemon=True).start()),
            pystray.MenuItem("在浏览器中打开", lambda icon, item: webbrowser.open(self.base_url)),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("退出讯课工作台", lambda icon, item: threading.Thread(target=self.quit_app, daemon=True).start()),
        )
        self.tray = pystray.Icon("xunke-workbench", icon_img, "讯课 · QQ 与微信工作台", menu)
        threading.Thread(target=self.tray.run, daemon=True).start()

    def quit_app(self):
        with self._quit_lock:
            if self.quitting:
                return
            self.quitting = True
        # 先停看护，否则刚关掉的后台又会被拉起来。
        self.guard.stop()
        try:
            if self.control_socket:
                self.control_socket.close()
        except Exception:
            pass
        try:
            path = control_path()
            if json.loads(path.read_text(encoding="utf-8")).get("token") == self.control_token:
                path.unlink(missing_ok=True)
        except Exception:
            pass
        try:
            if self.tray:
                self.tray.stop()
        except Exception:
            pass
        if self.touch:
            try:
                self.touch.stop()
            except Exception:
                pass
        # 先藏窗口、关好后台，最后才销毁窗口：窗口一没主进程就会退出，后面的收尾来不及做。
        for win in (self.pet_window, self.widget_window, self.main_window):
            if win:
                try:
                    win.hide()
                except Exception:
                    pass
        # 后台不一定是讯课自己启动的，先走安全关闭接口，再用脚本兜底。
        try:
            if server_healthy(self.base_url, self.runtime.get("app", "qq-school-workbench")):
                self.client.request("/api/shutdown", "POST", {})
                deadline = time.time() + 6
                while time.time() < deadline and port_open(int(self.runtime["port"])):
                    time.sleep(0.25)
        except Exception:
            pass
        stop_backend()
        for win in (self.pet_window, self.widget_window, self.main_window):
            if win:
                try:
                    win.destroy()
                except Exception:
                    pass

    def run(self):
        import webview

        ensure_ico_file()
        WEBVIEW_PROFILE_DIR.mkdir(parents=True, exist_ok=True)
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
            background_color="#FAF5E8",
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
            background_color="#FAF5E8",
        )
        self.pet_window = webview.create_window(
            "讯课 · 日历小助手",
            url=self.base_url + "/pet",
            js_api=self.bridge,
            width=PET_WIDTH,
            height=PET_HEIGHT,
            x=self.pet_x,
            y=self.pet_y,
            resizable=False,
            frameless=True,
            easy_drag=False,
            shadow=False,
            focus=False,
            on_top=self.pet_on_top,
            transparent=True,
            hidden=(not self.pet_visible),
        )
        self.main_window.events.closing += self._on_main_closing
        self.widget_window.events.closing += self._on_widget_closing
        self.pet_window.events.closing += self._on_pet_closing
        self.pet_window.events.loaded += self._on_pet_loaded

        def on_started():
            self._start_tray()
            self.guard.start()
            _apply_pet_window_style(self.pet_window, self.pet_on_top)
            if self.pet_visible:
                _move_hwnd(_get_hwnd(self.pet_window), self.pet_x, self.pet_y, self.pet_on_top)
            else:
                try:
                    self.pet_window.hide()
                except Exception:
                    pass
            self._start_pet_touch_soon()
            if self.start_mode == "main":
                _bring_hwnd_to_front(_get_hwnd(self.main_window), keep_topmost=False)
            elif self.start_mode == "widget":
                _bring_hwnd_to_front(_get_hwnd(self.widget_window), keep_topmost=True)

            self._start_control_server()

        webview.start(
            on_started,
            gui="edgechromium",
            icon=str(ICON_FILE),
            private_mode=False,
            storage_path=str(WEBVIEW_PROFILE_DIR),
        )


def main() -> int:
    _ensure_stdio()
    parser = argparse.ArgumentParser(description="讯课工作台桌面外壳")
    parser.add_argument("--widget", action="store_true", help="打开迷你待办小窗")
    parser.add_argument("--pet", action="store_true", help="打开桌面日历小助手宠物")
    parser.add_argument("--background", action="store_true", help="后台启动到系统托盘（开机自启使用）")
    parser.add_argument("--quit", action="store_true", help="退出运行中的桌面壳与服务")
    parser.add_argument("--prepare-icon", action="store_true", help="仅生成桌面图标 .ico 后退出")
    args = parser.parse_args()

    try:
        if args.prepare_icon:
            ico = ensure_ico_file()
            print(str(ico))
            return 0

        target_cmd = ("quit" if args.quit else "noop" if args.background else
                      "show_pet" if args.pet else "show_widget" if args.widget else "show_main")
        result = claim_or_notify(target_cmd)
        if result == "delivered":
            return 0
        if result == "unavailable":
            log_error("existing desktop instance did not acknowledge " + target_cmd)
            return 1
        if args.quit:
            control_path().unlink(missing_ok=True)
            stop_backend()
            return 0

        runtime = load_runtime()
        mode = "pet" if args.pet else "widget" if args.widget else "background" if args.background else "main"
        shell = DesktopShell(runtime, mode)

        if not ensure_backend(runtime):
            log_error("ensure_backend failed")
            if os.name == "nt" and not args.background:
                ctypes.windll.user32.MessageBoxW(
                    0,
                    "讯课工作台后台服务未能启动，请检查 data\\runtime-error.log。",
                    "讯课工作台",
                    0x10,
                )
            return 1

        try:
            shell.run()
        except Exception as gui_err:
            log_error("shell.run failed, falling back to browser", gui_err)
            if not args.background:
                webbrowser.open(runtime["url"])
        return 0
    except Exception as err:
        log_error("main", err)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
