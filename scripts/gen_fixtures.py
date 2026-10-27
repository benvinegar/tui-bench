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




def gen_mailbox() -> None:
    me = {"name": "Ada Park", "email": "ada@northwind.dev"}
    people = {
        "priya": {"name": "Priya Raman", "email": "priya@northwind.dev"},
        "tom": {"name": "Tom Okafor", "email": "tom@northwind.dev"},
        "lena": {"name": "Lena Fischer", "email": "lena.fischer@acme-design.co"},
        "billing": {"name": "Cloudnine Billing", "email": "billing@cloudnine.io"},
        "github": {"name": "GitHub", "email": "notifications@github.com"},
        "marco": {"name": "Marco Bellini", "email": "marco@bellini.studio"},
        "hr": {"name": "Northwind People Team", "email": "people@northwind.dev"},
        "sam": {"name": "Sam Lee", "email": "sam.lee@gmail.com"},
        "news": {"name": "Terminal Weekly", "email": "hello@terminalweekly.com"},
    }
    msgs = [
        ("inbox", "priya", "2026-03-12T13:58:00Z", "Q2 planning offsite: agenda draft", False, True, [],
         "Hi Ada,\n\nHere's the first draft of the agenda for the offsite on the 26th. I kept the mornings for strategy and the afternoons for team breakouts.\n\nDay 1\n- 09:30 Welcome and goals for Q2\n- 10:00 Product roadmap review (you + Tom)\n- 13:30 Breakouts by team\n\nDay 2\n- 09:30 Customer panel\n- 11:00 Hiring plan\n- 14:00 Wrap-up and owners\n\nCan you take the roadmap session? Let me know by Friday.\n\nThanks,\nPriya"),
        ("inbox", "github", "2026-03-12T12:41:00Z", "[northwind/api] Fix race in session refresh (#1482)", False, False, [],
         "tom-okafor requested your review on this pull request.\n\nThe session refresh could run twice when two requests arrived within the same tick, which invalidated the newer token. This change adds a per-user lock and a regression test.\n\n3 files changed, 84 additions, 12 deletions."),
        ("inbox", "lena", "2026-03-12T10:15:00Z", "Re: Dashboard redesign - round 2", True, False, [{"name": "dashboard-v2.fig", "size": 4823112}, {"name": "notes.pdf", "size": 182044}],
         "Hi Ada,\n\nThanks for the feedback on round 1. In this round:\n\n1. The navigation moved to a collapsible sidebar.\n2. Charts use the new color scale, which is readable for color-blind users.\n3. Empty states have illustrations and a clear next step.\n\nThe Figma file and my notes are attached. Could we review together on Monday at 15:00?\n\nBest,\nLena\n\n> On Mar 5, Ada Park wrote:\n> The KPI row feels crowded. Can we try fewer, bigger numbers?"),
        ("inbox", "billing", "2026-03-11T16:02:00Z", "Your invoice for March is ready", False, False, [{"name": "invoice-2026-03.pdf", "size": 48211}],
         "Hello,\n\nYour invoice INV-20419 for March 2026 is ready.\n\nAmount due: $1,284.00\nDue date: March 25, 2026\n\nThe PDF is attached. You can also view it in the billing dashboard.\n\nCloudnine Billing"),
        ("inbox", "tom", "2026-03-11T09:30:00Z", "Lunch Thursday?", True, False, [],
         "Want to grab lunch on Thursday? The new ramen place on 5th opened last week. 12:30?\n\nTom"),
        ("inbox", "hr", "2026-03-10T08:00:00Z", "Reminder: submit your expense reports", True, False, [],
         "Hi all,\n\nA reminder that February expense reports are due this Friday. Please attach receipts for anything over $25.\n\nThanks,\nThe People Team"),
        ("inbox", "marco", "2026-03-09T18:45:00Z", "Invoice #2026-014 - illustration work", True, True, [{"name": "invoice-2026-014.pdf", "size": 96320}],
         "Hi Ada,\n\nPlease find attached my invoice for the onboarding illustrations (12 pieces). Payment terms are 30 days.\n\nIt was a pleasure working with you!\n\nMarco"),
        ("inbox", "sam", "2026-03-08T11:20:00Z", "Photos from the hike", True, False, [{"name": "IMG_2041.jpg", "size": 3201114}],
         "The one from the ridge came out great. More in the shared album!\n\nSam"),
        ("inbox", "news", "2026-03-07T07:00:00Z", "Terminal Weekly #212: TUIs are back", True, False, [],
         "This week: why terminal UIs are having a moment, a deep dive into the kitty keyboard protocol, and five TUI apps we can't stop using."),
        ("sent", "priya", "2026-03-11T15:10:00Z", "Re: Headcount for Q2", True, False, [],
         "Priya, two engineers and one designer is what we need. I'll write up the reasoning before the offsite.\n\nAda"),
        ("drafts", "lena", "2026-03-06T17:00:00Z", "Re: Dashboard redesign", True, False, [],
         "Hi Lena, thanks for round 1! A few thoughts:\n- The KPI row feels crowded"),
        ("archive", "tom", "2026-02-27T14:00:00Z", "Postmortem: Feb 26 outage", True, False, [],
         "Root cause: an expired certificate on the internal load balancer. Action items are in the doc."),
        ("trash", "news", "2026-02-28T07:00:00Z", "Terminal Weekly #211", True, False, [], "Last week's issue."),
    ]
    out = []
    for i, (folder, who, date, subject, read, starred, att, body) in enumerate(msgs, 1):
        sender, recipient = (me, people[who]) if folder in ("sent", "drafts") else (people[who], me)
        out.append({
            "id": f"m{i:02d}", "folder": folder, "from": sender, "to": [recipient], "cc": [],
            "date": date, "subject": subject, "body": body, "read": read, "starred": starred, "attachments": att,
        })
    data = {
        "account": me,
        "now": "2026-03-12T14:30:00Z",
        "folders": ["Inbox", "Starred", "Sent", "Drafts", "Archive", "Trash"],
        "messages": out,
    }
    (ROOT / "tasks/mail-client/data/mailbox.json").write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")


