"""Private local adapter for wechatauto-replica; JSON IPC only, no secret output."""
import contextlib
import io
import json
import logging
import os
import hashlib
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parent.parent
PRIVATE = Path(os.environ.get("WORKBENCH_WECHAT_DATA_DIR", ROOT / "data" / "wechat")).resolve()
PRIVATE.mkdir(parents=True, exist_ok=True)
MEDIA_READER = '--media-reader' in sys.argv
os.environ["WECHATAUTO_KEYS_DIR"] = str(PRIVATE / "keys")
logging.disable(logging.CRITICAL)
sys.stdout.reconfigure(encoding="utf-8")
sys.stdin.reconfigure(encoding="utf-8")
WIRE = sys.stdout

with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
    import psutil
    import wechatauto
    import wechatauto.db as database
    import wechatauto.guia as gui
    wechatauto.WxParam.ENABLE_FILE_LOGGER = False
    wechatauto.WxParam.DEFAULT_SAVE_PATH = str(PRIVATE / "media")
    gui.LAYOUT_CONFIG_DIR = str(PRIVATE / "layout")

OriginalDB = database.WeChatDB


class PrivateDB(OriginalDB):
    def __init__(self, *args, **kwargs):
        kwargs.setdefault("workdir", str(PRIVATE / ("decrypted-media" if MEDIA_READER else "decrypted")))
        kwargs.setdefault("keys_file", str(PRIVATE / "keys" / ("media-current.json" if MEDIA_READER else "current.json")))
        super().__init__(*args, **kwargs)

    def _stable_key_dirs(self):
        return [str(PRIVATE / "keys")]


database.WeChatDB = PrivateDB
wechat_db = None
active_pid = None
last_live_check = 0
live_proof = None
operation_submitted = False
operation_client = None


def main_process():
    candidates = []
    for proc in psutil.process_iter(["name", "pid", "ppid", "exe"]):
        try:
            if (proc.info["name"] or "").lower() != "weixin.exe":
                continue
            parent = proc.parent()
            if not parent or parent.name().lower() != "weixin.exe":
                candidates.append(proc)
        except (psutil.Error, OSError):
            continue
    return max(candidates, key=lambda process: process.memory_info().rss) if candidates else None


def connect():
    global wechat_db, active_pid, last_live_check, live_proof
    process = main_process()
    if process is None:
        wechat_db = None
        active_pid = None
        live_proof = None
        return {"available": True, "online": False, "phase": "client_closed", "error": "请正常打开并登录电脑微信"}
    if active_pid != process.pid:
        wechat_db = None
        live_proof = None
        active_pid = process.pid
        last_live_check = 0
    if time.time() - last_live_check > 15:
        # Fresh proof binds the account to the current process, rather than an old cached DB.
        live_proof = database.extract_master_key_from_cfg(process.pid)
        last_live_check = time.time()
    if not live_proof:
        wechat_db = None
        return {"available": True, "online": False, "phase": "login_unconfirmed", "error": "发现微信进程，尚未验证登录账号与数据库兼容性"}
    master_key, cfg_dword, wxid = live_proof
    if not wxid:
        return {"available": True, "online": False, "phase": "waiting_login", "error": "等待微信登录"}
    if wechat_db is None or wechat_db.wxid != wxid:
        db_root = database.auto_detect_db_dir()
        account = next((p.name for p in Path(db_root or ".").iterdir() if p.is_dir() and (p.name == wxid or p.name.startswith(wxid + "_"))), None)
        if not account:
            return {"available": True, "online": False, "phase": "database_unavailable", "error": "已识别微信登录，需要定位对应的本机聊天数据"}
        wechat_db = PrivateDB(db_dir=db_root, account=account, master_key=master_key)
        wechat_db.cfg_dword = cfg_dword
        # Open a real database before reporting ready.
        wechat_db.get_sessions(limit=1)
    profile = wechat_db.get_self_info()
    return {"available": True, "online": True, "phase": "ready", "selfId": wxid, "name": profile.get("nick_name") or wxid,
            "pid": active_pid, "version": wechatauto.__version__, "error": ""}


