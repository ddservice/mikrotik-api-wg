import os
import json
import socket
import hashlib
import secrets
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
import urllib.parse

PORT = 3000
DB_DIR = os.path.join(os.path.dirname(__file__), 'db')
CONFIG_FILE = os.path.join(DB_DIR, 'config.json')
USERS_FILE = os.path.join(DB_DIR, 'users.json')
PUBLIC_DIR = os.path.join(os.path.dirname(__file__), 'public')

# Ensure DB folder exists
os.makedirs(DB_DIR, exist_ok=True)

# Salt for SHA256 passwords
PASSWORD_SALT = "mikrotik_gatekeeper_salt_secure_2026"

def hash_password(password):
    return hashlib.sha256((password + PASSWORD_SALT).encode('utf-8')).hexdigest()

# Initialize DB files
def init_db():
    if not os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
            json.dump({"host": "", "port": 8728, "username": "", "password": ""}, f, indent=4)
            
    if not os.path.exists(USERS_FILE):
        default_users = [
            {
                "id": "1",
                "username": "admin",
                "passwordHash": hash_password("admin1234"),
                "role": "admin",
                "name": "System Administrator"
            }
        ]
        with open(USERS_FILE, 'w', encoding='utf-8') as f:
            json.dump(default_users, f, indent=4)

init_db()

# DB Helpers
def get_config():
    try:
        with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except:
        return {"host": "", "port": 8728, "username": "", "password": ""}

def save_config(config):
    with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
        json.dump(config, f, indent=4)

