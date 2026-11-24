"""Electro: Python-бэкенд. HTML-страница шлёт сигналы сюда, а Python запускает Minecraft."""
import argparse
import hashlib
import json
import mimetypes
import os
import shutil
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
import webbrowser
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs, urlencode

LIBS = Path.home() / ".electro" / "libs"   # своя папка для библиотек: системный Python не трогаем
sys.path.insert(0, str(LIBS))

try:
    import minecraft_launcher_lib as mll
except ImportError:
    mll = None

ROOT = Path(__file__).resolve().parent
HOME = Path.home() / ".electro"
DEFAULT_DIR = HOME / "minecraft"
SETTINGS_FILE = HOME / "settings.json"
STATIC = {"index.html", "styles.css", "renderer.js", "bg.js", "i18n.js"}
DEFAULTS = {"gameDir": str(DEFAULT_DIR), "nickname": "Player", "ramMax": 4, "version": "1.12.2", "showSnapshots": False, "javaPath": "", "loader": "vanilla"}

LOADERS = {"fabric": "Fabric", "forge": "Forge", "quilt": "Quilt"}
LOADER_MR = {"fabric": ["fabric"], "quilt": ["quilt", "fabric"], "forge": ["forge"]}   # Quilt умеет грузить и Fabric-моды

lock = threading.Lock()
state = {"status": "Готов к запуску", "progress": 0, "busy": False, "error": "", "log": [], "log_start": 0}
versions_cache = []
deps_installing = False
last_dep_try = 0.0


def ensure_deps():
    """Запускает установку библиотеки, если она не стоит и сейчас не ставится (не чаще раза в 15 секунд)."""
    global last_dep_try
    if mll is None and not deps_installing and time.time() - last_dep_try > 15:
        last_dep_try = time.time()
        threading.Thread(target=install_deps, daemon=True).start()


def install_deps():
    """Если библиотека не установлена, ставим её сами, чтобы не требовать ручного pip."""
    global mll, deps_installing
    deps_installing = True
    set_state(status="Установка библиотеки minecraft-launcher-lib…", error="")
    log("pip install minecraft-launcher-lib")
    try:
        HOME.mkdir(parents=True, exist_ok=True)
        free = shutil.disk_usage(HOME).free / 1024 ** 2
        if free < 150:
            raise RuntimeError(f"На диске осталось {free:.0f} МБ. Освободите место (нужно хотя бы 150 МБ), установка повторится сама.")
        r = subprocess.run([sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "--retries", "2",
                            "--timeout", "15", "--target", str(LIBS), "minecraft-launcher-lib>=7.0"], capture_output=True, text=True)
        log((r.stdout or "")[-1200:] + (r.stderr or "")[-1200:])
        if r.returncode != 0:
            lines = [l for l in (r.stderr or r.stdout or "").splitlines() if l.strip()]
            raise RuntimeError("pip: " + (lines[-1] if lines else f"код {r.returncode}") + ". Попробую снова через несколько секунд.")
        import importlib
        importlib.invalidate_caches()
        import minecraft_launcher_lib as m
        mll = m
        set_state(status="Готов к запуску", error="")
    except Exception as e:
        set_state(status="Не удалось установить библиотеку", error=str(e))
    finally:
        deps_installing = False


# ---------- состояние ----------
def log(line):
    with lock:
        state["log"].append(str(line).rstrip("\n"))
        if len(state["log"]) > 20000:
            del state["log"][:10000]
            state["log_start"] += 10000


def set_state(**kw):
    with lock:
        state.update(kw)


def load_settings():
    try:
        return {**DEFAULTS, **json.loads(SETTINGS_FILE.read_text("utf-8"))}
    except Exception:
        return dict(DEFAULTS)


def save_settings(s):
    HOME.mkdir(parents=True, exist_ok=True)
    SETTINGS_FILE.write_text(json.dumps(s, ensure_ascii=False, indent=2), "utf-8")