def require_account(expected=None):
    state = connect()
    if not state.get("online"):
        raise RuntimeError("not_ready")
    if expected and state["selfId"] != expected:
        raise RuntimeError("account_changed")
    return state


def sessions():
    state = require_account()
    result = []
    for row in wechat_db.get_sessions(limit=200):
        remote = row["username"]
        if not remote or remote.startswith("gh_"):
            continue
        result.append({"platform": "wechat", "selfId": state["selfId"], "remoteId": remote,
                       "kind": "group" if remote.endswith("@chatroom") else "private",
                       "title": wechat_db.get_nickname(remote), "unread": row.get("unread", 0), "lastTime": row.get("last_time")})
    return result


def messages(params):
    state = require_account(params.get("selfId"))
    remote = str(params.get("remoteId", ""))
    if not remote or len(remote) > 200:
        raise ValueError("bad_remote")
    rows = wechat_db.get_messages(remote, limit=min(max(int(params.get("limit", 80)), 1), 100))
    result = []
    for row in rows:
        sender = row.get("sender_username") or ""
        result.append({"platform": "wechat", "selfId": state["selfId"], "remoteId": remote,
                       "kind": "group" if remote.endswith("@chatroom") else "private", "title": wechat_db.get_nickname(remote),
                       "externalId": str(row.get("local_id", "")), "shard": row.get("shard", ""),
                       "senderId": sender, "senderName": wechat_db.get_nickname(sender) if sender else "发送者待识别",
                       "content": row.get("content") or "", "time": row.get("create_time"),
                       "messageType": row.get("type") if isinstance(row.get("type"), str) else database.MSG_TYPE_NAMES.get(row.get("type"), "未知内容"), "isSelf": sender == state["selfId"]})
    return result


def media(params):
    state = require_account(params.get("selfId"))
    remote = str(params.get("remoteId", ""))
    if remote not in {row["remoteId"] for row in sessions()}:
        raise ValueError("unknown_target")
    local_id, shard = int(params["externalId"]), str(params["shard"])
    row = wechat_db.get_message_row(remote, local_id, shard=shard)
    if not row:
        raise ValueError("unknown_message")
    from wechatauto.media import MediaDownloader
    key = hashlib.sha256(json.dumps([wechat_db.wxid, remote, shard, local_id]).encode()).hexdigest()
    folder = PRIVATE / "media" / key
    folder.mkdir(parents=True, exist_ok=True)
    # New WeChat file rows carry a subtype in the high bits. Upstream's
    # downloader expects the base type; bind its lookup to this exact row.
    base_type = int(row["local_type"]) & 0xFFFFFFFF
    if base_type not in (3, 49):
        base_type &= 0xFF
    normalized_row = {**row, "local_type": base_type}

    class ExactMediaDB:
        def __getattr__(self, name):
            return getattr(wechat_db, name)

        def get_message_row(self, user, message_id, local_type=None, shard=None):
            if user != remote or int(message_id) != local_id or shard != params["shard"]:
                return None
            return normalized_row if local_type is None or local_type == base_type else None

    downloader = MediaDownloader(ExactMediaDB(), save_dir=str(folder))
    if base_type == 3:
        aes_key, xor_key = MediaDownloader.derive_image_keys(wechat_db.cfg_dword, wechat_db.wxid)
        file = downloader.download_image(remote, local_id, save_dir=str(folder), aes_key=aes_key, xor_key=xor_key, tier="best", shard=shard)
    elif base_type == 49:
        file = downloader.download_file(remote, local_id, save_dir=str(folder), shard=shard)
    else:
        raise ValueError("unsupported_media")
    if not file and base_type == 49 and row.get("sender_username") == state["selfId"]:
        source_name = str(params.get("sourceFilename") or "")
        if source_name and len(source_name) <= 180 and source_name.encode("utf-8") in (row.get("packed_info") or b""):
            return {"sourceFilename": source_name, "externalId": str(local_id), "shard": shard}
    if not file or not Path(file).is_relative_to(folder.resolve()) or not Path(file).is_file():
        raise RuntimeError("media_not_cached")
    if Path(file).stat().st_size > 50 * 1024 * 1024:
        raise ValueError("media_too_large")
    name = downloader._file_name(normalized_row) if base_type == 49 else Path(file).name
    return {"file": str(Path(file).resolve()), "name": name or Path(file).name}


