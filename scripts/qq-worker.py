"""Private local read-only adapter for desktop QQNT (9.9+); JSON IPC only, no secret output."""
from __future__ import annotations

import collections
import ctypes
import ctypes.wintypes as wt
import gc
import hashlib
import hmac
import json
import os
import re
import shutil
import sqlite3
import struct
import sys
import time
from pathlib import Path

import psutil
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

ROOT = Path(__file__).resolve().parent.parent
PRIVATE = Path(os.environ.get("WORKBENCH_QQ_DATA_DIR", ROOT / "data" / "qq-local")).resolve()
KEYS_DIR = PRIVATE / "keys"
DECRYPTED_DIR = PRIVATE / "decrypted"
PRIVATE.mkdir(parents=True, exist_ok=True)
KEYS_DIR.mkdir(parents=True, exist_ok=True)
DECRYPTED_DIR.mkdir(parents=True, exist_ok=True)

sys.stdout.reconfigure(encoding="utf-8")
sys.stdin.reconfigure(encoding="utf-8")
WIRE = sys.stdout

QQ_HEADER_SKIP = 1024
PAGE_SIZE = 4096
RESERVE_SIZE = 48
TARGET_DBS = ("nt_msg.db", "group_info.db", "profile_info.db")

_k32 = ctypes.WinDLL("kernel32", use_last_error=True)


class _MBI(ctypes.Structure):
    _fields_ = [
        ("BaseAddress", ctypes.c_void_p),
        ("AllocationBase", ctypes.c_void_p),
        ("AllocationProtect", wt.DWORD),
        ("__align1", wt.DWORD),
        ("RegionSize", ctypes.c_size_t),
        ("State", wt.DWORD),
        ("Protect", wt.DWORD),
        ("Type", wt.DWORD),
        ("__align2", wt.DWORD),
    ]


_k32.VirtualQueryEx.argtypes = [wt.HANDLE, ctypes.c_void_p, ctypes.POINTER(_MBI), ctypes.c_size_t]
_k32.VirtualQueryEx.restype = ctypes.c_size_t
_k32.ReadProcessMemory.argtypes = [
    wt.HANDLE,
    ctypes.c_void_p,
    ctypes.c_void_p,
    ctypes.c_size_t,
    ctypes.POINTER(ctypes.c_size_t),
]
_k32.ReadProcessMemory.restype = wt.BOOL


def verify_page1_key(enc_key: bytes, page1: bytes) -> bool:
    if len(enc_key) != 32 or len(page1) != PAGE_SIZE:
        return False
    salt = page1[:16]
    mac_salt = bytes(b ^ 0x3A for b in salt)
    mac_key = hashlib.pbkdf2_hmac("sha512", enc_key, mac_salt, 2, 32)
    payload_end = PAGE_SIZE - RESERVE_SIZE
    stored_mac = page1[payload_end + 16 : payload_end + 36]
    calc = hmac.new(mac_key, page1[16 : payload_end + 16] + struct.pack("<I", 1), "sha1").digest()
    return hmac.compare_digest(calc, stored_mac)


def decrypt_page(enc_key: bytes, page: bytes, pgno: int) -> bytes:
    iv = page[PAGE_SIZE - RESERVE_SIZE : PAGE_SIZE - RESERVE_SIZE + 16]
    cipher = Cipher(algorithms.AES(enc_key), modes.CBC(iv)).decryptor()
    if pgno == 1:
        dec = cipher.update(page[16 : PAGE_SIZE - RESERVE_SIZE]) + cipher.finalize()
        return b"SQLite format 3\x00" + dec + b"\x00" * RESERVE_SIZE
    dec = cipher.update(page[0 : PAGE_SIZE - RESERVE_SIZE]) + cipher.finalize()
    return dec + b"\x00" * RESERVE_SIZE