def check_dir(p):
    """Проверяем папку для игры: полный путь, создаётся и доступна для записи."""
    p = str(p or "").strip().strip('"')
    if not p:
        return None, "Укажите папку для игры"
    path = Path(p).expanduser()
    if not path.is_absolute():
        return None, "Нужен полный путь, например D:\\Games\\Minecraft"
    try:
        path.mkdir(parents=True, exist_ok=True)
        t = path / ".electro_test"
        t.write_text("ok")
        t.unlink()
    except Exception as e:
        return None, f"Нельзя записать в эту папку ({e.__class__.__name__})"
    return str(path), None


def pick_folder(start):
    """Системное окно выбора папки (tkinter в отдельном процессе, чтобы не мешать серверу)."""
    init = start if start and Path(start).exists() else str(Path.home())
    code = ("import tkinter as tk\nfrom tkinter import filedialog\nr = tk.Tk()\nr.withdraw()\n"
            "try:\n    r.attributes('-topmost', True)\nexcept Exception:\n    pass\n"
            "print(filedialog.askdirectory(title='Куда установить Minecraft', initialdir=%r) or '')" % init)
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=600,
                         encoding="utf-8", env={**os.environ, "PYTHONIOENCODING": "utf-8"})
    if out.returncode != 0:
        return None
    p = out.stdout.strip()
    return str(Path(p)) if p else ""


# ---------- моды и Modrinth ----------
MR = "https://api.modrinth.com/v2"
UA = {"User-Agent": "Electro-Launcher/0.1 (Minecraft launcher)"}
MODS_META = ".electro-mods.json"   # какие моды поставили мы: project_id -> файл и название


def instance_dir(game_dir, loader, version):
    """Vanilla живёт прямо в папке игры; моды — в отдельной папке на каждую пару «загрузчик + версия»."""
    base = Path(game_dir)
    return base if loader == "vanilla" else base / "instances" / f"{loader}-{version}"


def mr_get(path, params=None):
    url = MR + path + ("?" + urlencode(params) if params else "")
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=20) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Modrinth: ошибка {e.code}")
    except Exception:
        raise RuntimeError("Нет связи с Modrinth")


def read_meta(d):
    try:
        return json.loads((d / MODS_META).read_text("utf-8"))
    except Exception:
        return {}


def write_meta(d, m):
    d.mkdir(parents=True, exist_ok=True)
    (d / MODS_META).write_text(json.dumps(m, ensure_ascii=False, indent=1), "utf-8")


def search_mods(q, loader, version, offset):
    facets = [["project_type:mod"], [f"versions:{version}"], [f"categories:{c}" for c in LOADER_MR[loader]]]
    p = {"facets": json.dumps(facets), "limit": 20, "offset": max(0, offset), "index": "relevance" if q else "downloads"}
    if q:
        p["query"] = q
    r = mr_get("/search", p)
    hits = []
    for h in r.get("hits", []):
        icon = h.get("icon_url") or ""
        hits.append({"id": h["project_id"], "title": h["title"], "description": h.get("description", ""),
                     "author": h.get("author", ""), "downloads": h.get("downloads", 0),
                     "icon": icon if icon.startswith("https://cdn.modrinth.com/") else ""})
    return {"hits": hits, "total": r.get("total_hits", len(hits))}


def list_mods(d):
    by_file = {v.get("file"): (k, v) for k, v in read_meta(d).items()}
    out = []
    if d.is_dir():
        for f in sorted(d.iterdir(), key=lambda x: x.name.lower()):
            n = f.name
            if not (n.endswith(".jar") or n.endswith(".jar.disabled")):
                continue
            base = n[:-9] if n.endswith(".disabled") else n
            pid, info = by_file.get(base, ("", {}))
            out.append({"file": n, "enabled": not n.endswith(".disabled"), "title": info.get("title") or base[:-4], "project_id": pid})
    return out


