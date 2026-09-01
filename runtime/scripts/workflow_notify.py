#!/usr/bin/env python3
"""Herdr Codex-Pi Workflow Notification & Decision Helper (adaptive channel).

Sends multi-channel notifications:
1. Telegram Bot configured through `PI_TELEGRAM_CONFIG`, with inline buttons and document attachments
2. Optional SMTP email configured through `SMTP_*` environment variables
3. Optional macOS Desktop banner with sound (osascript)

Decision collection is ADAPTIVE to avoid two getUpdates consumers on one bot token:
- If the pi-telegram extension is actively polling (see pi_telegram_active()),
  this script is send-only: the user's Telegram text replies flow into the Pi
  session through pi-telegram, and button clicks arrive as `[callback] wf:<event>:<revision>:<action>`.
- If pi-telegram is NOT active (no connect / disconnected), this script becomes
  the sole getUpdates consumer and may poll replies (--wait-response):
  same behavior as before, single consumer, no race.
"""
import argparse
import contextlib
import fcntl
import json
import os
import smtplib
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid
from email.mime.text import MIMEText
from email.header import Header
from email.utils import formataddr

TG_CONFIG_PATH = os.path.expanduser(os.environ.get("PI_TELEGRAM_CONFIG", "~/.pi/agent/telegram.json"))
DEFAULT_EMAIL_TO = os.environ.get("SMTP_TO", "")

def load_tg_config():
    if not os.path.exists(TG_CONFIG_PATH):
        return None, None
    try:
        with open(TG_CONFIG_PATH) as f:
            d = json.load(f)
        profile_name = os.environ.get("PI_TELEGRAM_PROFILE", "default")
        profile = d.get("profiles", {}).get(profile_name, {})
        return profile.get("botToken"), profile.get("allowedUserId")
    except Exception:
        return None, None

def _callback(event: str, action: str, revision: int = None) -> str:
    """Build canonical callback_data, optionally bound to a gate revision."""
    value = f"wf:{event}:{revision}:{action}" if revision is not None else f"wf:{event}:{action}"
    if len(value.encode("utf-8")) > 64:
        raise ValueError("Telegram callback_data exceeds 64 bytes")
    return value


def get_inline_keyboard(event: str, revision: int = None):
    """Build Telegram buttons using the canonical revision-bound wf: namespace."""
    ev = event.lower() if event else ""
    if "architecture" in ev or "arch" in ev:
        rows = [
            [("✅ 批准当前架构方向", "approve"), ("✏️ 要求修订架构", "revise")],
            [("⏸️ 暂停工作流", "pause")],
        ]
        callback_event = "architecture_gate"
    elif "plan" in ev:
        rows = [
            [("✅ 批准计划并开始实施", "approve_and_implement"), ("✏️ 需要微调计划", "adjust_plan")],
            [("⏸️ 暂停工作流", "pause")],
        ]
        callback_event = "plan_approval"
    elif "deploy" in ev:
        rows = [[("🚀 批准部署至测试环境", "approve"), ("❌ 暂不部署", "reject")]]
        callback_event = "deploy_approval"
    elif "escalat" in ev:
        rows = [
            [("✅ 批准额外有界轮次", "continue"), ("⚙️ 调整范围", "revise")],
            [("⏸️ 暂停工作流", "pause")],
        ]
        callback_event = "escalation"
    else:
        return None
    return {
        "inline_keyboard": [
            [{"text": text, "callback_data": _callback(callback_event, action, revision)} for text, action in row]
            for row in rows
        ]
    }

# 决策事件引导文案：直接回复文本即可表达意见/修改点，不必依赖按钮。
DECISION_REPLY_HINT = "\n\n💬 如需表达意见或说明哪里不符合，请直接回复本消息；回复内容会原样进入工作流决策。"