def find_live_qq():
    """Find running desktop QQ.exe process and active logged-in account via open nt_db file handles."""
    qq_procs = []
    for proc in psutil.process_iter(["name", "pid", "ppid", "exe"]):
        try:
            if (proc.info["name"] or "").lower() != "qq.exe":
                continue
            qq_procs.append(proc)
        except (psutil.Error, OSError):
            continue
    if not qq_procs:
        return None, None, None, False

    # 主进程通常没有同名父进程或内存占比最高，优先检查主进程以减少无谓的句柄枚举。
    def proc_priority(p):
        try:
            parent = p.parent()
            is_root = 0 if (not parent or (parent.name() or "").lower() != "qq.exe") else 1
            return (is_root, -p.memory_info().rss)
        except (psutil.Error, OSError):
            return (1, 0)

    access_denied = False
    for proc in sorted(qq_procs, key=proc_priority):
        try:
            files = proc.open_files()
        except (psutil.AccessDenied, PermissionError):
            access_denied = True
            continue
        except (psutil.Error, OSError):
            continue
        counts = collections.Counter()
        for item in files:
            p = Path(item.path)
            parts = p.parts
            lower = [part.lower() for part in parts]
            if "nt_db" not in lower:
                continue
            idx = lower.index("nt_db")
            if idx < 3 or lower[idx - 1] != "nt_qq":
                continue
            uin = parts[idx - 2]
            if not re.fullmatch(r"\d{5,15}", uin):
                continue
            db_dir = Path(*parts[: idx + 1])
            if (db_dir / "nt_msg.db").is_file():
                counts[(uin, str(db_dir))] += 1
        if counts:
            (uin, db_dir_str), _ = counts.most_common(1)[0]
            return proc, uin, Path(db_dir_str), False
    return qq_procs[0], None, None, access_denied