def download_file(f, d):
    url = f["url"]
    pu = urlparse(url)
    if pu.scheme != "https" or pu.hostname != "cdn.modrinth.com":
        raise RuntimeError("Файл мода лежит не на cdn.modrinth.com, скачивание отменено")
    name = Path(f["filename"]).name
    if not name.endswith(".jar"):
        raise RuntimeError("Файл мода не .jar")
    d.mkdir(parents=True, exist_ok=True)
    tmp = d / (name + ".part")
    h = hashlib.sha512()
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r, open(tmp, "wb") as out:
            while True:
                chunk = r.read(65536)
                if not chunk:
                    break
                h.update(chunk)
                out.write(chunk)
        want = (f.get("hashes") or {}).get("sha512")
        if want and h.hexdigest() != want:
            raise RuntimeError("Файл повреждён: не совпала контрольная сумма")
        os.replace(tmp, d / name)
    finally:
        if tmp.exists():
            tmp.unlink()
    return name


def install_mod(pid, loader, version, d, meta, done, depth=0):
    """Ставит мод и его обязательные зависимости. Возвращает названия установленного."""
    if pid in meta or pid in done or depth > 4:
        return []
    done.add(pid)
    vs = mr_get(f"/project/{pid}/version", {"game_versions": json.dumps([version]), "loaders": json.dumps(LOADER_MR[loader])})
    if not vs:
        raise RuntimeError(f"У мода нет версии для {LOADERS[loader]} {version}")
    vs.sort(key=lambda v: 0 if loader in v.get("loaders", []) else 1)   # для Quilt сначала родные версии
    v = vs[0]
    f = next((x for x in v["files"] if x.get("primary")), v["files"][0])
    title = mr_get(f"/project/{pid}").get("title", pid)
    name = download_file(f, d)
    meta[pid] = {"title": title, "file": name, "version": v.get("version_number", "")}
    write_meta(d, meta)
    got = [title]
    for dep in v.get("dependencies", []):
        if dep.get("dependency_type") == "required" and dep.get("project_id"):
            try:
                got += install_mod(dep["project_id"], loader, version, d, meta, done, depth + 1)
            except RuntimeError:
                pass   # зависимость без подходящей версии пропускаем
    return got


def mod_path(d, name):
    n = Path(str(name)).name
    if not (n.endswith(".jar") or n.endswith(".jar.disabled")):
        raise ValueError("Некорректное имя файла")
    return d / n


def remove_mod(d, name):
    p = mod_path(d, name)
    p.unlink(missing_ok=True)
    base = p.name[:-9] if p.name.endswith(".disabled") else p.name
    meta = read_meta(d)
    for k in [k for k, v in meta.items() if v.get("file") == base]:
        del meta[k]
    write_meta(d, meta)


def toggle_mod(d, name):
    p = mod_path(d, name)
    p.rename(p.with_name(p.name[:-9] if p.name.endswith(".disabled") else p.name + ".disabled"))


def open_folder(d):
    d.mkdir(parents=True, exist_ok=True)
    if sys.platform == "win32":
        os.startfile(str(d))
    else:
        subprocess.Popen(["open" if sys.platform == "darwin" else "xdg-open", str(d)])


# ---------- загрузчики модов ----------
def loader_match(loader, version, vid):
    v = vid.lower()
    if loader in ("fabric", "quilt"):
        return v.startswith(loader + "-loader-") and v.endswith("-" + version)
    return v.startswith(version + "-") and "forge" in v


def find_loader_version(loader, version, mc_dir):
    ids = [v["id"] for v in mll.utils.get_installed_versions(str(mc_dir)) if loader_match(loader, version, v["id"])]
    if not ids:
        return None
    def mtime(i):
        try:
            return (mc_dir / "versions" / i / f"{i}.json").stat().st_mtime
        except OSError:
            return 0
    return max(ids, key=mtime)