def get_users():
    try:
        with open(USERS_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except:
        return []

def save_users(users):
    with open(USERS_FILE, 'w', encoding='utf-8') as f:
        json.dump(users, f, indent=4)

LOGS_FILE = os.path.join(DB_DIR, 'logs.json')

def get_logs():
    if not os.path.exists(LOGS_FILE):
        with open(LOGS_FILE, 'w', encoding='utf-8') as f:
            json.dump([], f)
    try:
        with open(LOGS_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except:
        return []

def add_log(username, action, details):
    import datetime
    try:
        logs = get_logs()
        new_log = {
            "timestamp": datetime.datetime.now().isoformat(),
            "username": username,
            "action": action,
            "details": details
        }
        logs.insert(0, new_log)
        if len(logs) > 1000:
            logs.pop()
        with open(LOGS_FILE, 'w', encoding='utf-8') as f:
            json.dump(logs, f, indent=4, ensure_ascii=False)
    except Exception as e:
        print(f"Error writing audit log: {e}")

# Session store (token -> {user_obj, expires})
active_sessions = {}
SESSION_EXPIRY_S = 24 * 60 * 60 # 24 hours

# ==========================================================================
# MIKROTIK ROUTER API PROTOCOL IMPLEMENTATION (PORT 8728)
# ==========================================================================
def encode_length(l):
    if l < 0x80:
        return bytes([l])
    elif l < 0x4000:
        return bytes([(l >> 8) | 0x80, l & 0xFF])
    elif l < 0x200000:
        return bytes([(l >> 16) | 0xC0, (l >> 8) & 0xFF, l & 0xFF])
    elif l < 0x10000000:
        return bytes([(l >> 24) | 0xE0, (l >> 16) & 0xFF, (l >> 8) & 0xFF, l & 0xFF])
    else:
        return bytes([0xF0, (l >> 24) & 0xFF, (l >> 16) & 0xFF, (l >> 8) & 0xFF, l & 0xFF])

def read_word(sock):
    first_byte = sock.recv(1)
    if not first_byte:
        return None
    first = first_byte[0]
    
    if (first & 0x80) == 0x00:
        length = first
    elif (first & 0xC0) == 0x80:
        b = sock.recv(1)
        if not b: return None
        length = ((first & 0x3F) << 8) | b[0]
    elif (first & 0xE0) == 0xC0:
        b = sock.recv(2)
        if len(b) < 2: return None
        length = ((first & 0x1F) << 16) | (b[0] << 8) | b[1]
    elif (first & 0xF0) == 0xE0:
        b = sock.recv(3)
        if len(b) < 3: return None
        length = ((first & 0x0F) << 24) | (b[0] << 16) | (b[1] << 8) | b[2]
    elif (first & 0xF8) == 0xF0:
        b = sock.recv(4)
        if len(b) < 4: return None
        length = (b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]
    else:
        length = 0
        
    if length == 0:
        return ""
        
    data = b""
    while len(data) < length:
        chunk = sock.recv(length - len(data))
        if not chunk:
            break
        data += chunk
    return data.decode('utf-8', errors='ignore')

def read_sentence(sock):
    words = []
    while True:
        w = read_word(sock)
        if w is None:
            return None
        if w == "":
            break
        words.append(w)
    return words

def execute_command(sock, command, args=None):
    words = [command]
    if isinstance(args, list):
        words.extend(args)
    elif isinstance(args, dict):
        for k, v in args.items():
            if v is not None:
                words.append(f"={k}={v}")
                
    # Write words
    payload = b""
    for w in words:
        w_bytes = w.encode('utf-8')
        payload += encode_length(len(w_bytes)) + w_bytes
    payload += b"\x00"
    
    sock.sendall(payload)
    
    # Read response
    results = []
    while True:
        sentence = read_sentence(sock)
        if sentence is None:
            raise Exception("Router connection disconnected during execution")
        
        type_ = sentence[0]
        attrs = {}
        for w in sentence[1:]:
            if w.startswith("="):
                parts = w[1:].split("=", 1)
                if len(parts) == 2:
                    attrs[parts[0]] = parts[1]
                else:
                    attrs[parts[0]] = ""
            elif w.startswith("."):
                parts = w.split("=", 1)
                if len(parts) == 2:
                    attrs[parts[0]] = parts[1]
                    
        if type_ == "!re":
            results.append(attrs)
        elif type_ == "!done":
            if attrs:
                results.append(attrs)
            return results
        elif type_ == "!trap":
            msg = attrs.get("message", "Unknown RouterOS API error")
            raise Exception(msg)
        elif type_ == "!fatal":
            raise Exception(sentence[1] if len(sentence) > 1 else "Fatal error occurred")

def connect_and_login():
    config = get_config()
    if not config.get("host") or not config.get("username"):
        raise Exception("Router settings are not configured yet.")
        
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(8.0)
    
    try:
        sock.connect((config["host"], int(config.get("port", 8728))))
    except Exception as e:
        raise Exception(f"Failed to establish TCP connection: {e}")
        
    try:
        # Step 1: Try modern login (RouterOS v6.43+)
        execute_command(sock, "/login", {"name": config["username"], "password": config["password"]})
    except Exception as e:
        # Step 2: Try legacy challenge-response
        try:
            init_res = execute_command(sock, "/login")
            challenge = init_res[0].get("ret")
            if challenge:
                chal_bytes = binascii.unhexlify(challenge)
                pwd_bytes = config["password"].encode('utf-8')
                zero_byte = b"\x00"
                
                md5 = hashlib.md5()
                md5.update(zero_byte)
                md5.update(pwd_bytes)
                md5.update(chal_bytes)
                resp = "00" + md5.hexdigest()
                
                execute_command(sock, "/login", {"name": config["username"], "response": resp})
            else:
                raise Exception("No authentication challenge received")
        except Exception as legacy_err:
            sock.close()
            raise Exception(f"Authentication failed: {legacy_err}")
            
    return sock

# ==========================================================================
# WEB ROUTER REQUEST HANDLER
# ==========================================================================
class RouterDashboardHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass # Disable console log spamming

    def serve_static(self, file_path):
        if not os.path.exists(file_path) or os.path.isdir(file_path):
            self.send_error(404, "File not found")
            return
            
        content_type = "text/html"
        if file_path.endswith(".css"):
            content_type = "text/css"
        elif file_path.endswith(".js"):
            content_type = "application/javascript"
        elif file_path.endswith(".png"):
            content_type = "image/png"
        elif file_path.endswith(".jpg") or file_path.endswith(".jpeg"):
            content_type = "image/jpeg"
        elif file_path.endswith(".svg"):
            content_type = "image/svg+xml"
            
        try:
            with open(file_path, "rb") as f:
                content = f.read()
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", len(content))
            self.end_headers()
            self.wfile.write(content)
        except Exception as e:
            self.send_error(500, f"Internal server error: {e}")

    def send_json(self, data, status=200):
        try:
            content = json.dumps(data).encode('utf-8')
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", len(content))
            self.end_headers()
            self.wfile.write(content)
        except Exception as e:
            self.send_error(500, f"JSON Error: {e}")

    def check_auth(self, allowed_roles=None):
        auth_header = self.headers.get("Authorization")
        if not auth_header or not auth_header.startswith("Bearer "):
            self.send_json({"error": "Unauthorized"}, 401)
            return None
            
        token = auth_header[7:]
        session = active_sessions.get(token)
        if not session:
            self.send_json({"error": "Unauthorized"}, 401)
            return None
            
        if session["expires"] < time.time():
            active_sessions.pop(token, None)
            self.send_json({"error": "Session expired"}, 401)
            return None
            
        # Refresh expiry
        session["expires"] = time.time() + SESSION_EXPIRY_S
        user = session["user"]
        
        if allowed_roles and user["role"] not in allowed_roles:
            self.send_json({"error": "Forbidden"}, 403)
            return None
            
        return user

    def do_GET(self):
        parsed_url = urllib.parse.urlparse(self.path)
        path = parsed_url.path
        
        # 1. Static Files serving
        if not path.startswith("/api/"):
            clean_path = path.lstrip("/")
            if clean_path == "" or clean_path == "index.html":
                file_to_serve = os.path.join(PUBLIC_DIR, "index.html")
            else:
                file_to_serve = os.path.join(PUBLIC_DIR, clean_path)
            self.serve_static(file_to_serve)
            return

        # 2. REST APIs
        try:
            # Session User details
            if path == "/api/auth/me":
                user = self.check_auth()
                if user:
                    self.send_json({"user": user})
                return
                
            # Manage local users list (Admin only)
            elif path == "/api/users":
                if self.check_auth(["admin"]):
                    users = get_users()
                    sanitized = [{"id": u["id"], "username": u["username"], "role": u["role"], "name": u["name"]} for u in users]
                    self.send_json(sanitized)
                return
                
            # Read audit logs (Admin only)
            elif path == "/api/logs":
                if self.check_auth(["admin"]):
                    self.send_json(get_logs())
                return
                
            # Manage Connection configurations (Admin only)
            elif path == "/api/config":
                if self.check_auth(["admin"]):
                    cfg = get_config()
                    self.send_json({
                        "host": cfg.get("host", ""),
                        "port": cfg.get("port", 8728),
                        "username": cfg.get("username", ""),
                        "hasPassword": bool(cfg.get("password"))
                    })
                return

            # MikroTik Connection Check
            elif path == "/api/mikrotik/test-connection":
                if self.check_auth(["admin"]):
                    sock = None
                    try:
                        sock = connect_and_login()
                        execute_command(sock, "/system/resource/print")
                        self.send_json({"success": True, "message": "Connected successfully"})
                    except Exception as err:
                        self.send_json({"error": str(err)}, 500)
                    finally:
                        if sock: sock.close()
                return

            # Read System status
            elif path == "/api/mikrotik/status":
                if self.check_auth():
                    sock = None
                    try:
                        sock = connect_and_login()
                        res = execute_command(sock, "/system/resource/print")
                        rb_res = execute_command(sock, "/system/routerboard/print")
                        
                        r = res[0] if res else {}
                        rb = rb_res[0] if rb_res else {}
                        
                        self.send_json({
                            "uptime": r.get("uptime", "N/A"),
                            "version": r.get("version", "N/A"),
                            "cpuLoad": f"{r.get('cpu-load', '0')}%",
                            "freeMemory": int(r.get("free-memory", 0)),
                            "totalMemory": int(r.get("total-memory", 0)),
                            "cpu": r.get("cpu", "N/A"),
                            "boardName": r.get("board-name", "N/A"),
                            "model": rb.get("model", r.get("board-name", "MikroTik")),
                            "serialNumber": rb.get("serial-number", "N/A")
                        })
                    except Exception as err:
                        self.send_json({"error": str(err)}, 500)
                    finally:
                        if sock: sock.close()
                return

            # Read Interfaces
            elif path == "/api/mikrotik/interfaces":
                if self.check_auth():
                    sock = None
                    try:
                        sock = connect_and_login()
                        res = execute_command(sock, "/interface/print")
                        output = []
                        for item in res:
                            output.append({
                                "id": item.get(".id"),
                                "name": item.get("name"),
                                "type": item.get("type"),
                                "running": item.get("running") == "true",
                                "disabled": item.get("disabled") == "true",
                                "rxByte": int(item.get("rx-byte", 0)),
                                "txByte": int(item.get("tx-byte", 0)),
                                "comment": item.get("comment", "")
                            })
                        self.send_json(output)
                    except Exception as err:
                        self.send_json({"error": str(err)}, 500)
                    finally:
                        if sock: sock.close()
                return

            # Read Hotspot users
            elif path == "/api/mikrotik/hotspot/users":
                if self.check_auth(["admin", "co-admin", "user"]):
                    sock = None
                    try:
                        sock = connect_and_login()
                        res = execute_command(sock, "/ip/hotspot/user/print", {
                            ".proplist": ".id,name,password,profile,limit-uptime,limit-bytes-total,uptime,bytes-in,bytes-out,disabled,comment"
                        })
                        output = []
                        for item in res:
                            pwd = item.get("password") or item.get("plain-password") or item.get("pass") or item.get("secret") or ""
                            output.append({
                                "id": item.get(".id"),
                                "name": item.get("name"),
                                "password": pwd,
                                "profile": item.get("profile", "default"),
                                "uptime": item.get("uptime", "0s"),
                                "bytesIn": int(item.get("bytes-in", 0)),
                                "bytesOut": int(item.get("bytes-out", 0)),
                                "limitUptime": item.get("limit-uptime", "00:00:00"),
                                "limitBytesTotal": int(item.get("limit-bytes-total", 0)),
                                "disabled": item.get("disabled") == "true",
                                "comment": item.get("comment", "")
                            })
                        self.send_json(output)
                    except Exception as err:
                        self.send_json({"error": str(err)}, 500)
                    finally:
                        if sock: sock.close()
                return

            # Read Active users
            elif path == "/api/mikrotik/hotspot/active":
                if self.check_auth(["admin", "co-admin", "user"]):
                    sock = None
                    try:
                        sock = connect_and_login()
                        res = execute_command(sock, "/ip/hotspot/active/print")
                        output = []
                        for item in res:
                            output.append({
                                "id": item.get(".id"),
                                "user": item.get("user"),
                                "address": item.get("address"),
                                "macAddress": item.get("mac-address"),
                                "uptime": item.get("uptime", "0s"),
                                "bytesIn": int(item.get("bytes-in", 0)),
                                "bytesOut": int(item.get("bytes-out", 0)),
                                "loginBy": item.get("login-by", "")
                            })
                        self.send_json(output)
                    except Exception as err:
                        self.send_json({"error": str(err)}, 500)
                    finally:
                        if sock: sock.close()
                return

            # Read Hotspot User Profiles
            elif path == "/api/mikrotik/hotspot/profiles":
                if self.check_auth(["admin", "co-admin", "user"]):
                    sock = None
                    try:
                        sock = connect_and_login()
                        res = execute_command(sock, "/ip/hotspot/user-profile/print")
                        output = []
                        for item in res:
                            output.append({
                                "name": item.get("name"),
                                "sharedUsers": item.get("shared-users", "1"),
                                "rateLimit": item.get("rate-limit", "Unlimited")
                            })
                        self.send_json(output)
                    except Exception as err:
                        self.send_json({"error": str(err)}, 500)
                    finally:
                        if sock: sock.close()
                return

            # Read Firewall status
            elif path == "/api/mikrotik/firewall/status":
                if self.check_auth(["admin", "co-admin", "user"]):
                    sock = None
                    try:
                        sock = connect_and_login()
                        res = execute_command(sock, "/ip/firewall/filter/print")
                        
                        yt_rule = next((r for r in res if r.get("comment") == "Block YouTube (Dashboard)"), None)
                        ln_rule = next((r for r in res if r.get("comment") == "Block LINE (Dashboard)"), None)
                        
                        self.send_json({
                            "youtubeBlocked": yt_rule.get("disabled") == "false" if yt_rule else False,
                            "lineBlocked": ln_rule.get("disabled") == "false" if ln_rule else False
                        })
                    except Exception as err:
                        self.send_json({"error": str(err)}, 500)
                    finally:
                        if sock: sock.close()
                return

            else:
                self.send_error(404, "Endpoint not found")
        except Exception as e:
            self.send_json({"error": f"Internal error: {e}"}, 500)

    def do_POST(self):
        parsed_url = urllib.parse.urlparse(self.path)
        path = parsed_url.path
        
        # Read request body length and data
        content_length = int(self.headers.get('Content-Length', 0))
        post_data = self.rfile.read(content_length) if content_length > 0 else b""
        body = {}
        if post_data:
            try:
                body = json.loads(post_data.decode('utf-8'))
            except:
                self.send_json({"error": "Invalid JSON"}, 400)
                return

        try:
            # Login
            if path == "/api/auth/login":
                username = body.get("username", "").lower()
                password = body.get("password", "")
                if not username or not password:
                    self.send_json({"error": "Username and password are required"}, 400)
                    return
                    
                users = get_users()
                user = next((u for u in users if u["username"] == username), None)
                if not user or user["passwordHash"] != hash_password(password):
                    self.send_json({"error": "Invalid username or password"}, 400)
                    return
                    
                token = secrets.token_hex(32)
                user_data = {"id": user["id"], "username": user["username"], "role": user["role"], "name": user["name"]}
                active_sessions[token] = {
                    "user": user_data,
                    "expires": time.time() + SESSION_EXPIRY_S
                }
                add_log(user["username"], 'เข้าสู่ระบบ', 'ล็อกอินเข้าสู่หน้าจัดการสำเร็จ')
                self.send_json({"token": token, "user": user_data})
                return

            # Logout
            elif path == "/api/auth/logout":
                # Auth middleware check inside
                auth_header = self.headers.get("Authorization")
                if auth_header and auth_header.startswith("Bearer "):
                    token = auth_header[7:]
                    active_sessions.pop(token, None)
                self.send_json({"success": True})
                return

            # Create local User (Admin only)
            elif path == "/api/users":
                auth_user = self.check_auth(["admin"])
                if auth_user:
                    username = body.get("username", "").lower()
                    password = body.get("password")
                    role = body.get("role")
                    name = body.get("name")
                    
                    if not username or not password or not role or not name:
                        self.send_json({"error": "All fields are required"}, 400)
                        return
                        
                    users = get_users()
                    if any(u["username"] == username for u in users):
                        self.send_json({"error": "Username already exists"}, 400)
                        return
                        
                    new_user = {
                        "id": str(int(time.time() * 1000)),
                        "username": username,
                        "passwordHash": hash_password(password),
                        "role": role,
                        "name": name
                    }
                    users.append(new_user)
                    save_users(users)
                    add_log(auth_user["username"], 'เพิ่มบัญชีระบบ', f'เพิ่มบัญชี {username} (สิทธิ์: {role})')
                    self.send_json({"id": new_user["id"], "username": username, "role": role, "name": name}, 201)
                return

            # Save Connection Settings (Admin only)
            elif path == "/api/config":
                auth_user = self.check_auth(["admin"])
                if auth_user:
                    host = body.get("host")
                    port = body.get("port")
                    username = body.get("username")
                    password = body.get("password")
                    
                    if not host or not username:
                        self.send_json({"error": "Host and username are required"}, 400)
                        return
                        
                    cfg = get_config()
                    cfg["host"] = host
                    cfg["port"] = int(port) if port else 8728
                    cfg["username"] = username
                    if password is not None:
                        cfg["password"] = password
                        
                    save_config(cfg)
                    add_log(auth_user["username"], 'ตั้งค่าเราท์เตอร์', f'อัปเดตข้อมูลเชื่อมโยงเราท์เตอร์ใหม่ IP: {host}')
                    self.send_json({"success": True})
                return

            # Add Hotspot user
            elif path == "/api/mikrotik/hotspot/users":
                auth_user = self.check_auth(["admin", "co-admin", "user"])
                if auth_user:
                    name = body.get("name")
                    password = body.get("password", "")
                    profile = body.get("profile", "default")
                    limit_uptime = body.get("limitUptime")
                    limit_bytes = body.get("limitBytesTotal")
                    comment = body.get("comment", "Added by Web Dashboard")
                    
                    if not name:
                        self.send_json({"error": "Username is required"}, 400)
                        return
                        
                    sock = None
                    try:
                        sock = connect_and_login()
                        params = {
                            "name": name,
                            "password": password,
                            "profile": profile,
                            "comment": comment
                        }
                        if limit_uptime: params["limit-uptime"] = limit_uptime
                        if limit_bytes: params["limit-bytes-total"] = str(limit_bytes)
                        
                        res = execute_command(sock, "/ip/hotspot/user/add", params)
                        add_log(auth_user["username"], 'เพิ่มบัญชี Hotspot', f'เพิ่มผู้ใช้ {name} (โปรไฟล์: {profile})')
                        self.send_json({"success": True, "result": res})
                    except Exception as err:
                        self.send_json({"error": str(err)}, 500)
                    finally:
                        if sock: sock.close()
                return

            # Generate Hotspot Users (Vouchers)
            elif path == "/api/mikrotik/hotspot/generate":
                auth_user = self.check_auth(["admin", "co-admin", "user"])
                if auth_user:
                    prefix = body.get("prefix", "")
                    qty = int(body.get("qty", 10))
                    profile = body.get("profile", "default")
                    limit_uptime = body.get("limitUptime")
                    limit_bytes = body.get("limitBytesTotal")
                    
                    if qty <= 0 or qty > 100:
                        self.send_json({"error": "Quantity must be between 1 and 100"}, 400)
                        return
                        
                    char_pool = 'abcdefghijklmnopqrstuvwxyz23456789'
                    
                    def gen_random_string(l):
                        return "".join(secrets.choice(char_pool) for _ in range(l))
                        
                    generated = []
                    sock = None
                    try:
                        sock = connect_and_login()
                        for _ in range(qty):
                            username = prefix + gen_random_string(5)
                            password = gen_random_string(6)
                            
                            params = {
                                "name": username,
                                "password": password,
                                "profile": profile,
                                "comment": f"Generated by Web Dashboard ({time.strftime('%Y-%m-%d')})"
                            }
                            if limit_uptime: params["limit-uptime"] = limit_uptime
                            if limit_bytes: params["limit-bytes-total"] = str(limit_bytes)
                            
                            execute_command(sock, "/ip/hotspot/user/add", params)
                            generated.append({"username": username, "password": password})
                        add_log(auth_user["username"], 'สร้างคูปองกลุ่ม', f'สร้างคูปองจำนวน {qty} ใบ (โปรไฟล์: {profile})')
                        self.send_json({"success": True, "users": generated})
                    except Exception as err:
                        self.send_json({"error": f"Error after generating {len(generated)} vouchers: {err}", "users": generated}, 500)
                    finally:
                        if sock: sock.close()
                return

            # Toggle Firewall Rule
            elif path == "/api/mikrotik/firewall/toggle":
                auth_user = self.check_auth(["admin", "co-admin", "user"])
                if auth_user:
                    service = body.get("service")
                    block = bool(body.get("block"))
                    
                    if service not in ["youtube", "line"]:
                        self.send_json({"error": "Invalid service"}, 400)
                        return
                        
                    rule_comment = "Block YouTube (Dashboard)" if service == "youtube" else "Block LINE (Dashboard)"
                    list_name = "blocked_youtube" if service == "youtube" else "blocked_line"
                    
                    domains = ["youtube.com", "youtu.be", "googlevideo.com", "ytimg.com"] if service == "youtube" else ["line.me", "line-apps.com", "line-cdn.net"]
                    
                    sock = None
                    try:
                        sock = connect_and_login()
                        rules = execute_command(sock, "/ip/firewall/filter/print")
                        existing = next((r for r in rules if r.get("comment") == rule_comment), None)
                        
                        if existing:
                            # Toggle rule
                            execute_command(sock, "/ip/firewall/filter/set", {
                                ".id": existing[".id"],
                                "disabled": "no" if block else "yes"
                            })
                        else:
                            # Create new rule if requested block
                            if block:
                                # First populate Address lists
                                lists = execute_command(sock, "/ip/firewall/address-list/print")
                                for d in domains:
                                    exists = any(item.get("list") == list_name and item.get("address") == d for item in lists)
                                    if not exists:
                                        execute_command(sock, "/ip/firewall/address-list/add", {
                                            "list": list_name,
                                            "address": d,
                                            "comment": "Added by Web Dashboard"
                                        })
                                # Add filter rule
                                execute_command(sock, "/ip/firewall/filter/add", {
                                    "chain": "forward",
                                    "action": "drop",
                                    "dst-address-list": list_name,
                                    "comment": rule_comment,
                                    "disabled": "no"
                                })
                        add_log(auth_user["username"], 'เปิดบล็อกเว็บ' if block else 'ปิดบล็อกเว็บ', f'บริการ: {service}')
                        self.send_json({"success": True, "blocked": block})
                    except Exception as err:
                        self.send_json({"error": str(err)}, 500)
                    finally:
                        if sock: sock.close()
                return

            else:
                self.send_error(404, "Endpoint not found")
        except Exception as e:
            self.send_json({"error": f"Internal error: {e}"}, 500)

    def do_PUT(self):
        parsed_url = urllib.parse.urlparse(self.path)
        path = parsed_url.path
        
        content_length = int(self.headers.get('Content-Length', 0))
        post_data = self.rfile.read(content_length) if content_length > 0 else b""
        body = {}
        if post_data:
            try:
                body = json.loads(post_data.decode('utf-8'))
            except:
                self.send_json({"error": "Invalid JSON"}, 400)
                return

        try:
            # Edit Local Dashboard User (Admin only)
            if path.startswith("/api/users/"):
                auth_user = self.check_auth(["admin"])
                if auth_user:
                    user_id = path.split("/")[-1]
                    username = body.get("username", "").lower()
                    password = body.get("password")
                    role = body.get("role")
                    name = body.get("name")
                    
                    users = get_users()
                    user = next((u for u in users if u["id"] == user_id), None)
                    if not user:
                        self.send_json({"error": "User not found"}, 404)
                        return
                        
                    if username and username != user["username"]:
                        if any(u["username"] == username for u in users):
                            self.send_json({"error": "Username already exists"}, 400)
                            return
                        user["username"] = username
                        
                    if role: user["role"] = role
                    if name: user["name"] = name
                    if password: user["passwordHash"] = hash_password(password)
                    
                    save_users(users)
                    
                    # Log them out if key properties changed
                    if username or role or password:
                        tokens_to_del = [token for token, sess in active_sessions.items() if sess["user"]["id"] == user_id]
                        for token in tokens_to_del:
                            active_sessions.pop(token, None)
                            
                    add_log(auth_user["username"], 'แก้ไขบัญชีระบบ', f'แก้ไขบัญชี ID {user_id} (ชื่อ: {name or ""})')
                    self.send_json({"id": user_id, "username": user["username"], "role": user["role"], "name": user["name"]})
                return

            # Edit Hotspot User
            elif path.startswith("/api/mikrotik/hotspot/users/"):
                auth_user = self.check_auth(["admin", "co-admin", "user"])
                if auth_user:
                    ros_id = path.split("/")[-1]
                    name = body.get("name")
                    password = body.get("password")
                    profile = body.get("profile", "default")
                    limit_uptime = body.get("limitUptime")
                    limit_bytes = body.get("limitBytesTotal")
                    comment = body.get("comment", "")
                    
                    sock = None
                    try:
                        sock = connect_and_login()
                        params = {
                            ".id": ros_id,
                            "name": name,
                            "profile": profile,
                            "comment": comment
                        }
                        if password is not None: params["password"] = password
                        
                        params["limit-uptime"] = limit_uptime if limit_uptime else "00:00:00"
                        params["limit-bytes-total"] = str(limit_bytes) if limit_bytes else "0"
                        
                        res = execute_command(sock, "/ip/hotspot/user/set", params)
                        add_log(auth_user["username"], 'แก้ไขบัญชี Hotspot', f'แก้ไขผู้ใช้ ID: {ros_id} เป็นชื่อ {name} (โปรไฟล์: {profile})')
                        self.send_json({"success": True, "result": res})
                    except Exception as err:
                        self.send_json({"error": str(err)}, 500)
                    finally:
                        if sock: sock.close()
                return

            else:
                self.send_error(404, "Endpoint not found")
        except Exception as e:
            self.send_json({"error": f"Internal error: {e}"}, 500)

    def do_DELETE(self):
        parsed_url = urllib.parse.urlparse(self.path)
        path = parsed_url.path
        
        try:
            # Delete Local Dashboard User (Admin only)
            if path.startswith("/api/users/"):
                auth_user = self.check_auth(["admin"])
                if auth_user:
                    user_id = path.split("/")[-1]
                    users = get_users()
                    user = next((u for u in users if u["id"] == user_id), None)
                    if not user:
                        self.send_json({"error": "User not found"}, 404)
                        return
                        
                    if user["username"] == "admin":
                        self.send_json({"error": "Cannot delete default system admin account"}, 400)
                        return
                        
                    admins = [u for u in users if u["role"] == "admin"]
                    if len(admins) == 1 and admins[0]["id"] == user_id:
                        self.send_json({"error": "Cannot delete the last administrator account"}, 400)
                        return
                        
                    filtered = [u for u in users if u["id"] != user_id]
                    save_users(filtered)
                    
                    # Force logout sessions
                    tokens_to_del = [token for token, sess in active_sessions.items() if sess["user"]["id"] == user_id]
                    for token in tokens_to_del:
                        active_sessions.pop(token, None)
                        
                    add_log(auth_user["username"], 'ลบบัญชีระบบ', f'ลบบัญชี ID {user_id}')
                    self.send_json({"success": True})
                return

            # Kick Active User Session
            elif path.startswith("/api/mikrotik/hotspot/active/"):
                auth_user = self.check_auth(["admin", "co-admin", "user"])
                if auth_user:
                    ros_id = path.split("/")[-1]
                    sock = None
                    try:
                        sock = connect_and_login()
                        execute_command(sock, "/ip/hotspot/active/remove", {".id": ros_id})
                        add_log(auth_user["username"], 'เตะผู้ใช้ Hotspot', f'ตัดการเชื่อมต่อเซสชัน ID: {ros_id}')
                        self.send_json({"success": True})
                    except Exception as err:
                        self.send_json({"error": str(err)}, 500)
                    finally:
                        if sock: sock.close()
                return

            # Delete Hotspot user account
            elif path.startswith("/api/mikrotik/hotspot/users/"):
                auth_user = self.check_auth(["admin", "co-admin", "user"])
                if auth_user:
                    ros_id = path.split("/")[-1]
                    sock = None
                    try:
                        sock = connect_and_login()
                        execute_command(sock, "/ip/hotspot/user/remove", {".id": ros_id})
                        add_log(auth_user["username"], 'ลบบัญชี Hotspot', f'ลบผู้ใช้ ID: {ros_id}')
                        self.send_json({"success": True})
                    except Exception as err:
                        self.send_json({"error": str(err)}, 500)
                    finally:
                        if sock: sock.close()
                return

            else:
                self.send_error(404, "Endpoint not found")
        except Exception as e:
            self.send_json({"error": f"Internal error: {e}"}, 500)

def run():
    server_address = ('', PORT)
    httpd = HTTPServer(server_address, RouterDashboardHandler)
    print(f"Zero-dependency Python Server is running on http://localhost:{PORT}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping server...")
        httpd.server_close()

if __name__ == '__main__':
    run()