class QQNTDB:
    """Read-only decrypted cache & incremental WAL merger for QQNT SQLCipher databases."""

    def __init__(self, pid: int, uin: str, db_dir: Path):
        self.pid = pid
        self.uin = uin
        self.db_dir = db_dir
        self.keys_file = KEYS_DIR / f"{uin}.json"
        self.workdir = DECRYPTED_DIR / uin
        self.workdir.mkdir(parents=True, exist_ok=True)
        self.keys: dict[str, bytes] = {}
        self._self_name_cache: str = ""
        self._self_name_at: float = 0.0
        self._load_or_extract_keys()

    def _read_page1(self, name: str) -> bytes | None:
        src = self.db_dir / name
        if not src.is_file() or src.stat().st_size < QQ_HEADER_SKIP + PAGE_SIZE:
            return None
        with open(src, "rb") as f:
            f.seek(QQ_HEADER_SKIP)
            data = f.read(PAGE_SIZE)
        return data if len(data) == PAGE_SIZE else None

    def _load_or_extract_keys(self) -> None:
        page1s: dict[str, bytes] = {}
        for name in TARGET_DBS:
            p1 = self._read_page1(name)
            if p1 is not None:
                page1s[name] = p1

        if self.keys_file.is_file():
            try:
                cached = json.loads(self.keys_file.read_text(encoding="utf-8"))
                for name, hex_key in cached.items():
                    if name in page1s and isinstance(hex_key, str) and len(hex_key) == 64:
                        raw = bytes.fromhex(hex_key)
                        if verify_page1_key(raw, page1s[name]):
                            self.keys[name] = raw
            except Exception:
                pass

        missing = [name for name in page1s if name not in self.keys]
        if missing:
            extracted = self._scan_process_memory(missing, page1s)
            self.keys.update(extracted)
            if self.keys:
                tmp = self.keys_file.with_suffix(".tmp")
                tmp.write_text(
                    json.dumps({k: v.hex() for k, v in self.keys.items()}, ensure_ascii=False),
                    encoding="utf-8",
                )
                os.replace(tmp, self.keys_file)

    def _scan_process_memory(self, names: list[str], page1s: dict[str, bytes]) -> dict[str, bytes]:
        salts = {
            name: (page1s[name][:16].hex().encode("ascii"), page1s[name][:16].hex().upper().encode("ascii"))
            for name in names
        }
        found: dict[str, bytes] = {}
        h = _k32.OpenProcess(0x0010 | 0x0400, False, self.pid)
        if not h:
            return found
        try:
            addr = 0
            mbi = _MBI()
            while addr < 0x7FFFFFFFFFFF and len(found) < len(names):
                if not _k32.VirtualQueryEx(h, ctypes.c_void_p(addr), ctypes.byref(mbi), ctypes.sizeof(mbi)):
                    break
                nxt = (mbi.BaseAddress or 0) + mbi.RegionSize
                if nxt <= addr:
                    break
                if (
                    mbi.State == 0x1000
                    and (mbi.Protect & 0x04)
                    and not (mbi.Protect & 0x100)
                    and mbi.RegionSize <= 64 * 1024 * 1024
                ):
                    buf = (ctypes.c_char * mbi.RegionSize)()
                    br = ctypes.c_size_t(0)
                    if _k32.ReadProcessMemory(h, ctypes.c_void_p(mbi.BaseAddress), buf, mbi.RegionSize, ctypes.byref(br)) and br.value:
                        data = buf.raw[: br.value]
                        for name in names:
                            if name in found:
                                continue
                            for sh in salts[name]:
                                idx = 0
                                while True:
                                    pos = data.find(sh, idx)
                                    if pos < 0:
                                        break
                                    if pos >= 64:
                                        try:
                                            cand = bytes.fromhex(data[pos - 64 : pos].decode("ascii"))
                                            if verify_page1_key(cand, page1s[name]):
                                                found[name] = cand
                                                break
                                        except Exception:
                                            pass
                                    idx = pos + 32
                                if name in found:
                                    break
                addr = nxt
        finally:
            _k32.CloseHandle(h)
        return found

    def _check_sqlite_fast(self, path: Path) -> bool:
        try:
            conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
            try:
                conn.execute("SELECT COUNT(*) FROM sqlite_master").fetchone()
                return True
            finally:
                conn.close()
        except Exception:
            return False

    def _check_sqlite(self, path: Path) -> bool:
        try:
            conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
            try:
                row = conn.execute("PRAGMA quick_check(1)").fetchone()
                return bool(row and row[0] == "ok")
            finally:
                conn.close()
        except Exception:
            return False

    def _decrypt_base(self, src: Path, enc_key: bytes, dst: Path) -> None:
        with open(src, "rb") as fin, open(dst, "wb") as fout:
            fin.seek(QQ_HEADER_SKIP)
            pgno = 1
            while True:
                page = fin.read(PAGE_SIZE)
                if len(page) < PAGE_SIZE:
                    break
                fout.write(decrypt_page(enc_key, page, pgno))
                pgno += 1

    def _read_wal_header(self, wal_path: Path):
        if not wal_path.is_file() or wal_path.stat().st_size < 32:
            return None
        with open(wal_path, "rb") as f:
            hdr = f.read(32)
        if len(hdr) < 32:
            return None
        magic, fmt, pg_sz, ckpt, s1, s2 = struct.unpack(">IIIIII", hdr[:24])
        if magic not in (0x377F0682, 0x377F0683) or pg_sz != PAGE_SIZE:
            return None
        return (s1, s2, ckpt)

    def _apply_wal_frames(self, target_db: Path, wal_path: Path, enc_key: bytes, start_frame: int = 0) -> tuple[int, int, int]:
        """Decrypt and apply committed WAL frames from start_frame onwards into target_db."""
        meta = self._read_wal_header(wal_path)
        if not meta:
            return (0, 0, start_frame)
        s1, s2, _ = meta
        frame_sz = 24 + PAGE_SIZE
        file_size = wal_path.stat().st_size
        total_frames = (file_size - 32) // frame_sz
        if total_frames <= start_frame:
            return (s1, s2, start_frame)

        pending_pages: list[tuple[int, bytes]] = []
        committed_batches: list[tuple[int, list[tuple[int, bytes]]]] = []
        last_committed = start_frame

        with open(wal_path, "rb") as wf:
            wf.seek(32 + start_frame * frame_sz)
            for idx in range(start_frame, total_frames):
                fhdr = wf.read(24)
                page = wf.read(PAGE_SIZE)
                if len(fhdr) < 24 or len(page) < PAGE_SIZE:
                    break
                pgno, db_size, fs1, fs2 = struct.unpack(">IIII", fhdr[:16])
                if fs1 != s1 or fs2 != s2 or pgno < 1:
                    break
                pending_pages.append((pgno, decrypt_page(enc_key, page, pgno)))
                if db_size > 0:
                    committed_batches.append((db_size, pending_pages))
                    pending_pages = []
                    last_committed = idx + 1

        if committed_batches:
            with open(target_db, "r+b") as df:
                for db_size, batch in committed_batches:
                    for pgno, dec in batch:
                        df.seek((pgno - 1) * PAGE_SIZE)
                        df.write(dec)
                    if db_size > 0:
                        df.truncate(db_size * PAGE_SIZE)
        return (s1, s2, last_committed)

    def _ensure_decrypted(self, name: str) -> Path:
        if name not in self.keys:
            self._load_or_extract_keys()
        if name not in self.keys:
            raise RuntimeError("key_unavailable")
        enc_key = self.keys[name]
        src = self.db_dir / name
        wal = self.db_dir / f"{name}-wal"
        dst = self.workdir / name
        stamp_file = self.workdir / f"{name}.stamp.json"

        src_stat = src.stat()
        wal_stat = wal.stat() if wal.is_file() else None
        wal_meta = self._read_wal_header(wal) if wal_stat else None
        wal_s1 = wal_meta[0] if wal_meta else 0
        wal_s2 = wal_meta[1] if wal_meta else 0

        old = None
        if dst.is_file() and stamp_file.is_file():
            try:
                old = json.loads(stamp_file.read_text(encoding="utf-8"))
            except Exception:
                old = None

        src_same = bool(
            old
            and old.get("src_mtime") == src_stat.st_mtime_ns
            and old.get("src_size") == src_stat.st_size
        )
        wal_same = bool(
            old
            and old.get("wal_mtime") == (wal_stat.st_mtime_ns if wal_stat else 0)
            and old.get("wal_size") == (wal_stat.st_size if wal_stat else 0)
        )
        if src_same and wal_same:
            return dst

        # Fast path: main DB unchanged and WAL grew under the same salt -> patch only new WAL frames in-place (<10ms)!
        if (
            src_same
            and wal_stat
            and old.get("wal_s1") == wal_s1
            and old.get("wal_s2") == wal_s2
            and wal_stat.st_size >= old.get("wal_size", 0)
        ):
            applied = int(old.get("wal_frames", 0))
            try:
                s1, s2, new_applied = self._apply_wal_frames(dst, wal, enc_key, applied)
                if new_applied == applied or self._check_sqlite_fast(dst):
                    stamp_file.write_text(
                        json.dumps({
                            "src_mtime": src_stat.st_mtime_ns,
                            "src_size": src_stat.st_size,
                            "wal_mtime": wal_stat.st_mtime_ns,
                            "wal_size": wal_stat.st_size,
                            "wal_s1": s1,
                            "wal_s2": s2,
                            "wal_frames": new_applied,
                        }),
                        encoding="utf-8",
                    )
                    return dst
            except Exception:
                pass

        # Full base decrypt + full WAL merge (runs on first open or after QQ checkpoint)
        tmp = self.workdir / f"{name}.{os.getpid()}.tmp"
        try:
            ok = False
            for _ in range(3):
                self._decrypt_base(src, enc_key, tmp)
                if self._check_sqlite(tmp):
                    ok = True
                    break
                time.sleep(0.25)
            if not ok:
                if dst.is_file() and self._check_sqlite(dst):
                    return dst
                raise RuntimeError("db_decrypt_busy")

            applied_frames = 0
            s1, s2 = 0, 0
            if wal_stat and wal_stat.st_size > 32:
                tmp_wal = self.workdir / f"{name}.{os.getpid()}.wal.tmp"
                try:
                    shutil.copyfile(tmp, tmp_wal)
                    s1, s2, applied_frames = self._apply_wal_frames(tmp_wal, wal, enc_key, 0)
                    if self._check_sqlite(tmp_wal):
                        os.replace(tmp_wal, tmp)
                except Exception:
                    applied_frames = 0
                finally:
                    tmp_wal.unlink(missing_ok=True)

            self._safe_replace(tmp, dst)
            stamp_file.write_text(
                json.dumps({
                    "src_mtime": src_stat.st_mtime_ns,
                    "src_size": src_stat.st_size,
                    "wal_mtime": wal_stat.st_mtime_ns if wal_stat else 0,
                    "wal_size": wal_stat.st_size if wal_stat else 0,
                    "wal_s1": s1,
                    "wal_s2": s2,
                    "wal_frames": applied_frames,
                }),
                encoding="utf-8",
            )
            return dst
        finally:
            tmp.unlink(missing_ok=True)

    def _safe_replace(self, src: Path, dst: Path) -> None:
        last_err = None
        for delay in (0.12, 0.25, 0.45):
            try:
                os.replace(src, dst)
                return
            except PermissionError as err:
                last_err = err
                gc.collect()
                time.sleep(delay)
        try:
            os.replace(src, dst)
        except PermissionError:
            if dst.is_file() and self._check_sqlite(dst):
                return
            raise last_err

    def open_ro(self, name: str) -> sqlite3.Connection:
        path = self._ensure_decrypted(name)
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
        return conn

    def self_name(self) -> str:
        now = time.time()
        if self._self_name_cache and now - self._self_name_at < 60:
            return self._self_name_cache
        try:
            conn = self.open_ro("profile_info.db")
            try:
                row = conn.execute('SELECT "20002" FROM profile_info_v6 WHERE "1002"=? LIMIT 1', (int(self.uin),)).fetchone()
                if row and row[0]:
                    self._self_name_cache = str(row[0])
                    self._self_name_at = now
                    return self._self_name_cache
            finally:
                conn.close()
        except Exception:
            pass
        return self.uin

    def groups(self) -> list[dict]:
        conn = self.open_ro("group_info.db")
        try:
            rows = conn.execute('SELECT "60001" AS gid, "60007" AS name, "60006" AS members FROM group_list').fetchall()
            out = []
            seen = set()
            for r in rows:
                gid = str(r["gid"] or "").strip()
                if not gid or gid in seen:
                    continue
                seen.add(gid)
                out.append({
                    "groupId": gid,
                    "name": str(r["name"] or gid)[:100],
                    "memberCount": int(r["members"]) if r["members"] else None,
                })
            return out
        finally:
            conn.close()

    def group_names_map(self) -> dict[str, str]:
        try:
            return {g["groupId"]: g["name"] for g in self.groups()}
        except Exception:
            return {}

    def uid_to_profile(self) -> dict[str, tuple[str, str]]:
        """Map nt_uid -> (uin_str, display_name) from profile_info.db."""
        out: dict[str, tuple[str, str]] = {}
        try:
            conn = self.open_ro("profile_info.db")
            try:
                for r in conn.execute('SELECT "1000" AS uid, "1002" AS uin, "20002" AS nick, "20009" AS remark FROM profile_info_v6').fetchall():
                    uid = str(r["uid"] or "")
                    uin = str(r["uin"] or "")
                    name = str(r["remark"] or r["nick"] or uin or uid)[:100]
                    if uid:
                        out[uid] = (uin, name)
            finally:
                conn.close()
        except Exception:
            pass
        return out

    def recent_sessions(self, limit: int = 200) -> list[dict]:
        gnames = self.group_names_map()
        profiles = self.uid_to_profile()
        conn = self.open_ro("nt_msg.db")
        try:
            rows = conn.execute(
                'SELECT "40010" AS chat_type, "40021" AS peer_id, "40020" AS peer_uid, "40094" AS peer_name, "40050" AS ts '
                'FROM recent_contact_v3_table ORDER BY "40050" DESC LIMIT ?',
                (min(max(int(limit), 1), 300),),
            ).fetchall()
            result = []
            seen = set()
            for r in rows:
                ct = int(r["chat_type"] or 0)
                if ct == 2:
                    gid = str(r["peer_id"] or "").strip()
                    if not re.fullmatch(r"\d{5,20}", gid):
                        continue
                    key = ("group", gid)
                    if key in seen:
                        continue
                    seen.add(key)
                    title = str(r["peer_name"] or gnames.get(gid) or f"QQ群 {gid}")[:100]
                    result.append({
                        "platform": "qq",
                        "selfId": self.uin,
                        "remoteId": gid,
                        "kind": "group",
                        "title": title,
                        "lastTime": int(r["ts"] or 0),
                    })
                elif ct == 1:
                    uid = str(r["peer_id"] or r["peer_uid"] or "").strip()
                    uin, pname = profiles.get(uid, ("", ""))
                    remote = uin if re.fullmatch(r"\d{5,20}", uin) else ""
                    if not remote:
                        continue
                    key = ("private", remote)
                    if key in seen:
                        continue
                    seen.add(key)
                    title = str(r["peer_name"] or pname or f"好友 {remote}")[:100]
                    result.append({
                        "platform": "qq",
                        "selfId": self.uin,
                        "remoteId": remote,
                        "kind": "private",
                        "title": title,
                        "lastTime": int(r["ts"] or 0),
                    })
            return result
        finally:
            conn.close()

    def messages(self, remote_id: str, kind: str = "group", limit: int = 80) -> list[dict]:
        limit = min(max(int(limit), 1), 200)
        gnames = self.group_names_map() if kind == "group" else {}
        conn = self.open_ro("nt_msg.db")
        try:
            if kind == "group":
                gid_int = int(remote_id)
                rows = conn.execute(
                    'SELECT "40001" AS mid, "40003" AS seq, "40033" AS sender_uin, "40090" AS card, "40093" AS nick, '
                    '"40050" AS ts, "40800" AS pb FROM group_msg_table WHERE "40027"=? ORDER BY "40050" DESC, "40003" DESC LIMIT ?',
                    (gid_int, limit),
                ).fetchall()
                title = gnames.get(str(remote_id), f"QQ群 {remote_id}")
                out = []
                for r in reversed(rows):
                    content = decode_qq_message_pb(r["pb"])
                    if not content:
                        continue
                    sender_uin = str(r["sender_uin"] or "0")
                    sender_name = str(r["card"] or r["nick"] or sender_uin)[:100]
                    out.append({
                        "platform": "qq",
                        "selfId": self.uin,
                        "remoteId": str(remote_id),
                        "kind": "group",
                        "title": title,
                        "externalId": str(r["mid"]),
                        "groupSeq": str(r["seq"]) if r["seq"] is not None else None,
                        "senderId": sender_uin,
                        "senderName": sender_name,
                        "content": content,
                        "time": int(r["ts"] or 0),
                        "isSelf": sender_uin == self.uin,
                    })
                return out
            else:
                # Private chat by peer UIN
                peer_int = int(remote_id)
                rows = conn.execute(
                    'SELECT "40001" AS mid, "40003" AS seq, "40033" AS sender_uin, "40090" AS card, "40093" AS nick, '
                    '"40050" AS ts, "40800" AS pb FROM c2c_msg_table WHERE "40030"=? ORDER BY "40050" DESC, "40001" DESC LIMIT ?',
                    (peer_int, limit),
                ).fetchall()
                out = []
                for r in reversed(rows):
                    content = decode_qq_message_pb(r["pb"])
                    if not content:
                        continue
                    sender_uin = str(r["sender_uin"] or "0")
                    sender_name = str(r["card"] or r["nick"] or sender_uin)[:100]
                    out.append({
                        "platform": "qq",
                        "selfId": self.uin,
                        "remoteId": str(remote_id),
                        "kind": "private",
                        "title": sender_name if sender_uin != self.uin else f"好友 {remote_id}",
                        "externalId": str(r["mid"]),
                        "groupSeq": None,
                        "senderId": sender_uin,
                        "senderName": sender_name,
                        "content": content,
                        "time": int(r["ts"] or 0),
                        "isSelf": sender_uin == self.uin,
                    })
                return out
        finally:
            conn.close()


