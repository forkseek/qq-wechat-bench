"""讯课 · 日历小助手的「隐形触感层」与身体动作。

为什么需要它：桌宠窗口用 TransparencyKey 抠图，而画面是 WebView2 另外合成上去的，
Windows 做点击测试时只看到满窗口的抠图色，于是整个桌宠都被当成透明、鼠标全部穿透。

做法：
- 在桌宠窗口正上方放一个原生小窗口（alpha = 1/255，肉眼看不见但能接住鼠标），
  它的可点区域 = 页面上报的「角色 / 气泡 / 菜单」矩形，其余地方照样穿透。
- 拖动、甩飞、走路都由这里直接挪窗口（系统级移动，跟手不漂）。
- 另起线程读全屏光标位置，连同点击、滚轮等事件，批量推给页面的 window.__petInput。
- 坐标一律是物理像素（pywebview 已 SetProcessDPIAware）；和页面 CSS 像素按 DPI 换算。
"""
from __future__ import annotations

import ctypes
import json
import math
import threading
import time
from collections import deque
from ctypes import wintypes

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32
kernel32 = ctypes.windll.kernel32

LRESULT = ctypes.c_ssize_t
WNDPROC = ctypes.WINFUNCTYPE(LRESULT, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM)


class WNDCLASSEXW(ctypes.Structure):
    _fields_ = [
        ("cbSize", wintypes.UINT), ("style", wintypes.UINT), ("lpfnWndProc", WNDPROC),
        ("cbClsExtra", ctypes.c_int), ("cbWndExtra", ctypes.c_int), ("hInstance", wintypes.HINSTANCE),
        ("hIcon", wintypes.HICON), ("hCursor", wintypes.HANDLE), ("hbrBackground", wintypes.HBRUSH),
        ("lpszMenuName", wintypes.LPCWSTR), ("lpszClassName", wintypes.LPCWSTR), ("hIconSm", wintypes.HICON),
    ]


class TRACKMOUSEEVENT(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.DWORD), ("dwFlags", wintypes.DWORD), ("hwndTrack", wintypes.HWND), ("dwHoverTime", wintypes.DWORD)]


user32.DefWindowProcW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
user32.DefWindowProcW.restype = LRESULT
user32.RegisterClassExW.argtypes = [ctypes.POINTER(WNDCLASSEXW)]
user32.RegisterClassExW.restype = wintypes.ATOM
user32.CreateWindowExW.argtypes = [
    wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD, ctypes.c_int, ctypes.c_int,
    ctypes.c_int, ctypes.c_int, wintypes.HWND, wintypes.HMENU, wintypes.HINSTANCE, wintypes.LPVOID,
]
user32.CreateWindowExW.restype = wintypes.HWND
user32.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.UINT]
user32.SetWindowPos.restype = wintypes.BOOL
user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
user32.GetMessageW.argtypes = [ctypes.POINTER(wintypes.MSG), wintypes.HWND, wintypes.UINT, wintypes.UINT]
user32.TranslateMessage.argtypes = [ctypes.POINTER(wintypes.MSG)]
user32.DispatchMessageW.argtypes = [ctypes.POINTER(wintypes.MSG)]
user32.LoadCursorW.argtypes = [wintypes.HINSTANCE, wintypes.LPVOID]
user32.LoadCursorW.restype = wintypes.HANDLE
user32.SetCursor.argtypes = [wintypes.HANDLE]
user32.SetWindowRgn.argtypes = [wintypes.HWND, wintypes.HRGN, wintypes.BOOL]
user32.SetLayeredWindowAttributes.argtypes = [wintypes.HWND, wintypes.COLORREF, wintypes.BYTE, wintypes.DWORD]
user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
user32.GetWindow.argtypes = [wintypes.HWND, wintypes.UINT]
user32.GetWindow.restype = wintypes.HWND
user32.SetTimer.argtypes = [wintypes.HWND, ctypes.c_size_t, wintypes.UINT, wintypes.LPVOID]
user32.SetTimer.restype = ctypes.c_size_t
user32.KillTimer.argtypes = [wintypes.HWND, ctypes.c_size_t]
user32.SetCapture.argtypes = [wintypes.HWND]
user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
user32.IsWindowVisible.argtypes = [wintypes.HWND]
user32.DestroyWindow.argtypes = [wintypes.HWND]
user32.TrackMouseEvent.argtypes = [ctypes.POINTER(TRACKMOUSEEVENT)]
gdi32.CreateRoundRectRgn.restype = wintypes.HRGN
gdi32.CreateRectRgn.restype = wintypes.HRGN
gdi32.CombineRgn.argtypes = [wintypes.HRGN, wintypes.HRGN, wintypes.HRGN, ctypes.c_int]
gdi32.DeleteObject.argtypes = [wintypes.HGDIOBJ]
gdi32.GetStockObject.restype = wintypes.HGDIOBJ
kernel32.GetModuleHandleW.restype = wintypes.HMODULE
try:
    user32.GetDpiForWindow.argtypes = [wintypes.HWND]
    user32.GetDpiForWindow.restype = wintypes.UINT
    _HAS_DPI_FOR_WINDOW = True