def send(params):
    global operation_client
    state = require_account(params.get("selfId"))
    remote = str(params.get("remoteId", ""))
    known = {row["remoteId"] for row in sessions()}
    if remote not in known:
        raise ValueError("unknown_target")
    title = "文件传输助手" if remote == "filehelper" else wechat_db.get_nickname(remote)
    matches = {row["username"] for row in wechat_db.search_contact(title)
               if title in (row.get("remark"), row.get("nick_name"))}
    matches.update(row["remoteId"] for row in sessions() if row["title"] == title)
    if matches - {remote}:
        raise ValueError("ambiguous_target")
    before = {(row.get("shard"), row.get("local_id")) for row in wechat_db.get_messages(remote, limit=100)}
    client = gui.WeChatGUI()
    operation_client = client
    client._cached_db = wechat_db
    uia = client._get_uia()
    if uia is None:
        raise RuntimeError("target_verification_unavailable")
    # Reuse upstream navigation and input; require an exact visible chat title.
    original_open = uia.open_chat
    uia.open_chat = lambda name: bool(original_open(name) and uia.current_chat() == title)
    client._chat_is_open = lambda name: uia.current_chat() == title
    client._chat_open_confirmed = lambda name: uia.current_chat() == title
    # Upstream pixel fallback can miss the actual input after a window resize.
    # Reuse its UIA control, so attachments are pasted into the verified chat input.
    def focus_input(box=None):
        if uia.current_chat() != title:
            return False
        control = uia._chat_input()
        if control is None:
            return False
        uia._click_ctrl(control)
        control.SetFocus()
        return True

    client.focus_input = focus_input
    def ensure_visible(keep_topmost=False):
        client.bring_to_front(keep_topmost=False)
        client._update_render_rect()
        return client.is_alive()

    client.ensure_visible = ensure_visible
    attempts = [0]

    def guard():
        global operation_submitted
        require_account(state["selfId"])
        if uia.current_chat() != title or attempts[0]:
            raise RuntimeError("send_target_changed_or_already_attempted")
        attempts[0] += 1
        operation_submitted = True

    original_send = uia.send_text

    def send_text(content):
        guard()
        if not original_send(content):
            raise RuntimeError("send_uncertain")
        return True

    uia.send_text = send_text
    original_key = client._input.key

    def key(code, *args, **kwargs):
        if code == gui.VK_RETURN:
            guard()
        return original_key(code, *args, **kwargs)

    client._input.key = key
    kind = params.get("type", "text")
    # The adapter binds this display name to the exact local account and conversation.
    if kind == "text":
        content = str(params.get("text", ""))
        if not content.strip() or len(content) > 6000:
            raise ValueError("bad_text")
        result = client.send_msg(content, title, verify=False)
    else:
        file = Path(params.get("file", "")).resolve()
        uploads = (ROOT / "data" / "uploads").resolve()
        if not file.is_relative_to(uploads) or not file.is_file():
            raise ValueError("bad_file")
        fn = client.send_image if kind == "image" else client.send_file
        result = fn(str(file), title, verify=False)
    confirmed = False
    if result.is_success or attempts[0]:
        # Confirm new rows in this exact account and conversation, not fuzzy contact search.
        for _ in range(10):
            for row in wechat_db.get_messages(remote, limit=100):
                if (row.get("shard"), row.get("local_id")) in before or row.get("sender_username") != state["selfId"]:
                    continue
                msg_type = row.get("type")
                file_matches = kind == "file" and file.name in (row.get("content") or "")
                if kind == "file" and not file_matches:
                    raw = wechat_db.get_message_row(remote, row["local_id"], shard=row.get("shard")) or {}
                    file_matches = file.name.encode("utf-8") in (raw.get("packed_info") or b"")
                if (kind == "text" and msg_type == "文本" and row.get("content") == content
                        or kind == "image" and msg_type == "图片"
                        or kind == "file" and msg_type == "文件/链接/卡片" and file_matches):
                    confirmed = True
                    break
            if confirmed:
                break
            time.sleep(1)
    return {"status": "sent" if confirmed else "uncertain", "confirmed": confirmed, "selfId": state["selfId"],
            "code": "verified" if confirmed else "awaiting_database" if attempts[0] else "ui_incomplete"}