def _parse_pb(buf: bytes) -> list[tuple[int, int, object]]:
    out = []
    if not buf:
        return out
    i, n = 0, len(buf)
    while i < n:
        tag = 0
        shift = 0
        while i < n:
            b = buf[i]
            i += 1
            tag |= (b & 0x7F) << shift
            if not (b & 0x80):
                break
            shift += 7
            if shift > 63:
                return out
        field = tag >> 3
        wt_ = tag & 7
        if wt_ == 0:
            val = 0
            shift = 0
            while i < n:
                b = buf[i]
                i += 1
                val |= (b & 0x7F) << shift
                if not (b & 0x80):
                    break
                shift += 7
                if shift > 63:
                    return out
            out.append((field, 0, val))
        elif wt_ == 2:
            ln = 0
            shift = 0
            while i < n:
                b = buf[i]
                i += 1
                ln |= (b & 0x7F) << shift
                if not (b & 0x80):
                    break
                shift += 7
                if shift > 63:
                    return out
            if i + ln > n:
                return out
            out.append((field, 2, buf[i : i + ln]))
            i += ln
        elif wt_ == 5:
            if i + 4 > n:
                return out
            out.append((field, 5, buf[i : i + 4]))
            i += 4
        elif wt_ == 1:
            if i + 8 > n:
                return out
            out.append((field, 1, buf[i : i + 8]))
            i += 8
        else:
            break
    return out