def send_telegram(title: str, message: str, event: str = None, with_buttons: bool = True, revision: int = None) -> tuple:
    token, chat_id = load_tg_config()
    if not token or not chat_id:
        return False, None
    
    emoji_map = {
        "plan_approval": "📐【待审核计划】",
        "awaiting_plan_approval": "📐【待审核计划】",
        "architecture_gate": "🚧【架构门禁决策】",
        "deploy_approval": "🚀【待审批部署】",
        "awaiting_deploy_approval": "🚀【待审批部署】",
        "escalation": "⚡【Hard Stop 终审决策】",
        "complete": "✅【任务完成】",
        "error": "❌【执行异常】",
    }
    header = emoji_map.get(event.lower() if event else "", "🔔【工作流提醒】")
    full_text = f"{header} {title}\n\n{message}"
    if with_buttons and get_inline_keyboard(event, revision):
        full_text += DECISION_REPLY_HINT

    
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload_dict = {
        "chat_id": chat_id,
        "text": full_text
    }
    if with_buttons:
        kb = get_inline_keyboard(event, revision)
        if kb:
            payload_dict["reply_markup"] = kb

    payload = json.dumps(payload_dict).encode("utf-8")
    
    for proxy in [None, "http://127.0.0.1:7890"]:
        try:
            req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
            if proxy:
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
                res = opener.open(req, timeout=8)
            else:
                res = urllib.request.urlopen(req, timeout=5)
            if res.status == 200:
                resp_data = json.loads(res.read().decode("utf-8"))
                msg_id = resp_data.get("result", {}).get("message_id")
                return True, msg_id
        except Exception:
            continue
    return False, None

def send_telegram_document(file_path: str, caption: str = "📄 详细文档附件") -> bool:
    """直接将文件附件发送到 Telegram 会话中，支持手机一键点击打开查看"""
    if not os.path.exists(file_path):
        return False
    token, chat_id = load_tg_config()
    if not token or not chat_id:
        return False

    filename = os.path.basename(file_path)
    with open(file_path, "rb") as f:
        file_content = f.read()

    boundary = "----WebKitFormBoundary7MA4YWxkTrZu0gW"
    body = bytearray()
    body.extend(f"--{boundary}\r\n".encode("utf-8"))
    body.extend(f'Content-Disposition: form-data; name="chat_id"\r\n\r\n{chat_id}\r\n'.encode("utf-8"))
    body.extend(f"--{boundary}\r\n".encode("utf-8"))
    body.extend(f'Content-Disposition: form-data; name="caption"\r\n\r\n{caption}\r\n'.encode("utf-8"))
    body.extend(f"--{boundary}\r\n".encode("utf-8"))
    body.extend(f'Content-Disposition: form-data; name="document"; filename="{filename}"\r\nContent-Type: text/markdown\r\n\r\n'.encode("utf-8"))
    body.extend(file_content)
    body.extend(f"\r\n--{boundary}--\r\n".encode("utf-8"))

    req = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/sendDocument",
        data=bytes(body),
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"}
    )
    for proxy in [None, "http://127.0.0.1:7890"]:
        try:
            if proxy:
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
                res = opener.open(req, timeout=12)
            else:
                res = urllib.request.urlopen(req, timeout=10)
            if res.status == 200:
                return True
        except Exception:
            continue
    return False