except AttributeError:
    _HAS_DPI_FOR_WINDOW = False
try:
    user32.SetThreadDpiAwarenessContext.argtypes = [ctypes.c_void_p]
    user32.SetThreadDpiAwarenessContext.restype = ctypes.c_void_p
    user32.GetWindowDpiAwarenessContext.argtypes = [wintypes.HWND]
    user32.GetWindowDpiAwarenessContext.restype = ctypes.c_void_p
    _HAS_THREAD_DPI = True
except AttributeError:
    _HAS_THREAD_DPI = False


class _SameDpiAs:
    """在这段代码里，让当前线程和桌宠窗口用同一种 DPI 感知方式。
    坑：DPI 感知是按线程算的。pywebview / WinForms 的线程按物理像素算坐标，而 Python 自己开的线程
    默认「不感知 DPI」，同一个坐标会被系统再放大 1.5 倍（150% 缩放下触感层就跑到了 1.5 倍远的地方）。"""

    def __init__(self, hwnd):
        self.hwnd = hwnd
        self.old = None

    def __enter__(self):
        if _HAS_THREAD_DPI and self.hwnd:
            ctx = user32.GetWindowDpiAwarenessContext(self.hwnd)
            if ctx:
                self.old = user32.SetThreadDpiAwarenessContext(ctx)
        return self

    def __exit__(self, *exc):
        if self.old:
            user32.SetThreadDpiAwarenessContext(self.old)
        return False

WS_POPUP = 0x80000000
WS_EX_LAYERED = 0x00080000
WS_EX_TOOLWINDOW = 0x00000080
WS_EX_TOPMOST = 0x00000008
WS_EX_NOACTIVATE = 0x08000000
LWA_ALPHA = 0x2
CS_DBLCLKS = 0x0008

WM_TIMER = 0x0113
CLICK_TIMER = 1
WM_DESTROY = 0x0002
WM_CLOSE = 0x0010
WM_SETCURSOR = 0x0020
WM_MOUSEACTIVATE = 0x0021
WM_MOUSEMOVE = 0x0200
WM_LBUTTONDOWN = 0x0201
WM_LBUTTONUP = 0x0202
WM_LBUTTONDBLCLK = 0x0203
WM_RBUTTONUP = 0x0205
WM_MOUSEWHEEL = 0x020A
WM_MOUSELEAVE = 0x02A3
WM_CAPTURECHANGED = 0x0215
WM_APP = 0x8000
WM_APP_REGION = WM_APP + 1
WM_APP_SHOW = WM_APP + 2
WM_APP_HIDE = WM_APP + 3
WM_APP_QUIT = WM_APP + 4
MA_NOACTIVATE = 3
TME_LEAVE = 0x2

SWP_NOSIZE = 0x0001
SWP_NOMOVE = 0x0002
SWP_NOZORDER = 0x0004
SWP_NOACTIVATE = 0x0010
SWP_SHOWWINDOW = 0x0040
SWP_NOOWNERZORDER = 0x0200
SWP_ASYNCWINDOWPOS = 0x4000
HWND_TOPMOST = wintypes.HWND(-1)
HWND_NOTOPMOST = wintypes.HWND(-2)
SW_HIDE = 0
SW_SHOWNOACTIVATE = 4
RGN_OR = 2
IDC_HAND = 32649
IDC_SIZEALL = 32646
BLACK_BRUSH = 4

DRAG_THRESHOLD = 5          # 物理像素：超过才算拖动
THROW_MIN_SPEED = 1100      # 物理像素/秒：松手速度超过它才算「甩出去」
GRAVITY = 4200              # 物理像素/秒²
BOUNCE = 0.42
FLOOR_FRICTION = 0.82


def _cursor() -> tuple[int, int]:
    pt = wintypes.POINT()
    user32.GetCursorPos(ctypes.byref(pt))
    return int(pt.x), int(pt.y)