def handle(action, params):
    if action == "status":
        return connect()
    if action == "sessions":
        return sessions()
    if action == "messages":
        return messages(params)
    if action == "media":
        return media(params)
    if action == "send":
        return send(params)
    raise ValueError("unsupported_action")


def safe_call(action, params):
    global operation_submitted, operation_client
    operation_submitted = False
    operation_client = None
    try:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return {"ok": True, "data": handle(action, params)}
    except Exception as error:
        # Exception values may contain SDK credentials or message text; never expose them.
        known = {"not_ready", "account_changed", "ambiguous_target", "unknown_target", "bad_file", "bad_text",
                 "target_verification_unavailable", "send_target_changed_or_already_attempted", "send_uncertain",
                 "unknown_message", "unsupported_media", "media_not_cached", "media_too_large"}
        code = str(error) if str(error) in known else type(error).__name__
        messages = {"not_ready": "微信尚未登录，请正常登录后重试", "account_changed": "当前微信账号已改变，请重新选择会话",
                    "ambiguous_target": "发现同名会话，无法确认发送对象；请在微信中设置不同备注后重试",
                    "unknown_target": "会话不属于当前微信账号，请刷新会话",
                    "target_verification_unavailable": "未能识别微信聊天窗口，请保持电脑解锁并打开微信",
                    "send_target_changed_or_already_attempted": "发送目标或状态发生变化，请先查看微信记录",
                    "send_uncertain": "操作结果未确认，请先查看微信记录",
                    "media_not_cached": "本机没有这个附件，请先在微信中下载后重试",
                    "media_too_large": "本机附件超过 50 MB，请在微信客户端查看",
                    "unsupported_media": "这条消息没有可读取的图片或文件"}
        return {"ok": False, "code": code, "attempted": operation_submitted if action == "send" else None,
                "error": messages.get(code, "微信操作尚未完成，请检查登录、客户端版本和桌面解锁状态")}
    finally:
        if action == "send" and operation_client is not None:
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                try:
                    operation_client.release_foreground(with_blockers=True)
                except Exception:
                    pass


if "--probe" in sys.argv:
    status = safe_call("status", {})
    safe = status.get("data", {})
    report = {"ok": status["ok"], "online": safe.get("online", False), "phase": safe.get("phase"), "error": safe.get("error") or status.get("error")}
    if report["online"]:
        read = safe_call("messages", {"selfId": safe["selfId"], "remoteId": "filehelper", "limit": 3})
        report["sampleCount"] = len(read.get("data", []))
    print(json.dumps(report, ensure_ascii=False), file=WIRE, flush=True)
else:
    for line in sys.stdin:
        try:
            request = json.loads(line)
            response = safe_call(request.get("action"), request.get("params") or {})
            response["id"] = request.get("id")
            print(json.dumps(response, ensure_ascii=False), file=WIRE, flush=True)
        except (ValueError, TypeError):
            print(json.dumps({"ok": False, "code": "bad_request", "error": "无效的本机请求"}), file=WIRE, flush=True)