def pi_telegram_active(stale_seconds: int = 120) -> tuple:
    """检测 pi-telegram 扩展是否正在活跃长轮询（避免双 getUpdates 消费者）。

    返回 (active: bool, detail: str)。
    判定：state.json 存在且 runtime.pollingActive=True 且 lockState 表明本地持有
    且最近一次成功响应时间距现在不超过 stale_seconds（文件可能是 stale 残留）。
    """
    state_path = os.path.expanduser(os.environ.get("PI_TELEGRAM_STATE", "~/.pi/agent/tmp/telegram/state.json"))
    if not os.path.exists(state_path):
        return False, "pi-telegram state.json 不存在（未连接或从未 connect）"
    try:
        with open(state_path) as f:
            d = json.load(f)
    except Exception as e:
        return False, f"state.json 解析失败: {e}"
    runtime = d.get("runtime") or {}
    if not runtime.get("pollingActive"):
        return False, "pollingActive=false（pi-telegram 未在轮询）"
    lock = (runtime.get("lockState") or "").lower()
    if "here" not in lock and "local" not in lock:
        return False, f"lockState 非本地持有: {runtime.get('lockState')}"
    last = runtime.get("polling", {}).get("lastSuccessfulResponseAtMs") or 0
    age = (time.time() * 1000) - last
    if age > stale_seconds * 1000:
        return False, f"最近成功响应 {age/1000:.0f}s 前，超过 {stale_seconds}s 新鲜度阈值（可能 stale）"
    return True, f"pi-telegram 活跃轮询中（{age/1000:.0f}s 前有响应）"


def poll_telegram_response(timeout_seconds: int = 1800) -> str:
    """作为唯一 getUpdates 消费者时轮询用户的按钮点击或文本回复。

    仅在 pi_telegram_active() == False 时调用（此时无消费者竞争）。
    callback_data 使用 `wf:<event>:<revision>:<action>`；历史 `hdrw:` 输入仍兼容，返回原值供 Coordinator 解析。
    """
    token, chat_id = load_tg_config()
    if not token or not chat_id:
        return None

    proxy = "http://127.0.0.1:7890"
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({"http": proxy, "https": proxy}))

    offset = 0
    try:
        res = opener.open(f"https://api.telegram.org/bot{token}/getUpdates?offset=-1", timeout=5)
        d = json.loads(res.read().decode("utf-8"))
        updates = d.get("result", [])
        if updates:
            offset = updates[-1]["update_id"] + 1
    except Exception:
        pass

    start_time = time.time()
    while time.time() - start_time < timeout_seconds:
        try:
            url = f"https://api.telegram.org/bot{token}/getUpdates?offset={offset}&timeout=10"
            res = opener.open(url, timeout=15)
            d = json.loads(res.read().decode("utf-8"))
            for update in d.get("result", []):
                offset = update["update_id"] + 1

                if "callback_query" in update:
                    cb = update["callback_query"]
                    if str(cb.get("from", {}).get("id")) == str(chat_id):
                        data = cb.get("data")
                        try:
                            ack_url = f"https://api.telegram.org/bot{token}/answerCallbackQuery?callback_query_id={cb['id']}&text=已接收决策"
                            opener.open(ack_url, timeout=3)
                        except Exception:
                            pass
                        return data

                if "message" in update:
                    msg = update["message"]
                    if str(msg.get("from", {}).get("id")) == str(chat_id):
                        text = msg.get("text", "").strip()
                        if text:
                            return text
        except Exception:
            time.sleep(2)
            continue
        time.sleep(1)
    return None