def gen_chat() -> None:
    users = {
        "ada": {"name": "Ada Park", "title": "Engineering lead", "status": "online"},
        "priya": {"name": "Priya Raman", "title": "Head of Product", "status": "online"},
        "tom": {"name": "Tom Okafor", "title": "Backend engineer", "status": "away"},
        "lena": {"name": "Lena Fischer", "title": "Designer (Acme Design)", "status": "online"},
        "sam": {"name": "Sam Lee", "title": "Support", "status": "offline"},
        "deploybot": {"name": "deploybot", "title": "Bot", "status": "online", "bot": True},
    }

    def m(id_, author, ts, text, reactions=None, replies=None):
        return {"id": id_, "author": author, "ts": f"2026-03-12T{ts}:00Z", "text": text,
                "reactions": reactions or [], "replies": replies or []}

    channels = [
        {"id": "general", "name": "general", "topic": "Company-wide announcements and questions", "lastRead": "2026-03-12T11:00:00Z",
         "messages": [
             m("g1", "priya", "09:02", "Good morning! Reminder that the Q2 offsite agenda draft is in your inbox. Comments welcome until Friday."),
             m("g2", "tom", "09:15", "Thanks Priya. Can we add 30 minutes for the infra roadmap?", [{"emoji": "👍", "users": ["priya", "ada"]}]),
             m("g3", "priya", "09:16", "Yes, added it after lunch on day 1."),
             m("g4", "sam", "10:40", "Heads up: the help center will be read-only from 18:00 to 19:00 tonight for the migration."),
             m("g5", "deploybot", "11:32", "✅ api v1.48.2 deployed to production (12 commits, by tom)"),
             m("g6", "lena", "12:05", "Round 2 of the dashboard redesign is up in Figma. Feedback in #design please!", [{"emoji": "🎉", "users": ["priya", "tom", "sam"]}]),
             m("g7", "tom", "13:47", "Who's in for ramen on Thursday? 12:30 at the new place on 5th."),
         ]},
        {"id": "design", "name": "design", "topic": "Dashboard redesign, round 2: feedback by Monday", "lastRead": "2026-03-12T08:00:00Z",
         "messages": [
             m("d1", "lena", "09:30", "Uploaded round 2: collapsible sidebar, new color scale, empty states with illustrations."),
             m("d2", "priya", "10:02", "Love the empty states. The sidebar icons feel a bit small though."),
             m("d3", "lena", "10:05", "Good point, I'll try 20px instead of 16px."),
             m("d4", "ada", "11:48", "Can we check the new color scale against deuteranopia? Some of the greens and oranges look close.",
               [{"emoji": "👀", "users": ["lena"]}],
               [m("d4r1", "lena", "11:55", "Ran it through the simulator: green and orange are too close in the area chart."),
                m("d4r2", "lena", "12:01", "Switching orange to a magenta. Updated frames are on page 3."),
                m("d4r3", "priya", "12:10", "Much better, thanks both!")]),
             m("d5", "tom", "13:20", "Does the new KPI row need any new API fields? Happy to add them this sprint."),
             m("d6", "lena", "14:02", "Just two: previous-period value and trend direction. I'll write it up."),
         ]},
        {"id": "eng-backend", "name": "eng-backend", "topic": "API, data and infrastructure", "lastRead": "2026-03-12T14:00:00Z",
         "messages": [
             m("e1", "tom", "12:41", "PR for the session refresh race is up: #1482. Ada, could you review?"),
             m("e2", "ada", "12:58", "On it after lunch."),
         ]},
        {"id": "random", "name": "random", "topic": "Non-work banter", "lastRead": "2026-03-11T18:00:00Z",
         "messages": [
             m("r1", "sam", "08:12", "Photos from Sunday's hike are in the shared album 🏔️"),
             m("r2", "tom", "08:30", "That ridge shot is great."),
         ]},
        {"id": "releases", "name": "releases", "topic": "Release coordination for 2.0", "lastRead": "2026-03-12T14:30:00Z",
         "messages": [m("x1", "priya", "08:00", "2.0 launch is Friday 09:00 PT. Checklist is pinned.")]},
    ]
    dms = [
        {"id": "dm-priya", "user": "priya", "lastRead": "2026-03-12T13:00:00Z",
         "messages": [m("p1", "priya", "13:40", "Can you take the roadmap session at the offsite?"),
                      m("p2", "priya", "13:41", "No rush, Friday is fine.")]},
        {"id": "dm-tom", "user": "tom", "lastRead": "2026-03-12T14:30:00Z",
         "messages": [m("t1", "tom", "09:31", "Lunch Thursday?"), m("t2", "ada", "09:40", "Yes! 12:30 works.")]},
    ]
    data = {"workspace": "Northwind", "me": "ada", "now": "2026-03-12T14:30:00Z", "users": users,
            "channels": channels, "dms": dms}
    (ROOT / "tasks/chat-client/data/chat.json").write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")