def decode_qq_message_pb(blob: bytes | None) -> str:
    """Extract clean readable text & media placeholders from QQNT column 40800 protobuf."""
    if not blob:
        return ""
    parts: list[str] = []
    for fno, wt_, val in _parse_pb(blob):
        if fno != 40800 or wt_ != 2 or not isinstance(val, bytes):
            continue
        sub = _parse_pb(val)
        etype = None
        fields: dict[int, bytes] = {}
        for sf, sw, sv in sub:
            if sf == 45002 and sw == 0:
                etype = int(sv)
            elif sw == 2 and isinstance(sv, bytes):
                fields[sf] = sv
        if etype == 1:
            txt = fields.get(45101, b"").decode("utf-8", "ignore")
            if txt:
                parts.append(txt)
        elif etype == 2:
            parts.append("[图片：尚未识别]")
        elif etype == 3:
            fname = (fields.get(45402) or fields.get(45701) or b"").decode("utf-8", "ignore").strip()[:120]
            parts.append(f"[文件：{fname or '附件'}，尚未解析]")
        elif etype == 4:
            parts.append("[语音：尚未转写]")
        elif etype == 5:
            parts.append("[视频：尚未解析]")
        elif etype == 6:
            parts.append("[表情]")
        elif etype == 7:
            parts.append("[回复前文]")
        elif etype == 10:
            # Ark / Card JSON: try to extract human-readable prompt/title/desc
            card_text = ""
            for raw_b in fields.values():
                s = raw_b.decode("utf-8", "ignore").strip()
                if s.startswith("{") and s.endswith("}"):
                    try:
                        obj = json.loads(s)
                        card_text = obj.get("prompt") or obj.get("desc") or ""
                        if not card_text and isinstance(obj.get("meta"), dict):
                            for mv in obj["meta"].values():
                                if isinstance(mv, dict):
                                    card_text = mv.get("title") or mv.get("desc") or mv.get("tag") or ""
                                    if card_text:
                                        break
                        if card_text:
                            break
                    except Exception:
                        pass
            parts.append(f"[卡片：{card_text[:200]}]" if card_text else "[卡片：尚未解析]")
        elif etype == 16:
            parts.append("[合并转发：尚未展开]")
        elif etype is not None:
            parts.append("[非文字内容：尚未解析]")
    return "".join(parts).strip()[:12000]