def send_email(title: str, message: str, event: str = None, recipient: str = DEFAULT_EMAIL_TO) -> bool:
    smtp_server = os.environ.get("SMTP_SERVER", "")
    smtp_port = int(os.environ.get("SMTP_PORT", 587))
    smtp_from = os.environ.get("SMTP_FROM", "")
    smtp_pass = os.environ.get("SMTP_PASS", "")
    # Prefer SMTP_TO from env, fall back to recipient arg, then default
    recipient = os.environ.get("SMTP_TO", recipient or DEFAULT_EMAIL_TO)
    smtp_ssl = os.environ.get("SMTP_SSL", "false").lower() in ("true", "1", "yes")

    if not smtp_server or not smtp_from or not recipient or not smtp_pass:
        return False

    emoji_map = {
        "plan_approval": "📐【待审核计划】",
        "awaiting_plan_approval": "📐【待审核计划】",
        "architecture_gate": "🚧【架构门禁决策】",
        "deploy_approval": "🚀【待审批部署】",
        "awaiting_deploy_approval": "🚀【待审批部署】",
        "escalation": "⚡【Hard Stop 终审决策】",
        "complete": "✅【任务完成】",
        "error": "❌【执行异常】",
    }
    header = emoji_map.get(event.lower() if event else "", "🔔【工作流提醒】")
    subject = f"{header} {title}"

    body = f"""您好！

这是来自 Herdr Codex-Pi 工作流的实时任务通知。

【通知事项】：{subject}

【详细内容】：
{message}

---
如需决策，请在已配置的 Telegram 会话中点击按钮或回复选项。
"""
    msg = MIMEText(body, "plain", "utf-8")
    msg["From"] = formataddr((Header("Herdr 工作流助手", "utf-8").encode(), smtp_from))
    msg["To"] = recipient
    msg["Subject"] = Header(subject, "utf-8")

    try:
        if smtp_ssl:
            server = smtplib.SMTP_SSL(smtp_server, smtp_port, timeout=15)
        else:
            server = smtplib.SMTP(smtp_server, smtp_port, timeout=15)
            server.starttls()
        server.login(smtp_from, smtp_pass)
        server.sendmail(smtp_from, [recipient], msg.as_string())
        server.quit()
        return True
    except Exception as e:
        print("Email send error:", e, file=sys.stderr)
        return False

def send_macos_desktop(title: str, message: str):
    if sys.platform != "darwin":
        return
    clean_title = title.replace('"', '\\"')
    clean_msg = message.replace('"', '\\"').replace('\n', ' ')[:120]
    script = f'display notification "{clean_msg}" with title "Herdr: {clean_title}" sound name "Glass"'
    try:
        subprocess.run(["osascript", "-e", script], capture_output=True, timeout=5)
    except Exception:
        pass

def enforce_delivery_gate(run_dir: str = None, docs_dir: str = None) -> bool:
    """对明确的 run 执行严格交付证据门禁；不猜任务，不生成占位证据。"""
    script_path = os.environ.get("HERDR_WORKFLOW_SCRIPT") or os.path.join(os.path.dirname(__file__), "herdr-workflow.mjs")
    if not os.path.exists(script_path):
        print("❌ [DELIVERY_GATE_BLOCKED] 缺少 herdr-workflow.mjs，禁止发送完成通知。", file=sys.stderr)
        return False

    if not run_dir:
        print("❌ [DELIVERY_GATE_BLOCKED] complete 通知必须显式传入 --run；禁止从 active/latest 任务猜测。", file=sys.stderr)
        return False
    run_dir = os.path.abspath(os.path.expanduser(run_dir))
    if not os.path.exists(run_dir):
        print(f"❌ [DELIVERY_GATE_BLOCKED] run 目录不存在: {run_dir}", file=sys.stderr)
        return False

    cmd = ["node", script_path, "verify-delivery-gate", "--run", run_dir]
    if docs_dir:
        cmd.extend(["--docs-dir", os.path.abspath(os.path.expanduser(docs_dir))])

    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode == 0:
        return True

    print("❌ [DELIVERY_GATE_BLOCKED] 严格交付证据门禁未通过，禁止发送任务完成通知。", file=sys.stderr)
    print(res.stdout or res.stderr, file=sys.stderr)
    return False

def normalize_decision_choice(value: str) -> str:
    """Normalize canonical or legacy callback_data to its final choice segment."""
    for prefix in ("wf:", "hdrw:"):
        if value.startswith(prefix):
            value = value[len(prefix):]
            break
    return value.rsplit(":", 1)[-1]


