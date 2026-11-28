"""Windows desktop regression tests using a private mutex, socket and temporary state."""
import ctypes
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import desktop_app as desktop
import pet_touch


def isolated_paths(root, name):
    desktop.DATA_DIR = root
    desktop.CONTROL_FILE = root / "desktop-control.json"
    desktop.PET_STATE_FILE = root / "pet-state.json"
    desktop.ERROR_LOG_FILE = root / "errors.txt"
    desktop.get_desktop_name = lambda: name


def headless_shell():
    root, name, *args = sys.argv[2:]
    root = Path(root)
    isolated_paths(root, name)
    finished = threading.Event()
    desktop.ensure_backend = lambda runtime: True
    desktop.load_runtime = lambda: {"url": "http://127.0.0.1:1", "port": 1}
    desktop.stop_backend = lambda: (root / "stopped").touch()
    desktop.server_healthy = lambda *args: False

    def run(shell):
        shell._start_control_server()
        (root / "ready").touch()
        if not finished.wait(12):
            raise RuntimeError("missing quit")
    quit_app = desktop.DesktopShell.quit_app
    def quit_and_signal(shell):
        quit_app(shell)
        finished.set()
    desktop.DesktopShell.run = run
    desktop.DesktopShell.quit_app = quit_and_signal
    # 第二次双击程序要带 intro=True（重播打开动画）
    desktop.DesktopShell.show_main = lambda self, intro=False: (root / "wake").write_text(str(intro))
    sys.argv = [sys.argv[0], *args]
    return desktop.main()


class DesktopTests(unittest.TestCase):
    def test_single_instance_lifecycle(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            name = "test_" + uuid4().hex
            cmd = [sys.executable, "-B", __file__, "shell", temp, name]
            def wait_for(file):
                deadline = time.monotonic() + 5
                while not file.exists() and time.monotonic() < deadline:
                    time.sleep(.02)
                self.assertTrue(file.exists(), file)
            with patch.object(desktop, "CONTROL_FILE", root / "desktop-control.json"), patch.object(desktop, "get_desktop_name", return_value=name):
                record = desktop.control_path()
            for stale in ["{", json.dumps({"pid": os.getpid(), "desktop": name, "port": 1, "token": "fixture"})]:
                record.write_text(stale)
                shell = subprocess.Popen(cmd + ["--background"], creationflags=subprocess.CREATE_NO_WINDOW)
                try:
                    wait_for(root / "ready")
                    subprocess.run(cmd, timeout=5, check=True, creationflags=subprocess.CREATE_NO_WINDOW)
                    wait_for(root / "wake")
                    time.sleep(.05)
                    self.assertEqual((root / "wake").read_text(), "True")
                    subprocess.run(cmd + ["--quit"], timeout=5, check=True, creationflags=subprocess.CREATE_NO_WINDOW)
                    self.assertEqual(shell.wait(5), 0)
                    self.assertTrue((root / "stopped").is_file())
                    self.assertFalse(record.exists())
                finally:
                    if shell.poll() is None:
                        shell.terminate()
                        shell.wait(5)
                for item in ("ready", "wake", "stopped"):
                    (root / item).unlink()
            record.write_text("[]")
            subprocess.run(cmd + ["--quit"], timeout=5, check=True, creationflags=subprocess.CREATE_NO_WINDOW)
            self.assertFalse(record.exists())

    def test_click_sequence_and_system_interval(self):
        layer = pet_touch.PetTouch(Mock(), 240, 440)
        layer.hit = 42
        layer._local_css = lambda: (100, 180)
        events = []
        layer._emit = lambda event: events.append(event["type"])
        with patch.object(pet_touch, "user32") as user:
            user.GetDoubleClickTime.return_value = 840
            def release():
                layer.press = {"cx": 1}
                layer._end_press(True)
            release()
            user.SetTimer.assert_called_with(42, pet_touch.CLICK_TIMER, 840, None)
            self.assertEqual(events, [])
            layer._proc(42, pet_touch.WM_LBUTTONDBLCLK, 0, 0)
            layer._proc(42, pet_touch.WM_TIMER, pet_touch.CLICK_TIMER, 0)
            self.assertEqual(events, ["dblclick"])
            release()
            layer._proc(42, pet_touch.WM_TIMER, pet_touch.CLICK_TIMER, 0)
            self.assertEqual(events, ["dblclick", "click"])
            release()
            layer._proc(42, pet_touch.WM_APP_HIDE, 0, 0)
            layer._proc(42, pet_touch.WM_TIMER, pet_touch.CLICK_TIMER, 0)
            self.assertEqual(events, ["dblclick", "click"])

    def test_window_rect_after_touch_import(self):
        user = ctypes.windll.user32
        user.GetDesktopWindow.restype = ctypes.c_void_p
        rect = desktop._get_hwnd_rect(user.GetDesktopWindow())
        self.assertIsNotNone(rect)
        self.assertGreater(rect[2], 0)

    def test_secondary_monitor_saved_position(self):
        with tempfile.TemporaryDirectory() as temp:
            file = Path(temp) / "pet.json"
            file.write_text('{"x":-1200,"y":300}')
            with patch.object(desktop, "PET_STATE_FILE", file), patch.object(desktop, "pet_work_area", return_value=(-1920, 0, 0, 1040)):
                state = desktop.load_pet_state()
            self.assertEqual((state["x"], state["y"]), (-1200, 300))


if __name__ == "__main__":
    if sys.argv[1:2] == ["shell"]:
        sys.exit(headless_shell())
    unittest.main()