def gen_calendar() -> None:
    def ev(id_, title, day, start, end, cal, location="", attendees=(), description=""):
        all_day = start is None
        return {
            "id": id_, "title": title, "calendar": cal, "allDay": all_day,
            "start": f"2026-03-{day:02d}" if all_day else f"2026-03-{day:02d}T{start}",
            "end": f"2026-03-{day:02d}" if all_day else f"2026-03-{day:02d}T{end}",
            "location": location, "attendees": list(attendees), "description": description,
        }

    events = []
    n = 0

    def add(*a, **k):
        nonlocal n
        n += 1
        events.append(ev(f"e{n:02d}", *a, **k))

    for day in (9, 10, 11, 12, 13, 16, 17, 18, 19, 20):
        add("Standup", day, "09:30", "09:45", "work", "Video call", ["Engineering team"])
    add("Design review", 9, "11:00", "12:00", "work", "Room Atlas", ["Lena Fischer", "Priya Raman", "Ada Park"],
        "Round 2 of the dashboard redesign. Please look at the Figma file beforehand.")
    add("1:1 with Priya", 9, "15:00", "15:30", "work", "Priya's office", ["Priya Raman", "Ada Park"])
    add("Sprint planning", 10, "10:00", "11:30", "work", "Room Orion", ["Engineering team"])
    add("Gym", 10, "18:00", "19:00", "personal", "Northside Climbing")
    add("Hiring sync", 11, "13:00", "14:00", "work", "Room Atlas", ["Priya Raman", "Tom Okafor", "Ada Park"])
    add("Interview: backend candidate", 11, "13:30", "14:30", "work", "Video call", ["Tom Okafor", "Ada Park"])
    add("Dinner with Sam", 11, "19:30", "21:00", "personal", "Osteria Lupa")
    add("Release readiness", 12, "10:00", "11:00", "work", "Room Orion", ["Engineering team", "Sam Lee"])
    add("Lunch with Tom", 12, "12:30", "13:30", "personal", "Ramen Kazu, 5th Ave")
    add("PR review block", 12, "14:00", "16:00", "work", "", [], "Focus time. Session refresh fix (#1482) first.")
    add("Launch prep", 13, "09:00", "12:00", "work", "Room Orion", ["Engineering team", "Priya Raman"])
    add("Team demo", 13, "16:00", "17:00", "work", "All-hands room", ["Everyone"])
    add("Farmers market", 14, "10:00", "11:30", "personal", "Riverside Park")
    add("Mom's birthday", 15, None, None, "personal", "", [], "Call in the morning!")
    add("Offsite planning", 16, "10:00", "12:00", "work", "Room Atlas", ["Priya Raman", "Ada Park"])
    add("St. Patrick's Day", 17, None, None, "holidays")
    add("Gym", 17, "18:00", "19:00", "personal", "Northside Climbing")
    add("Board meeting", 3, "14:00", "16:00", "work", "HQ boardroom", ["Leadership"])
    add("Q2 offsite (day 1)", 26, None, None, "work", "Lakeside Lodge")
    add("Q2 offsite (day 2)", 27, None, None, "work", "Lakeside Lodge")
    add("Dentist check-up", 31, "08:30", "09:30", "personal", "Dr. Alvarez")
    data = {
        "now": "2026-03-12T14:30:00",
        "weekStartsOn": "monday",
        "calendars": [
            {"id": "work", "name": "Work", "color": "#4f8ef7"},
            {"id": "personal", "name": "Personal", "color": "#3fbf7f"},
            {"id": "holidays", "name": "Holidays", "color": "#e5534b"},
        ],
        "events": events,
    }
    (ROOT / "tasks/calendar/data/calendar.json").write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    (ROOT / "tasks/system-dashboard/data").mkdir(parents=True, exist_ok=True)
    gen_log()
    gen_metrics()
    gen_mailbox()
    gen_chat()
    gen_calendar()
    print("fixtures written")