def append_decision(run_dir: str, event: str, raw_choice: str, channel: str):
    """Append through the workflow command so decisions share the run lock and scope binding."""
    script_path = os.environ.get("HERDR_WORKFLOW_SCRIPT") or os.path.join(os.path.dirname(__file__), "herdr-workflow.mjs")
    gate_revision = None
    if raw_choice.startswith("wf:"):
        parts = raw_choice.split(":", 3)
        if len(parts) == 4:
            callback_event, revision_text = parts[1], parts[2]
            if callback_event != event:
                raise RuntimeError(f"callback event {callback_event} does not match expected gate {event}")
            try:
                gate_revision = int(revision_text)
            except ValueError as exc:
                raise RuntimeError("canonical callback is missing a numeric gate revision") from exc
    cmd = [
        "node", script_path, "record-decision",
        "--run", run_dir,
        "--event", event,
        "--choice", normalize_decision_choice(raw_choice),
        "--original-text", raw_choice,
        "--channel", channel,
    ]
    if gate_revision is not None:
        cmd.extend(["--gate-revision", str(gate_revision)])
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        raise RuntimeError(result.stderr or result.stdout or "record-decision failed")
    return json.loads(result.stdout)


NOTIFICATION_LEDGER = "notifications.json"
NOTIFICATION_EVENTS = "notification-events.jsonl"
GATE_EVENTS = {
    "plan_approval": "AWAITING_PLAN_APPROVAL",
    "architecture_gate": "ARCHITECTURE_GATE",
    "escalation": "ESCALATED",
    "deploy_approval": "AWAITING_DEPLOY_APPROVAL",
    "complete": "COMPLETE",
}


def utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def atomic_json(path: str, value) -> None:
    parent = os.path.dirname(path)
    os.makedirs(parent, exist_ok=True)
    fd, temp_path = tempfile.mkstemp(prefix=f".{os.path.basename(path)}.", dir=parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temp_path)


def append_notification_event(run_dir: str, event: dict) -> None:
    with open(os.path.join(run_dir, NOTIFICATION_EVENTS), "a", encoding="utf-8") as handle:
        handle.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n")
        handle.flush()
        os.fsync(handle.fileno())


@contextlib.contextmanager
def notification_lock(run_dir: str):
    lock_path = os.path.join(run_dir, ".notification.lock")
    with open(lock_path, "a+", encoding="utf-8") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def load_ledger(run_dir: str) -> dict:
    path = os.path.join(run_dir, NOTIFICATION_LEDGER)
    try:
        with open(path, encoding="utf-8") as handle:
            value = json.load(handle)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        value = None
    if not isinstance(value, dict):
        value = {"schema_version": 1, "run_id": os.path.basename(run_dir), "notifications": []}
    if not isinstance(value.get("notifications"), list):
        value["notifications"] = []
    return value


def save_ledger(run_dir: str, ledger: dict) -> None:
    ledger["updated_at"] = utc_now()
    atomic_json(os.path.join(run_dir, NOTIFICATION_LEDGER), ledger)


def latest_state_entry_revision(run_dir: str, status: str, fallback: int) -> int:
    try:
        with open(os.path.join(run_dir, "events.jsonl"), encoding="utf-8") as handle:
            lines = handle.read().splitlines()
    except OSError:
        return fallback
    for line in reversed(lines):
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("kind") in ("transition", "round_created") and event.get("to") == status:
            try:
                return int(event.get("revision", fallback))
            except (TypeError, ValueError):
                return fallback
    return fallback


def open_findings(run_dir: str) -> list:
    try:
        with open(os.path.join(run_dir, "FINDINGS.json"), encoding="utf-8") as handle:
            value = json.load(handle)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return []
    findings = value.get("findings", []) if isinstance(value, dict) else value
    terminal = {"VERIFIED_CLOSED", "DEFERRED_BY_USER", "ACCEPTED_BY_USER", "OUT_OF_SCOPE_BY_USER"}
    return [str(item.get("id")) for item in findings if isinstance(item, dict) and item.get("id") and str(item.get("status", "")).upper() not in terminal]