qq_db: QQNTDB | None = None
active_pid: int | None = None
last_check: float = 0.0
last_live: tuple[int | None, str | None, Path | None, bool] = (None, None, None, False)


def connect() -> dict:
    global qq_db, active_pid, last_check, last_live
    now = time.time()
    if now - last_check > 5 or last_live[1] is None:
        proc, uin, db_dir, denied = find_live_qq()
        last_live = (proc.pid if proc else None, uin, db_dir, denied)
        last_check = now
    pid, uin, db_dir, denied = last_live
    if pid is None:
        qq_db = None
        active_pid = None
        return {"available": True, "online": False, "mode": "local", "phase": "client_closed", "error": "请正常打开并登录电脑 QQ"}
    if not uin or not db_dir:
        qq_db = None
        active_pid = pid
        if denied:
            return {"available": True, "online": False, "mode": "local", "phase": "login_unconfirmed", "error": "发现电脑 QQ，但暂无权限读取进程状态"}
        return {"available": True, "online": False, "mode": "local", "phase": "waiting_login", "error": "等待电脑 QQ 登录"}
    if qq_db is None or qq_db.uin != uin or qq_db.db_dir != db_dir or active_pid != pid:
        active_pid = pid
        qq_db = QQNTDB(pid, uin, db_dir)
        if "nt_msg.db" not in qq_db.keys:
            qq_db = None
            return {"available": True, "online": False, "mode": "local", "phase": "key_unavailable", "error": "已识别桌面 QQ，暂未读取到本机数据库密钥，请稍候重试"}
        # Verify real DB read before reporting ready
        qq_db.groups()
    return {
        "available": True,
        "online": True,
        "mode": "local",
        "phase": "ready",
        "selfId": qq_db.uin,
        "name": qq_db.self_name(),
        "pid": active_pid,
        "error": "",
    }