def _rect(hwnd) -> tuple[int, int, int, int] | None:
    if not hwnd:
        return None
    r = wintypes.RECT()
    if user32.GetWindowRect(hwnd, ctypes.byref(r)):
        return r.left, r.top, r.right - r.left, r.bottom - r.top
    return None


def _work_area() -> tuple[int, int, int, int]:
    r = wintypes.RECT()
    if user32.SystemParametersInfoW(0x0030, 0, ctypes.byref(r), 0):
        return r.left, r.top, r.right, r.bottom
    return 0, 0, user32.GetSystemMetrics(0), user32.GetSystemMetrics(1) - 48


class MONITORINFO(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.DWORD), ("rcMonitor", wintypes.RECT), ("rcWork", wintypes.RECT), ("dwFlags", wintypes.DWORD)]


user32.MonitorFromPoint.argtypes = [wintypes.POINT, wintypes.DWORD]
user32.MonitorFromPoint.restype = wintypes.HANDLE
user32.GetMonitorInfoW.argtypes = [wintypes.HANDLE, ctypes.POINTER(MONITORINFO)]
MONITOR_DEFAULTTONEAREST = 2


def _work_area_at(x: float, y: float) -> tuple[int, int, int, int]:
    """离这个点最近的那块显示器的可用区（去掉任务栏）。多显示器时桌宠在哪块屏就按哪块屏的边界。"""
    try:
        mon = user32.MonitorFromPoint(wintypes.POINT(int(x), int(y)), MONITOR_DEFAULTTONEAREST)
        info = MONITORINFO()
        info.cbSize = ctypes.sizeof(MONITORINFO)
        if mon and user32.GetMonitorInfoW(mon, ctypes.byref(info)):
            w = info.rcWork
            return w.left, w.top, w.right, w.bottom
    except Exception:
        pass
    return _work_area()