def notification_spec_from_state(run_dir: str):
    try:
        with open(os.path.join(run_dir, "state.json"), encoding="utf-8") as handle:
            state = json.load(handle)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None
    status = str(state.get("status", ""))
    event = next((name for name, expected in GATE_EVENTS.items() if expected == status), None)
    if not event:
        return None
    run_id = str(state.get("run_id") or os.path.basename(run_dir))
    revision = latest_state_entry_revision(run_dir, status, int(state.get("state_revision", 0) or 0))
    round_number = int(state.get("current_round", 0) or 0)
    objective = str(state.get("objective") or run_id)
    title = f"[Herdr] {run_id}"
    attachment = None
    if event == "plan_approval":
        title += " 计划待审批"
        summary = os.path.join(run_dir, "PLAN-SUMMARY.md")
        plan = str(state.get("active_plan_path") or os.path.join(run_dir, "PLAN.md"))
        attachment = summary if os.path.exists(summary) else (plan if os.path.exists(plan) else None)
        message = f"计划已就绪，等待明确决定。\n任务：{objective}\n计划 SHA256：{state.get('active_plan_sha256') or '未记录'}"
    elif event == "architecture_gate":
        title += " 架构门禁待决策"
        review = os.path.join(run_dir, "rounds", f"{round_number:02d}", "REVIEW.md")
        attachment = review if os.path.exists(review) else None
        ids = open_findings(run_dir)
        message = f"独立 Review 触发架构决策门。\n开放 Finding：{', '.join(ids) if ids else '未登记'}\n批准不会自动授权额外轮次、部署或清理。"
    elif event == "escalation":
        title += " 额外轮次待审批"
        message = f"工作流达到 hard stop，需要明确批准额外轮次。\n开放 Finding：{', '.join(open_findings(run_dir)) or '未登记'}"
    elif event == "deploy_approval":
        title += " 部署待审批"
        attachment = os.path.join(run_dir, "DEPLOYMENT.md") if os.path.exists(os.path.join(run_dir, "DEPLOYMENT.md")) else None
        message = f"本地门禁已通过，等待部署授权。\n审核 commit：{json.dumps(state.get('reviewed_commits') or state.get('reviewed_commit'), ensure_ascii=False)}"
    else:
        title += " 工作流已完成"
        attachment = os.path.join(run_dir, "README.md") if os.path.exists(os.path.join(run_dir, "README.md")) else None
        message = f"任务已完成并通过最终门禁。\n任务：{objective}"
    return {
        "notification_id": f"{run_id}:{revision}:{event}",
        "event": event,
        "state": status,
        "state_revision": revision,
        "title": title,
        "message": message,
        "attachment": attachment,
    }


def enqueue(run_dir: str, spec: dict, ledger: dict) -> dict:
    existing = next((item for item in ledger["notifications"] if item.get("notification_id") == spec["notification_id"]), None)
    if existing:
        return existing
    now = utc_now()
    item = {**spec, "status": "pending", "created_at": now, "updated_at": now, "deliveries": {}, "attempts": []}
    ledger["notifications"].append(item)
    save_ledger(run_dir, ledger)
    append_notification_event(run_dir, {
        "event_id": f"{spec['notification_id']}:enqueued",
        "timestamp": now,
        "kind": "notification_enqueued",
        "notification_id": spec["notification_id"],
        "workflow_event": spec["event"],
        "state": spec["state"],
        "state_revision": spec["state_revision"],
    })
    return item