def require_account(expected: str | None = None) -> dict:
    state = connect()
    if not state.get("online"):
        raise RuntimeError("not_ready")
    if expected and str(state["selfId"]) != str(expected):
        raise RuntimeError("account_changed")
    return state


def handle(action: str, params: dict):
    if action == "status":
        return connect()
    if action == "groups":
        require_account()
        return qq_db.groups()
    if action == "sessions":
        require_account()
        return qq_db.recent_sessions(limit=int(params.get("limit", 200)))
    if action == "active_groups":
        require_account()
        return [s for s in qq_db.recent_sessions(limit=80) if s["kind"] == "group"]
    if action == "messages":
        require_account(params.get("selfId"))
        remote = str(params.get("remoteId", "")).strip()
        if not re.fullmatch(r"\d{5,20}", remote):
            raise ValueError("bad_remote")
        kind = "private" if params.get("kind") == "private" else "group"
        return qq_db.messages(remote, kind=kind, limit=int(params.get("limit", 80)))
    raise ValueError("unsupported_action")


def safe_call(action: str, params: dict) -> dict:
    try:
        return {"ok": True, "data": handle(action, params)}
    except Exception as error:
        known = {"not_ready", "account_changed", "bad_remote", "key_unavailable", "db_decrypt_busy"}
        code = str(error) if str(error) in known else type(error).__name__
        msgs = {
            "not_ready": "桌面 QQ 尚未登录，请正常登录后重试",
            "account_changed": "当前 QQ 账号已改变，请重新选择会话",
            "bad_remote": "QQ 会话编号格式不正确",
            "key_unavailable": "暂未能读取 QQ 本地数据库密钥，请确认电脑 QQ 已登录",
            "db_decrypt_busy": "QQ 本地数据库正在写入，稍后会自动重试",
        }
        return {"ok": False, "code": code, "error": msgs.get(code, "QQ 本地读取暂未完成，稍后会自动重试")}