class PetTouch:
    """隐形触感层 + 光标/事件推送 + 拖动/甩飞/走路。"""

    def __init__(self, shell, css_width: int, css_height: int, log_error=None):
        self.shell = shell
        self.css_w = css_width
        self.css_h = css_height
        self.log_error = log_error or (lambda *a: None)
        self.hit = None
        self._pet = 0
        self._pet_checked = 0.0
        self._pet_changed = False
        self.scale = 1.0
        self.visible = False
        self.on_top = True
        self.running = False
        self.lock = threading.Lock()
        # 页面上报的可点区域（CSS 像素，相对桌宠窗口左上角）：[{x,y,w,h,r}]
        # 页面还没上报前的默认值：角色 148×148 居中摆在窗口里
        mid = (css_height - 148) / 2
        self.zones = [{"x": 46, "y": mid, "w": 148, "h": 148, "r": 40}]
        self.sprite = {"x": 46, "y": mid, "w": 148, "h": 148}
        self.ground = 8  # 角色脚底离窗口底边的 CSS 像素
        # 拖动状态（只在触感层线程里读写）
        self.press = None
        self.pending_click = None
        self.dragging = False
        self.samples = deque(maxlen=12)
        # 动画（甩飞 / 走路），在推送线程里跑
        self.anim = None
        self.anim_lock = threading.Lock()
        # 推给页面的事件
        self.events = deque(maxlen=200)
        self.ev_lock = threading.Lock()
        self.ev_signal = threading.Event()
        self._cursor_last = None
        self._cursor_sent_at = 0.0
        self._last_zorder = 0.0
        self._wndproc = WNDPROC(self._proc)  # 必须留住引用

    # ------------------------------------------------------------ 桌宠窗口句柄（会变！）

    @property
    def pet(self) -> int:
        """桌宠窗口的当前句柄。
        坑：WinForms 改 ShowInTaskbar 这类属性会悄悄销毁并重建窗口句柄，开机时拿到的句柄过一会儿就作废了，
        触感层要是还跟着旧句柄，就会停在旧窗口最后的位置（150% 缩放下看着像差了 1.5 倍）。所以每半秒现取一次。"""
        now = time.monotonic()
        h = self._pet
        if not h or now - self._pet_checked > 0.5 or not user32.IsWindow(h):
            self._pet_checked = now
            live = self._live_hwnd()
            if live and live != h:
                if h:
                    self._pet_changed = True
                self._pet = h = live
        return h

    @pet.setter
    def pet(self, value: int) -> None:
        self._pet = int(value or 0)
        self._pet_checked = time.monotonic()

    def _live_hwnd(self) -> int:
        return self.shell.pet_handle()

    def _on_pet_handle_changed(self) -> None:
        self._pet_changed = False
        self.shell.restore_pet_style()
        self._update_scale()
        self.fit_pet_size()
        self._restack()
        if self.hit:
            user32.PostMessageW(self.hit, WM_APP_REGION, 0, 0)

    # ------------------------------------------------------------ 生命周期

    def start(self, pet_hwnd: int, visible: bool, on_top: bool) -> None:
        if self.running or not pet_hwnd:
            return
        self.pet = pet_hwnd
        self.visible = visible
        self.on_top = on_top
        self.running = True
        self._update_scale()
        self.fit_pet_size()
        threading.Thread(target=self._ui_thread, name="pet-touch-ui", daemon=True).start()
        threading.Thread(target=self._feed_thread, name="pet-touch-feed", daemon=True).start()
        threading.Thread(target=self._send_thread, name="pet-touch-send", daemon=True).start()

    def stop(self) -> None:
        self.running = False
        self.ev_signal.set()
        if self.hit:
            user32.PostMessageW(self.hit, WM_APP_QUIT, 0, 0)

    def _update_scale(self) -> None:
        try:
            if _HAS_DPI_FOR_WINDOW and self.pet:
                dpi = user32.GetDpiForWindow(self.pet)
                if dpi:
                    self.scale = dpi / 96.0
                    return
        except Exception:
            pass
        self.scale = 1.0

    def fit_pet_size(self) -> None:
        """把桌宠窗口的物理尺寸设成 页面设计尺寸 × 缩放（150% 下原来算小了，角色会被裁掉）。"""
        if not self.pet:
            return
        with _SameDpiAs(self.pet):
            w = int(round(self.css_w * self.scale))
            h = int(round(self.css_h * self.scale))
            user32.SetWindowPos(self.pet, None, 0, 0, w, h, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE)
            self._place_hit()
            self._ensure_inside()

    # ------------------------------------------------------------ 对外接口（桌面壳 / 页面调用）

    def set_visible(self, visible: bool) -> None:
        self.visible = bool(visible)
        if self.hit:
            user32.PostMessageW(self.hit, WM_APP_SHOW if self.visible else WM_APP_HIDE, 0, 0)
        if self.visible:
            self._update_scale()
            self.fit_pet_size()

    def set_on_top(self, on_top: bool) -> None:
        self.on_top = bool(on_top)
        with _SameDpiAs(self.pet):
            self._restack()

    def set_zones(self, zones, sprite=None, ground=None) -> None:
        clean = []
        for z in zones or []:
            try:
                clean.append({k: float(z.get(k, 0)) for k in ("x", "y", "w", "h", "r")})
            except Exception:
                continue
        with self.lock:
            if clean:
                self.zones = clean
            if isinstance(sprite, dict):
                self.sprite = {k: float(sprite.get(k, 0)) for k in ("x", "y", "w", "h")}
            if isinstance(ground, (int, float)):
                self.ground = float(ground)
        if self.hit:
            user32.PostMessageW(self.hit, WM_APP_REGION, 0, 0)

    def walk(self, dx_css: float, speed_css: float = 70) -> bool:
        """沿着地面走一段（CSS 像素，正数向右）。"""
        if not self.pet or self.press:
            return False
        with _SameDpiAs(self.pet):
            r = _rect(self.pet)
            if not r:
                return False
            lo, hi, _, _ = self._bounds(r[0], r[1], r[2], r[3])
        target = max(lo, min(hi, r[0] + dx_css * self.scale))
        with self.anim_lock:
            self.anim = {"kind": "walk", "x": float(r[0]), "y": float(r[1]), "target": target,
                         "speed": max(20.0, speed_css * self.scale)}
        return True

    def stop_motion(self) -> None:
        with self.anim_lock:
            if self.anim and self.anim["kind"] == "walk":
                self.anim = None
                self._emit({"type": "walkdone", "stopped": True})

    def move_to(self, x: int, y: int) -> None:
        with _SameDpiAs(self.pet):
            self._move_both(int(x), int(y))

    # ------------------------------------------------------------ 位置 / 层级

    # 桌面边界（参考 QQ 宠物：角色本身哪儿都能去，气泡自己找地方放）：
    # - 角色本身完整留在屏幕可用区里，四条边都能贴到；脚最低踩在任务栏上沿；
    # - 窗口的透明部分可以伸出屏幕，气泡 / 菜单探出去时由页面往里挪、或翻到角色下方；
    # - 按角色所在的那块显示器算，多屏时拖到哪块屏就用哪块屏的边。
    def _bounds(self, x: float, y: float, win_w: int, win_h: int) -> tuple[float, float, float, float]:
        s = self.scale
        with self.lock:
            sx, sy, sw, sh = self.sprite["x"], self.sprite["y"], self.sprite["w"], self.sprite["h"]
            g = self.ground * s
        wl, wt, wr, wb = _work_area_at(x + (sx + sw / 2) * s, y + (sy + sh / 2) * s)
        xmin, xmax = wl - sx * s, wr - (sx + sw) * s
        ymin, ymax = wt - sy * s, wb - win_h + g
        if xmax < xmin:
            xmin = xmax = (xmin + xmax) / 2
        if ymax < ymin:
            ymin = ymax
        return xmin, xmax, ymin, ymax

    def _clamp(self, x: float, y: float) -> tuple[int, int]:
        r = _rect(self.pet)
        if not r:
            return int(x), int(y)
        xmin, xmax, ymin, ymax = self._bounds(x, y, r[2], r[3])
        return int(round(min(max(x, xmin), xmax))), int(round(min(max(y, ymin), ymax)))

    def _move_both(self, x: float, y: float) -> tuple[int, int]:
        """所有挪动都走这里：先按边界卡住，再挪桌宠和触感层。返回实际落点。"""
        if not self.pet:
            return int(x), int(y)
        x, y = self._clamp(x, y)
        user32.SetWindowPos(self.pet, None, x, y, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS)
        if self.hit:
            user32.SetWindowPos(self.hit, None, x, y, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS)
        self.shell.pet_x, self.shell.pet_y = x, y
        self._report_edges(x, y)
        return x, y

    def _report_edges(self, x: int, y: int) -> None:
        """窗口有多少伸到了屏幕外（上下左右，CSS 像素）；页面据此把气泡往里挪、或翻到下方。"""
        r = _rect(self.pet)
        if not r:
            return
        s = self.scale
        with self.lock:
            sx, sy, sw, sh = self.sprite["x"], self.sprite["y"], self.sprite["w"], self.sprite["h"]
        wl, wt, wr, wb = _work_area_at(x + (sx + sw / 2) * s, y + (sy + sh / 2) * s)
        edges = (round(max(0, wl - x) / s), round(max(0, x + r[2] - wr) / s),
                 round(max(0, wt - y) / s), round(max(0, y + r[3] - wb) / s))
        if edges != getattr(self, "_edges", None):
            self._edges = edges
            self._emit({"type": "edge", "left": edges[0], "right": edges[1], "top": edges[2], "bottom": edges[3]}, coalesce=True)

    def _ensure_inside(self) -> None:
        """开机读回的旧位置、改分辨率、挪任务栏之后，把跑出边界的桌宠请回来。"""
        if self.press or self.anim:
            return
        r = _rect(self.pet)
        if not r:
            return
        x, y = self._clamp(r[0], r[1])
        if (x, y) != (r[0], r[1]):
            self._move_both(x, y)
            self._persist()
        else:
            self._report_edges(x, y)

    def _place_hit(self) -> None:
        r = _rect(self.pet)
        if not r or not self.hit:
            return
        user32.SetWindowPos(self.hit, None, r[0], r[1], r[2], r[3], SWP_NOZORDER | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS)

    def _restack(self) -> None:
        """触感层永远紧贴在桌宠上面一层。"""
        if not self.hit or not self.pet:
            return
        after = HWND_TOPMOST if self.on_top else HWND_NOTOPMOST
        user32.SetWindowPos(self.hit, after, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_ASYNCWINDOWPOS)
        user32.SetWindowPos(self.pet, self.hit, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_ASYNCWINDOWPOS)

    def _persist(self) -> None:
        try:
            self.shell._persist_pet_state()
        except Exception as err:
            self.log_error("pet_touch persist", err)

    # ------------------------------------------------------------ 触感层窗口（独立线程 + 消息循环）

    def _ui_thread(self) -> None:
        try:
            _SameDpiAs(self.pet).__enter__()  # 本线程一直和桌宠同一种 DPI 方式（窗口建在这里，坐标才对得上）
            hinst = kernel32.GetModuleHandleW(None)
            cls = WNDCLASSEXW()
            cls.cbSize = ctypes.sizeof(WNDCLASSEXW)
            cls.style = CS_DBLCLKS
            cls.lpfnWndProc = self._wndproc
            cls.hInstance = hinst
            cls.hCursor = user32.LoadCursorW(None, ctypes.c_void_p(IDC_HAND))
            cls.hbrBackground = gdi32.GetStockObject(BLACK_BRUSH)
            cls.lpszClassName = "XunkePetTouchLayer"
            user32.RegisterClassExW(ctypes.byref(cls))
            r = _rect(self.pet) or (0, 0, 10, 10)
            ex = WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | (WS_EX_TOPMOST if self.on_top else 0)
            self.hit = user32.CreateWindowExW(ex, "XunkePetTouchLayer", "讯课 · 日历小助手触感层", WS_POPUP,
                                              r[0], r[1], r[2], r[3], None, None, hinst, None)
            if not self.hit:
                raise ctypes.WinError()
            # 1/255 的不透明度：看不见，但 Windows 认它是「有东西」，鼠标就不会穿透
            user32.SetLayeredWindowAttributes(self.hit, 0, 1, LWA_ALPHA)
            self._apply_region()
            if self.visible:
                user32.ShowWindow(self.hit, SW_SHOWNOACTIVATE)
            self._restack()
            msg = wintypes.MSG()
            while self.running and user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
                user32.TranslateMessage(ctypes.byref(msg))
                user32.DispatchMessageW(ctypes.byref(msg))
        except Exception as err:
            self.log_error("pet_touch ui thread", err)
        finally:
            self.running = False
            self.ev_signal.set()
            if self.hit:
                try:
                    user32.DestroyWindow(self.hit)
                except Exception:
                    pass
                self.hit = None

    def _apply_region(self) -> None:
        if not self.hit:
            return
        s = self.scale
        with self.lock:
            zones = list(self.zones)
        rgn = None
        for z in zones:
            l, t = int(z["x"] * s), int(z["y"] * s)
            rr = int(max(0, z.get("r", 0)) * s * 2)
            part = gdi32.CreateRoundRectRgn(l, t, int((z["x"] + z["w"]) * s) + 1, int((z["y"] + z["h"]) * s) + 1, rr, rr)
            if rgn is None:
                rgn = part
            else:
                gdi32.CombineRgn(rgn, rgn, part, RGN_OR)
                gdi32.DeleteObject(part)
        if rgn is None:
            rgn = gdi32.CreateRectRgn(0, 0, 0, 0)
        # SetWindowRgn 之后区域归系统管，不要再 DeleteObject
        user32.SetWindowRgn(self.hit, rgn, True)

    def _local_css(self) -> tuple[float, float]:
        cx, cy = _cursor()
        r = _rect(self.pet) or (0, 0, 0, 0)
        return (cx - r[0]) / self.scale, (cy - r[1]) / self.scale

    def _proc(self, hwnd, msg, wparam, lparam):
        try:
            if msg == WM_MOUSEACTIVATE:
                return MA_NOACTIVATE
            if msg == WM_SETCURSOR:
                user32.SetCursor(user32.LoadCursorW(None, ctypes.c_void_p(IDC_SIZEALL if self.dragging else IDC_HAND)))
                return 1
            if msg == WM_TIMER and wparam == CLICK_TIMER:
                self._finish_click(hwnd, deliver=True)
                return 0
            if msg == WM_LBUTTONDOWN:
                self._finish_click(hwnd, deliver=True)
                with self.anim_lock:
                    interrupted = self.anim is not None
                    self.anim = None
                if interrupted:
                    self._emit({"type": "caught"})
                cx, cy = _cursor()
                r = _rect(self.pet) or (0, 0, 0, 0)
                self.press = {"cx": cx, "cy": cy, "px": r[0], "py": r[1], "t": time.perf_counter()}
                self.dragging = False
                self.samples.clear()
                self.samples.append((time.perf_counter(), cx, cy))
                user32.SetCapture(hwnd)
                return 0
            if msg == WM_MOUSEMOVE:
                if self.press:
                    cx, cy = _cursor()
                    dx, dy = cx - self.press["cx"], cy - self.press["cy"]
                    now = time.perf_counter()
                    self.samples.append((now, cx, cy))
                    if not self.dragging and math.hypot(dx, dy) > DRAG_THRESHOLD:
                        self.dragging = True
                        self._emit({"type": "dragstart"})
                    if self.dragging:
                        self._move_both(self.press["px"] + dx, self.press["py"] + dy)
                        vx, vy = self._velocity()
                        self._emit({"type": "dragmove", "vx": round(vx / self.scale), "vy": round(vy / self.scale)}, coalesce=True)
                else:
                    tme = TRACKMOUSEEVENT(ctypes.sizeof(TRACKMOUSEEVENT), TME_LEAVE, hwnd, 0)
                    user32.TrackMouseEvent(ctypes.byref(tme))
                return 0
            if msg == WM_LBUTTONUP:
                self._end_press(release=True)
                return 0
            if msg == WM_CAPTURECHANGED:
                if self.press:
                    self._end_press(release=False)
                return 0
            if msg == WM_LBUTTONDBLCLK:
                self._finish_click(hwnd, deliver=False)
                x, y = self._local_css()
                self._emit({"type": "dblclick", "x": round(x, 1), "y": round(y, 1)})
                return 0
            if msg == WM_RBUTTONUP:
                x, y = self._local_css()
                self._emit({"type": "rclick", "x": round(x, 1), "y": round(y, 1)})
                return 0
            if msg == WM_MOUSEWHEEL:
                delta = ctypes.c_short((wparam >> 16) & 0xFFFF).value
                x, y = self._local_css()
                self._emit({"type": "wheel", "delta": int(delta), "x": round(x, 1), "y": round(y, 1)})
                return 0
            if msg == WM_MOUSELEAVE:
                self._emit({"type": "leave"})
                return 0
            if msg == WM_APP_REGION:
                self._place_hit()
                self._apply_region()
                return 0
            if msg == WM_APP_SHOW:
                self._place_hit()
                user32.ShowWindow(hwnd, SW_SHOWNOACTIVATE)
                self._restack()
                return 0
            if msg == WM_APP_HIDE:
                self._finish_click(hwnd, deliver=False)
                user32.ShowWindow(hwnd, SW_HIDE)
                return 0
            if msg == WM_APP_QUIT:
                user32.DestroyWindow(hwnd)
                return 0
            if msg == WM_DESTROY:
                self._finish_click(hwnd, deliver=False)
                user32.PostQuitMessage(0)
                return 0
        except Exception as err:
            self.log_error("pet_touch wndproc", err)
        return user32.DefWindowProcW(hwnd, msg, wparam, lparam)

    def _velocity(self) -> tuple[float, float]:
        if len(self.samples) < 2:
            return 0.0, 0.0
        t1, x1, y1 = self.samples[-1]
        t0, x0, y0 = self.samples[0]
        for s in self.samples:
            if t1 - s[0] <= 0.09:
                t0, x0, y0 = s
                break
        dt = max(1e-3, t1 - t0)
        return (x1 - x0) / dt, (y1 - y0) / dt

    def _finish_click(self, hwnd, deliver: bool) -> None:
        event, self.pending_click = self.pending_click, None
        if event:
            user32.KillTimer(hwnd, CLICK_TIMER)
            if deliver:
                self._emit(event)

    def _end_press(self, release: bool) -> None:
        press = self.press
        self.press = None
        try:
            user32.ReleaseCapture()
        except Exception:
            pass
        if not press:
            return
        if not self.dragging:
            if release:
                x, y = self._local_css()
                event = {"type": "click", "x": round(x, 1), "y": round(y, 1)}
                with self.lock:
                    s = self.sprite
                    on_sprite = s["x"] <= x < s["x"] + s["w"] and s["y"] <= y < s["y"] + s["h"]
                if on_sprite and user32.SetTimer(self.hit, CLICK_TIMER, user32.GetDoubleClickTime(), None):
                    self.pending_click = event
                else:
                    self._emit(event)
            return
        self.dragging = False
        vx, vy = self._velocity()
        speed = math.hypot(vx, vy)
        r = _rect(self.pet)
        if release and r and speed > THROW_MIN_SPEED:
            with self.anim_lock:
                self.anim = {"kind": "fly", "x": float(r[0]), "y": float(r[1]),
                             "vx": max(-6000, min(6000, vx)), "vy": max(-6000, min(6000, vy)),
                             "bounces": 0, "maxImpact": 0.0, "rest": 0}
            self._emit({"type": "thrown", "speed": round(speed / self.scale)})
        else:
            self._emit({"type": "drop"})
            self._persist()

    # ------------------------------------------------------------ 推送线程：光标 + 动画

    def _emit(self, ev: dict, coalesce: bool = False) -> None:
        ev.setdefault("t", round(time.time() * 1000))
        with self.ev_lock:
            if coalesce and self.events and self.events[-1].get("type") == ev["type"]:
                self.events[-1] = ev
            else:
                self.events.append(ev)
        self.ev_signal.set()

    def _feed_thread(self) -> None:
        _SameDpiAs(self.pet).__enter__()  # 读光标、挪窗口都用物理像素
        last = time.perf_counter()
        while self.running:
            now = time.perf_counter()
            dt = min(0.05, now - last)
            last = now
            try:
                if self.visible and self.pet:
                    if self._pet_changed and not self.press:
                        self._on_pet_handle_changed()
                    animating = self._step_anim(dt)
                    self._feed_cursor(now)
                    if now - self._last_zorder > 2.0 and not self.press:
                        self._last_zorder = now
                        previous_scale = self.scale
                        self._update_scale()
                        if self.scale != previous_scale:
                            self.fit_pet_size()
                            if self.hit:
                                user32.PostMessageW(self.hit, WM_APP_REGION, 0, 0)
                        if self.on_top:
                            self._restack()
                        else:
                            previous = user32.GetWindow(self.pet, 3)  # GW_HWNDPREV
                            if self.hit and previous != self.hit:
                                user32.SetWindowPos(self.hit, previous, 0, 0, 0, 0,
                                                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS)
                        self._ensure_inside()
                    time.sleep(1 / 60 if (animating or self.press) else 1 / 30)
                else:
                    time.sleep(0.25)
            except Exception as err:
                self.log_error("pet_touch feed", err)
                time.sleep(0.5)

    def _feed_cursor(self, now: float) -> None:
        cx, cy = _cursor()
        if self._cursor_last == (cx, cy):
            return
        r = _rect(self.pet)
        if not r:
            return
        lx, ly = (cx - r[0]) / self.scale, (cy - r[1]) / self.scale
        with self.lock:
            sp = dict(self.sprite)
        mx, my = sp["x"] + sp["w"] / 2, sp["y"] + sp["h"] / 2
        far = math.hypot(lx - mx, ly - my) > 700
        # 光标离得远就少报几次（每秒 4 次），近处每秒 30 次
        if far and now - self._cursor_sent_at < 0.25:
            return
        self._cursor_last = (cx, cy)
        self._cursor_sent_at = now
        self._emit({"type": "cursor", "x": round(lx, 1), "y": round(ly, 1)}, coalesce=True)

    def _step_anim(self, dt: float) -> bool:
        with self.anim_lock:
            a = self.anim
            if not a:
                return False
            r = _rect(self.pet)
            if not r:
                self.anim = None
                return False
            w, h = r[2], r[3]
            lo, hi, top, floor = self._bounds(a["x"], a["y"], w, h)
            if a["kind"] == "walk":
                step = a["speed"] * dt
                d = a["target"] - a["x"]
                if abs(d) <= step:
                    a["x"] = a["target"]
                    self.anim = None
                    self._move_both(int(a["x"]), int(a["y"]))
                    self._emit({"type": "walkdone"})
                    self._persist()
                    return False
                a["x"] += step if d > 0 else -step
                self._move_both(int(a["x"]), int(a["y"]))
                return True
            # 甩飞：重力 + 撞墙 + 落在任务栏上沿弹几下
            a["vy"] += GRAVITY * dt
            a["x"] += a["vx"] * dt
            a["y"] += a["vy"] * dt
            if a["x"] < lo:
                a["x"], a["vx"] = lo, abs(a["vx"]) * BOUNCE
                self._emit({"type": "bump", "side": "left"})
            elif a["x"] > hi:
                a["x"], a["vx"] = hi, -abs(a["vx"]) * BOUNCE
                self._emit({"type": "bump", "side": "right"})
            if a["y"] < top:
                a["y"], a["vy"] = top, abs(a["vy"]) * BOUNCE
            if a["y"] >= floor:
                a["y"] = floor
                impact = a["vy"] / self.scale
                if impact > 160:
                    a["bounces"] += 1
                    a["maxImpact"] = max(a["maxImpact"], impact)
                    self._emit({"type": "bounce", "impact": round(impact), "n": a["bounces"]})
                    a["vy"] = -a["vy"] * BOUNCE
                    a["vx"] *= FLOOR_FRICTION
                else:
                    a["vy"] = 0
                    a["vx"] *= max(0.0, 1 - 6 * dt)
                    if abs(a["vx"]) < 25:
                        self.anim = None
                        self._move_both(int(a["x"]), int(a["y"]))
                        self._emit({"type": "land", "impact": round(a["maxImpact"]), "bounces": a["bounces"]})
                        self._persist()
                        return False
            self._move_both(int(a["x"]), int(a["y"]))
            return True

    # ------------------------------------------------------------ 发送线程：批量推给页面（页面卡住也不拖慢鼠标）

    def _send_thread(self) -> None:
        while self.running:
            self.ev_signal.wait(0.5)
            self.ev_signal.clear()
            with self.ev_lock:
                batch = list(self.events)
                self.events.clear()
            if not batch or not self.visible:
                continue
            win = getattr(self.shell, "pet_window", None)
            if not win:
                continue
            try:
                payload = json.dumps(batch, ensure_ascii=False)
                win.run_js(f"window.__petInput&&window.__petInput({payload})")
            except Exception as err:
                self.log_error("pet_touch send", err)
                time.sleep(0.3)
            time.sleep(1 / 60)