def dispatch_item(run_dir: str, ledger: dict, item: dict) -> dict:
    if item.get("status") == "sent":
        return {"notification_id": item["notification_id"], "status": "sent", "reached_user": True, "deduplicated": True}
    if item.get("event") == "complete" and not enforce_delivery_gate(run_dir):
        item["status"] = "failed"
        item["updated_at"] = utc_now()
        save_ledger(run_dir, ledger)
        return {"notification_id": item["notification_id"], "status": "failed", "reached_user": False, "error": "delivery gate failed"}
    attempt_id = f"{item['notification_id']}:attempt:{len(item.get('attempts', [])) + 1}"
    attempt = {"attempt_id": attempt_id, "started_at": utc_now(), "channels": {}}
    item.setdefault("attempts", []).append(attempt)
    item["status"] = "dispatching"
    save_ledger(run_dir, ledger)
    deliveries = item.setdefault("deliveries", {})
    if deliveries.get("desktop", {}).get("ok"):
        attempt["channels"]["desktop"] = {"skipped": "already_delivered"}
    else:
        send_macos_desktop(item["title"], item["message"])
        deliveries["desktop"] = {"ok": True, "at": utc_now()}
        attempt["channels"]["desktop"] = deliveries["desktop"]
    if deliveries.get("telegram", {}).get("ok"):
        attempt["channels"]["telegram"] = {"skipped": "already_delivered"}
    else:
        ok, message_id = send_telegram(item["title"], item["message"], item["event"], with_buttons=True, revision=item.get("state_revision"))
        deliveries["telegram"] = {"ok": ok, "message_id": message_id, "at": utc_now()}
        attempt["channels"]["telegram"] = deliveries["telegram"]
    attachment = item.get("attachment")
    if attachment:
        if deliveries.get("telegram_attachment", {}).get("ok"):
            attempt["channels"]["telegram_attachment"] = {"skipped": "already_delivered"}
        elif deliveries.get("telegram", {}).get("ok"):
            ok = send_telegram_document(attachment, f"📄 {os.path.basename(attachment)}")
            deliveries["telegram_attachment"] = {"ok": ok, "at": utc_now()}
            attempt["channels"]["telegram_attachment"] = deliveries["telegram_attachment"]
    if deliveries.get("email", {}).get("ok"):
        attempt["channels"]["email"] = {"skipped": "already_delivered"}
    else:
        ok = send_email(item["title"], item["message"], item["event"])
        deliveries["email"] = {"ok": ok, "at": utc_now()}
        attempt["channels"]["email"] = deliveries["email"]
    telegram_ok = deliveries.get("telegram", {}).get("ok") is True
    email_ok = deliveries.get("email", {}).get("ok") is True
    attachment_ok = not attachment or deliveries.get("telegram_attachment", {}).get("ok") is True
    if telegram_ok and email_ok and attachment_ok:
        status = "sent"
    elif telegram_ok or email_ok:
        status = "partial"
    else:
        status = "failed"
    attempt["completed_at"] = utc_now()
    attempt["status"] = status
    item["status"] = status
    item["updated_at"] = attempt["completed_at"]
    save_ledger(run_dir, ledger)
    append_notification_event(run_dir, {
        "event_id": attempt_id,
        "timestamp": attempt["completed_at"],
        "kind": "notification_attempted",
        "notification_id": item["notification_id"],
        "status": status,
        "reached_user": telegram_ok or email_ok,
        "channels": attempt["channels"],
    })
    return {"notification_id": item["notification_id"], "status": status, "reached_user": telegram_ok or email_ok, "attempt_id": attempt_id, "deliveries": deliveries}


def enqueue_and_dispatch(run_dir: str, spec: dict) -> dict:
    with notification_lock(run_dir):
        ledger = load_ledger(run_dir)
        item = enqueue(run_dir, spec, ledger)
        return dispatch_item(run_dir, ledger, item)


def retry_pending(run_dir: str) -> list:
    results = []
    with notification_lock(run_dir):
        ledger = load_ledger(run_dir)
        for item in ledger["notifications"]:
            if item.get("status") in {"pending", "partial", "failed"}:
                results.append(dispatch_item(run_dir, ledger, item))
    return results