def ensure_loader(loader, version, mc_dir, java, cb):
    found = find_loader_version(loader, version, mc_dir)
    if found:
        return found
    name = LOADERS[loader]
    set_state(status=f"Установка загрузчика {name}…", progress=0)
    log(f"Установка загрузчика {name} для {version}")
    if loader == "fabric":
        if not mll.fabric.is_minecraft_version_supported(version):
            raise RuntimeError(f"Fabric не поддерживает версию {version}")
        mll.fabric.install_fabric(version, str(mc_dir), callback=cb)
    elif loader == "quilt":
        if not mll.quilt.is_minecraft_version_supported(version):
            raise RuntimeError(f"Quilt не поддерживает версию {version}")
        mll.quilt.install_quilt(version, str(mc_dir), callback=cb)
    else:
        fv = mll.forge.find_forge_version(version)
        if not fv:
            raise RuntimeError(f"Для версии {version} нет Forge")
        if not mll.forge.supports_automatic_install(fv):
            raise RuntimeError("Эта версия Forge не ставится автоматически")
        mll.forge.install_forge_version(fv, str(mc_dir), callback=cb, java=java or None)
    found = find_loader_version(loader, version, mc_dir)
    if not found:
        raise RuntimeError(f"Не удалось установить {name}")
    return found


# ---------- запуск Minecraft ----------
def offline_uuid(name):
    return str(uuid.UUID(bytes=hashlib.md5(("OfflinePlayer:" + name).encode()).digest(), version=3))


def launch_worker(s):
    try:
        version = s["version"]
        mc_dir = Path(s["gameDir"])
        mc_dir.mkdir(parents=True, exist_ok=True)
        total = {"max": 1}

        def on_max(v): total["max"] = max(int(v), 1)
        def on_progress(v): set_state(progress=min(100, int(v / total["max"] * 100)))
        def on_status(t): set_state(status=str(t)); log(t)
        cb = {"setStatus": on_status, "setProgress": on_progress, "setMax": on_max}

        set_state(status=f"Установка Minecraft {version}…", progress=0)
        log(f"Установка версии {version}")
        mll.install.install_minecraft_version(version, str(mc_dir), callback=cb)

        # Java: берём официальный рантайм Mojang, подходящий этой версии (для 1.12.2 это Java 8)
        java = s.get("javaPath") or ""
        if not java:
            info = json.loads((mc_dir / "versions" / version / f"{version}.json").read_text("utf-8"))
            comp = info.get("javaVersion", {}).get("component", "jre-legacy")
            try:
                set_state(status=f"Подготовка Java ({comp})…", progress=0)
                mll.runtime.install_jvm_runtime(comp, str(mc_dir), callback=cb)
                java = mll.runtime.get_executable_path(comp, str(mc_dir)) or ""
            except Exception as e:
                log(f"Не удалось получить Java от Mojang ({e}). Использую системную Java.")
        log(f"Java: {java or 'системная (java)'}")

        loader = s.get("loader", "vanilla")
        launch_id = version
        game_dir = instance_dir(mc_dir, loader, version)
        if loader != "vanilla":
            launch_id = ensure_loader(loader, version, mc_dir, java, cb)
        game_dir.mkdir(parents=True, exist_ok=True)

        options = {
            "username": s["nickname"],
            "uuid": offline_uuid(s["nickname"]),
            "token": "",
            "launcherName": "Electro",
            "gameDirectory": str(game_dir),
            "jvmArguments": [f"-Xmx{s['ramMax']}G", "-Xms1G"],
        }
        if java:
            options["executablePath"] = java
        cmd = mll.command.get_minecraft_command(launch_id, str(mc_dir), options)

        set_state(status="Запуск игры…", progress=100)
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        proc = subprocess.Popen(cmd, cwd=str(game_dir), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, encoding="utf-8", errors="replace", creationflags=flags)
        set_state(status="Игра запущена")
        for line in proc.stdout:
            log(line)
        code = proc.wait()
        set_state(status=f"Игра закрыта (код {code})", progress=0)
    except FileNotFoundError:
        set_state(error="Java не найдена. Укажите путь к Java в настройках или установите Java.", status="Ошибка запуска", progress=0)
    except Exception as e:
        log(f"ОШИБКА: {e!r}")
        set_state(error=f"{type(e).__name__}: {e}", status="Ошибка запуска", progress=0)
    finally:
        set_state(busy=False)


