"""讯课工作台启动器：检查工作台是否在运行，没有就在后台启动，然后打开浏览器。

用法（在 qq-workbench 目录下，或直接双击本文件）：
  python open_workbench.py               启动工作台并打开页面
  python open_workbench.py --qq          同时开启 QQ 采集（常驻），并打开扫码页
  python open_workbench.py --no-browser  只启动，不打开浏览器
  python open_workbench.py --stop        停止工作台（QQ 采集的开关状态保留）

用 pythonw 运行（pythonw open_workbench.py）不会弹出命令行窗口。
只用 Python 标准库；需要 Node.js 24 或更高版本。
"""
import argparse
import ctypes
import http.cookiejar
import json
import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
# 访问本机地址时不走系统代理，避免代理软件拦截 127.0.0.1。
LOCAL = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def owns_console():
    """双击运行时控制台只属于本进程，出错后需要停一下让人看清提示。"""
    if os.name != 'nt' or sys.stdout is None or sys.stdin is None or not sys.stdin.isatty():
        return False
    try:
        return ctypes.windll.kernel32.GetConsoleProcessList((ctypes.c_uint * 2)(), 2) == 1
    except (AttributeError, OSError):
        return False


def fail(message):
    print(message, file=sys.stderr)
    if owns_console():
        input('按回车键关闭…')
    sys.exit(1)


def read_runtime():
    """与服务、PowerShell 共用 JSON 校验及环境变量优先级。"""
    result = subprocess.run([find_node(), str(ROOT / 'scripts' / 'runtime-config.mjs')], capture_output=True,
                            text=True, encoding='utf-8', creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    if result.returncode:
        fail(result.stderr.strip() or '程序配置无效，请检查 workbench.json 和 PORT。')
    try:
        return json.loads(result.stdout)
    except ValueError:
        fail('程序配置未返回有效 JSON。')


def health(port):
    try:
        with LOCAL.open(f'http://127.0.0.1:{port}/api/health', timeout=2) as response:
            return json.load(response)
    except (urllib.error.URLError, OSError, ValueError):
        return None


def find_node():
    node = shutil.which('node')
    if not node:
        fail('没有找到 Node.js，请先安装 Node.js 24 或更高版本。')
    version = subprocess.run([node, '--version'], capture_output=True, text=True).stdout.strip()
    if int(version.lstrip('v').split('.')[0] or 0) < 24:
        fail(f'当前 Node.js 版本是 {version}，请升级到 24 或更高版本。')
    return node


def start(port, app_name):
    """通过同一个 PowerShell 启动器管理进程，避免端口与旧进程检查分叉。"""
    info = health(port)
    if info:
        if info.get('app') != app_name:
            fail(f'端口 {port} 已被其他程序占用。可以在 .env 中设置 PORT=其他端口。')
        print(f'工作台已在运行：http://127.0.0.1:{port}')
        return
    result = subprocess.run(['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
                             str(ROOT / 'start.ps1'), '-NoBrowser'], capture_output=True, text=True,
                            encoding='utf-8', errors='replace', creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    if result.returncode:
        fail(result.stderr.strip() or '工作台没有启动成功，请查看 data\\runtime-error.log。')
    info = health(port)
    if not info or info.get('app') != app_name:
        fail('工作台没有启动成功，请查看 data\\runtime-error.log。')
    print(f'工作台已启动：http://127.0.0.1:{port}')


def stop():
    """沿用 start.ps1 的停止逻辑：只结束由启动器启动、正在运行 server.mjs 的 node 进程。"""
    result = subprocess.run(['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(ROOT / 'start.ps1'), '-Stop'])
    if result.returncode != 0:
        fail('停止失败，可以改用“关闭工作台.cmd”。')


def start_qq(port):
    """统一走登录接口；遇到桌面 QQ 时不写入常驻开关、不重复启动。"""
    base = f'http://127.0.0.1:{port}'
    client = urllib.request.build_opener(urllib.request.ProxyHandler({}),
                                       urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    try:
        with client.open(base + '/qq-login', timeout=15):
            pass
        request = urllib.request.Request(base + '/api/qq/start', data=b'{}',
                                         headers={'Content-Type': 'application/json', 'Origin': base})
        with client.open(request, timeout=30) as response:
            result = json.load(response)
    except urllib.error.HTTPError as error:
        try:
            message = json.loads(error.read(8192)).get('error')
        except (ValueError, OSError):
            message = None
        fail(message or 'QQ 采集未能开启，请打开工作台查看登录状态。')
    except (urllib.error.URLError, OSError, ValueError):
        fail('QQ 采集接口暂不可用，请打开工作台查看登录状态。')
    print('QQ 采集已在线。' if result.get('online') else 'QQ 采集已开启，需要扫码时请在登录页面中确认。')


def main():
    parser = argparse.ArgumentParser(description='启动讯课 QQ 通知工作台并打开页面。')
    parser.add_argument('--qq', action='store_true', help='同时开启 QQ 采集（常驻），并打开扫码页')
    parser.add_argument('--no-browser', action='store_true', help='只启动，不打开浏览器')
    parser.add_argument('--stop', action='store_true', help='停止工作台')
    args = parser.parse_args()
    if args.stop:
        stop()
        return
    runtime = read_runtime()
    port = runtime['port']
    start(port, runtime['app'])
    if args.qq:
        start_qq(port)
    if not args.no_browser:
        webbrowser.open(f'http://127.0.0.1:{port}/qq-login' if args.qq else f'http://127.0.0.1:{port}/')


if __name__ == '__main__':
    for output_stream in (sys.stdout, sys.stderr):
        if output_stream is not None and not output_stream.isatty():
            output_stream.reconfigure(encoding='utf-8')
    main()