if "--probe" in sys.argv:
    st = safe_call("status", {})
    data = st.get("data", {})
    report = {"ok": st["ok"], "online": data.get("online", False), "phase": data.get("phase"), "selfId": data.get("selfId"), "name": data.get("name"), "error": data.get("error") or st.get("error")}
    if report["online"]:
        gr = safe_call("groups", {})
        ss = safe_call("sessions", {"limit": 20})
        report["groupCount"] = len(gr.get("data", []))
        report["recentCount"] = len(ss.get("data", []))
        if gr.get("data"):
            sample_gid = "1007615288" if any(g["groupId"] == "1007615288" for g in gr["data"]) else gr["data"][0]["groupId"]
            ms = safe_call("messages", {"selfId": data["selfId"], "remoteId": sample_gid, "kind": "group", "limit": 5})
            report["sampleMessages"] = len(ms.get("data", []))
    print(json.dumps(report, ensure_ascii=False), file=WIRE, flush=True)
else:
    for line in sys.stdin:
        try:
            req = json.loads(line)
            resp = safe_call(req.get("action", ""), req.get("params") or {})
            resp["id"] = req.get("id")
            print(json.dumps(resp, ensure_ascii=False), file=WIRE, flush=True)
        except (ValueError, TypeError):
            print(json.dumps({"ok": False, "code": "bad_request", "error": "无效的本机请求"}), file=WIRE, flush=True)