def start_launch(body):
    if mll is None:
        ensure_deps()
        msg = "Библиотека ещё устанавливается, подождите минуту." if deps_installing else "Не установлена библиотека: pip install minecraft-launcher-lib"
        return 500, {"error": msg}
    version = str(body.get("version", ""))
    nick = str(body.get("nickname", "")).strip()
    if not re.fullmatch(r"[\w.\-]{1,64}", version):
        return 400, {"error": "Выберите версию игры"}
    if not re.fullmatch(r"[A-Za-z0-9_]{3,16}", nick):
        return 400, {"error": "Ник: от 3 до 16 символов, латиница, цифры и _"}
    try:
        ram = max(1, min(64, int(body.get("ramMax", 4))))
    except (TypeError, ValueError):
        ram = 4
    loader = str(body.get("loader", "vanilla"))
    if loader != "vanilla" and loader not in LOADERS:
        loader = "vanilla"
    folder, err = check_dir(body.get("gameDir") or load_settings()["gameDir"])
    if err:
        return 400, {"error": err}
    s = {"gameDir": folder, "nickname": nick, "ramMax": ram, "version": version,
         "showSnapshots": bool(body.get("showSnapshots")), "javaPath": str(body.get("javaPath", "")).strip(), "loader": loader}
    with lock:
        if state["busy"]:
            return 409, {"error": "Игра уже запускается или запущена"}
        state.update(busy=True, error="", progress=0)
    save_settings(s)
    log(f"--- запуск {version} ---")
    threading.Thread(target=launch_worker, args=(s,), daemon=True).start()
    return 200, {"ok": True}