def main():
    parser = argparse.ArgumentParser(description="Workflow multi-channel notification & decision helper")
    parser.add_argument("--title")
    parser.add_argument("--message")
    parser.add_argument("--event", choices=sorted(GATE_EVENTS))
    parser.add_argument("--email", default=DEFAULT_EMAIL_TO)
    parser.add_argument("--run")
    parser.add_argument("--docs-dir")
    parser.add_argument("--attachment")
    parser.add_argument("--wait-response", action="store_true")
    parser.add_argument("--timeout", type=int, default=1800)
    parser.add_argument("--force-poll", action="store_true")
    parser.add_argument("--notify-current", action="store_true")
    parser.add_argument("--retry-pending", action="store_true")
    parser.add_argument("--status-json", action="store_true")
    args = parser.parse_args()

    if os.environ.get("HERDR_WORKFLOW_NOTIFY_DISABLED") == "1":
        print(json.dumps({"ok": True, "disabled": True}, ensure_ascii=False))
        return 0
    run_dir = os.path.abspath(os.path.expanduser(args.run)) if args.run else None
    if args.status_json:
        if not run_dir:
            parser.error("--status-json requires --run")
        print(json.dumps(load_ledger(run_dir), ensure_ascii=False, indent=2))
        return 0
    if args.retry_pending:
        if not run_dir:
            parser.error("--retry-pending requires --run")
        results = retry_pending(run_dir)
        print(json.dumps({"retried": len(results), "results": results}, ensure_ascii=False, indent=2))
        return 0 if all(item.get("reached_user") for item in results) else (1 if results else 0)
    if args.notify_current:
        if not run_dir:
            parser.error("--notify-current requires --run")
        spec = notification_spec_from_state(run_dir)
        if spec is None:
            print(json.dumps({"status": "not_applicable"}, ensure_ascii=False))
            return 0
        result = enqueue_and_dispatch(run_dir, spec)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        if not args.title or not args.message or not args.event:
            parser.error("manual notification requires --title, --message and --event")
        if run_dir:
            try:
                with open(os.path.join(run_dir, "state.json"), encoding="utf-8") as handle:
                    state = json.load(handle)
            except (FileNotFoundError, json.JSONDecodeError, OSError):
                state = {}
            revision = latest_state_entry_revision(run_dir, str(state.get("status", "")), int(state.get("state_revision", 0) or 0))
            spec = {
                "notification_id": f"{state.get('run_id') or os.path.basename(run_dir)}:{revision}:{args.event}",
                "event": args.event,
                "state": state.get("status"),
                "state_revision": revision,
                "title": args.title,
                "message": args.message,
                "attachment": args.attachment,
            }
            result = enqueue_and_dispatch(run_dir, spec)
            print(json.dumps(result, ensure_ascii=False, indent=2))
        else:
            tg_ok, message_id = send_telegram(args.title, args.message, args.event, with_buttons=True)
            email_ok = send_email(args.title, args.message, args.event, args.email)
            send_macos_desktop(args.title, args.message)
            result = {"telegram": {"ok": tg_ok, "message_id": message_id}, "email": {"ok": email_ok}, "desktop": {"ok": True}}
            print(json.dumps(result, ensure_ascii=False, indent=2))

    telegram_ok = result.get("deliveries", {}).get("telegram", {}).get("ok") if isinstance(result, dict) else False
    if args.wait_response and telegram_ok:
        active, detail = pi_telegram_active()
        if active and not args.force_poll:
            print(f"[CHANNEL:PI_TELEGRAM] {detail}。按钮以 [callback] wf:* 进入当前 Pi 会话；本脚本不轮询。", file=sys.stderr)
        else:
            user_choice = poll_telegram_response(args.timeout)
            if user_choice and run_dir:
                append_decision(run_dir, args.event, user_choice, "fallback_poll")
    reached = result.get("reached_user") if isinstance(result, dict) else False
    if reached is None:
        reached = bool(result.get("telegram", {}).get("ok") or result.get("email", {}).get("ok"))
    return 0 if reached else 1


if __name__ == "__main__":
    raise SystemExit(main())

