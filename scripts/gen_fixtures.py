"""Regenerates the synthetic fixture data for the log-viewer and system-dashboard tasks.

Deterministic (fixed seeds), so running it again produces identical files.
Usage: python3 scripts/gen_fixtures.py
"""
import json
import math
import random
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def gen_log() -> None:
    rnd = random.Random(1234)
    t = datetime(2026, 3, 14, 9, 0, 0, tzinfo=timezone.utc)
    modules = ["http", "db", "auth", "cache", "worker", "scheduler"]
    paths = ["/api/users", "/api/orders", "/api/orders/{id}", "/api/search", "/health", "/api/login", "/api/cart"]
    lines = []
    for i in range(420):
        t += timedelta(milliseconds=rnd.randint(40, 2600))
        ts = t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"
        r = rnd.random()
        mod = rnd.choice(modules)
        if 180 <= i < 215 and r < 0.5:
            level, mod = "ERROR", "db"
            msg = rnd.choice([
                "query timeout after 5000ms: SELECT * FROM orders WHERE customer_id = $1",
                "connection pool exhausted (max=20, waiting=14)",
                "replica lag 12.4s exceeds threshold, routing reads to primary",
            ])
        elif r < 0.04:
            level = "ERROR"
            msg = rnd.choice([
                f"upstream timeout calling payments-service ({rnd.randint(3000, 9000)}ms)",
                "failed to refresh session token: signature mismatch",
                f"job {rnd.randint(1000, 9999)} failed: disk quota exceeded",
                "unhandled rejection in order pipeline: TypeError: cannot read properties of undefined (reading 'sku')",
            ])
        elif r < 0.13:
            level = "WARN"
            msg = rnd.choice([
                f"slow request {rnd.choice(paths)} took {rnd.randint(800, 2900)}ms",
                f"cache miss ratio {rnd.randint(30, 60)}% over last minute",
                f"retrying request to inventory-service (attempt {rnd.randint(2, 4)}/5) after timeout",
                "deprecated header X-Client-Version used by 3 clients",
            ])
        elif r < 0.40:
            level = "DEBUG"
            msg = rnd.choice([
                f"cache get key=user:{rnd.randint(100, 999)} hit={rnd.choice(['true', 'false'])}",
                f"db pool stats active={rnd.randint(1, 20)} idle={rnd.randint(0, 10)}",
                f"scheduled task 'cleanup-sessions' next run in {rnd.randint(10, 300)}s",
                f"parsed request body ({rnd.randint(80, 4000)} bytes)",
            ])
        else:
            level = "INFO"
            p = rnd.choice(paths).replace("{id}", str(rnd.randint(10000, 99999)))
            msg = rnd.choice([
                f"{rnd.choice(['GET', 'GET', 'POST', 'PUT'])} {p} {rnd.choice([200, 200, 200, 201, 204, 304, 404])} {rnd.randint(2, 380)}ms",
                f"user {rnd.randint(100, 999)} logged in from 10.0.{rnd.randint(0, 255)}.{rnd.randint(1, 254)}",
                f"order {rnd.randint(10000, 99999)} created (total ${rnd.randint(5, 900)}.{rnd.randint(0, 99):02d})",
                f"worker processed {rnd.randint(1, 64)} jobs in {rnd.randint(20, 900)}ms",
            ])
        lines.append(f"{ts} {level:<5} [{mod}] {msg}")
    (ROOT / "tasks/log-viewer/data/app.log").write_text("\n".join(lines) + "\n")


def gen_metrics() -> None:
    rnd = random.Random(42)
    cores = 8
    samples = []
    rx_total = 0
    for i in range(60):
        base = 35 + 25 * math.sin(i / 9) + (30 if 38 <= i <= 46 else 0)
        cpu = [max(1.0, min(100.0, round(base + rnd.uniform(-18, 18) + (c * 3 if c < 2 else 0), 1))) for c in range(cores)]
        mem_used = round(9.2 + 2.5 * math.sin(i / 14) + (1.8 if i > 40 else 0) + rnd.uniform(-0.2, 0.2), 2)
        rx = int(1800 + 1200 * math.sin(i / 5) ** 2 + rnd.randint(0, 600) + (4000 if 20 <= i <= 24 else 0))
        tx = int(400 + 300 * math.cos(i / 7) ** 2 + rnd.randint(0, 200))
        rx_total += rx
        samples.append({
            "t": i,
            "cpu": cpu,
            "mem": {"usedGiB": mem_used, "totalGiB": 16.0},
            "swap": {"usedGiB": round(0.4 + (0.6 if i > 44 else 0) + rnd.uniform(0, 0.05), 2), "totalGiB": 4.0},
            "net": {"rxKiBps": rx, "txKiBps": tx},
            "load": [round(sum(cpu) / 100 * f + rnd.uniform(0, 0.3), 2) for f in (1.0, 0.85, 0.7)],
        })
    names = [
        ("postgres", "postgres"), ("node server.js", "app"), ("redis-server", "redis"), ("nginx: worker", "www-data"),
        ("chrome --type=renderer", "ada"), ("code", "ada"), ("cargo build", "ada"), ("rust-analyzer", "ada"),
        ("dockerd", "root"), ("containerd", "root"), ("systemd", "root"), ("sshd", "root"), ("python3 etl.py", "app"),
        ("slack", "ada"), ("spotify", "ada"), ("kworker/2:1", "root"), ("Xorg", "root"), ("pipewire", "ada"),
        ("bun run dev", "ada"), ("grafana-server", "grafana"), ("prometheus", "prometheus"), ("cron", "root"),
        ("zsh", "ada"), ("tmux: server", "ada"), ("htop", "ada"),
    ]
    procs = []
    for i, (name, user) in enumerate(names):
        procs.append({
            "pid": 1 if name == "systemd" else 300 + i * 137 % 9000,
            "name": name,
            "user": user,
            "cpu": round(rnd.uniform(0, 4) if i > 9 else rnd.uniform(3, 48), 1),
            "mem": round(rnd.uniform(0.1, 2) if i > 9 else rnd.uniform(1, 14), 1),
            "threads": rnd.randint(1, 64),
            "state": rnd.choice(["running", "sleeping", "sleeping", "sleeping", "idle"]),
            "started": f"2026-03-14T0{rnd.randint(6, 8)}:{rnd.randint(10, 59)}:00Z",
            "command": f"/usr/bin/{name.split()[0]}" + (" " + " ".join(name.split()[1:]) if " " in name else ""),
        })
    data = {
        "host": "ada-workstation",
        "kernel": "Linux 6.8.0-45-generic",
        "uptime": "3 days, 4:12",
        "cores": cores,
        "intervalMs": 100,
        "samples": samples,
        "processes": procs,
    }
    (ROOT / "tasks/system-dashboard/data/metrics.json").write_text(json.dumps(data, indent=1) + "\n")


if __name__ == "__main__":
    (ROOT / "tasks/system-dashboard/data").mkdir(parents=True, exist_ok=True)
    gen_log()
    gen_metrics()
    print("fixtures written")