# ---------- HTTP ----------
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def host_ok(self):
        return self.headers.get("Host", "").split(":")[0] in ("127.0.0.1", "localhost")

    def mods_ctx(self, loader, version):
        if loader not in LOADER_MR:
            raise ValueError("Выберите загрузчик модов: Fabric, Forge или Quilt")
        if not re.fullmatch(r"[\w.\-]{1,64}", str(version)):
            raise ValueError("Выберите версию игры")
        return instance_dir(load_settings()["gameDir"], loader, version) / "mods"

    def mods_api(self, path, a):
        try:
            loader, version = str(a.get("loader", "")), str(a.get("version", ""))
            d = self.mods_ctx(loader, version)
            if path == "/api/mods/search":
                try:
                    off = int(a.get("offset", 0))
                except (TypeError, ValueError):
                    off = 0
                return self.send_json(200, search_mods(str(a.get("q", "")).strip(), loader, version, off))
            if path == "/api/mods/installed":
                return self.send_json(200, list_mods(d))
            if path == "/api/mods/install":
                pid = str(a.get("project_id", ""))
                if not re.fullmatch(r"[\w\-]{1,64}", pid):
                    raise ValueError("Некорректный мод")
                return self.send_json(200, {"installed": install_mod(pid, loader, version, d, read_meta(d), set())})
            if path == "/api/mods/remove":
                remove_mod(d, a.get("file", ""))
                return self.send_json(200, {"ok": True})
            if path == "/api/mods/toggle":
                toggle_mod(d, a.get("file", ""))
                return self.send_json(200, {"ok": True})
            if path == "/api/mods/open":
                open_folder(d)
                return self.send_json(200, {"ok": True})
            return self.send_json(404, {"error": "not found"})
        except ValueError as e:
            return self.send_json(400, {"error": str(e)})
        except Exception as e:
            return self.send_json(502, {"error": str(e) or e.__class__.__name__})

    def do_GET(self):
        if not self.host_ok():
            return self.send_json(403, {"error": "forbidden"})
        u = urlparse(self.path)
        p = u.path
        if p == "/api/ping":
            return self.send_json(200, {"ok": True})
        if p == "/api/settings":
            return self.send_json(200, {**load_settings(), "defaultDir": str(DEFAULT_DIR)})
        if p == "/api/dirinfo":
            q = parse_qs(u.query).get("path", [""])[0]
            path = Path(q).expanduser() if q else DEFAULT_DIR
            base = path
            while not base.exists() and base != base.parent:
                base = base.parent
            try:
                free = round(shutil.disk_usage(base).free / 1024 ** 3, 1)
            except Exception:
                free = None
            return self.send_json(200, {"path": str(path), "free": free})
        if p == "/api/versions":
            global versions_cache
            if mll is None:
                ensure_deps()
                return self.send_json(500, {"error": "Устанавливаю библиотеку, подождите…" if deps_installing else "Не установлена библиотека: pip install minecraft-launcher-lib"})
            try:
                if not versions_cache:
                    versions_cache = [{"id": v["id"], "type": v["type"]} for v in mll.utils.get_version_list()]
                return self.send_json(200, versions_cache)
            except Exception as e:
                return self.send_json(502, {"error": f"Не удалось получить список версий: {e}"})
        if p == "/api/state":
            since = int(parse_qs(u.query).get("since", ["0"])[0] or 0)
            with lock:
                start = state["log_start"]
                lines = state["log"][max(0, since - start):]
                out = {k: state[k] for k in ("status", "progress", "busy", "error")}
                out.update(log=lines, next=start + len(state["log"]))
            return self.send_json(200, out)
        if p.startswith("/api/mods/"):
            return self.mods_api(p, {k: v[0] for k, v in parse_qs(u.query).items()})
        name = "index.html" if p == "/" else p.lstrip("/")
        if name in STATIC:
            data = (ROOT / name).read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", (mimetypes.guess_type(name)[0] or "text/plain") + "; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return self.wfile.write(data)
        self.send_json(404, {"error": "not found"})

    def do_POST(self):
        # Защита: чужие сайты не смогут отправить сигнал запуска (нужен свой заголовок + локальный Host)
        if not self.host_ok() or self.headers.get("X-Electro") != "1":
            return self.send_json(403, {"error": "forbidden"})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        except Exception:
            return self.send_json(400, {"error": "bad json"})
        if self.path == "/api/settings":
            cur = load_settings()
            if "gameDir" in body:
                folder, err = check_dir(body["gameDir"])
                if err:
                    return self.send_json(400, {"error": err})
                cur["gameDir"] = folder
            save_settings(cur)
            return self.send_json(200, {**cur, "defaultDir": str(DEFAULT_DIR)})
        if self.path == "/api/pick-folder":
            try:
                chosen = pick_folder(str(body.get("path") or ""))
            except Exception:
                chosen = None
            if chosen is None:
                return self.send_json(501, {"error": "Окно выбора папки недоступно на этом компьютере. Введите путь вручную в настройках."})
            return self.send_json(200, {"path": chosen})
        if self.path.startswith("/api/mods/") and isinstance(body, dict):
            return self.mods_api(self.path, body)
        if self.path == "/api/quit":
            self.send_json(200, {"ok": True})
            threading.Thread(target=globals()["SERVER"].shutdown, daemon=True).start()
            return
        if self.path == "/api/launch":
            code, obj = start_launch(body)
            return self.send_json(code, obj)
        self.send_json(404, {"error": "not found"})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true")
    a = ap.parse_args()
    server = None
    for port in range(a.port, a.port + 11):
        try:
            server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
            break
        except OSError:
            continue
    if server is None:
        sys.exit("Нет свободного порта для Electro")
    globals()["SERVER"] = server
    url = f"http://127.0.0.1:{server.server_address[1]}/"
    print(f"Electro запущен: {url}", flush=True)
    if mll is None:
        threading.Thread(target=install_deps, daemon=True).start()
    if not a.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
