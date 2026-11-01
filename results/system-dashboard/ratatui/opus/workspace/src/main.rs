use std::io;
use std::time::{Duration, Instant};

use crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};
use ratatui::{
    DefaultTerminal, Frame,
    buffer::Buffer,
    layout::{Alignment, Constraint, Layout, Margin, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{
        Block, BorderType, Cell, Clear, Paragraph, Row, Scrollbar, ScrollbarOrientation,
        ScrollbarState, Table, TableState,
    },
};
use serde::Deserialize;

// ───────────────────────────── data ─────────────────────────────

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Usage {
    used_gi_b: f64,
    total_gi_b: f64,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Net {
    rx_ki_bps: f64,
    tx_ki_bps: f64,
}

#[derive(Deserialize, Clone)]
struct Sample {
    cpu: Vec<f64>,
    mem: Usage,
    swap: Usage,
    net: Net,
    load: Vec<f64>,
}

#[derive(Deserialize, Clone)]
struct Process {
    pid: u32,
    name: String,
    user: String,
    cpu: f64,
    mem: f64,
    threads: u32,
    state: String,
    started: String,
    command: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Metrics {
    host: String,
    kernel: String,
    uptime: String,
    cores: usize,
    interval_ms: u64,
    samples: Vec<Sample>,
    processes: Vec<Process>,
}

// ───────────────────────────── palette ─────────────────────────────

const BG: Color = Color::Rgb(14, 16, 22);
const BAR_BG: Color = Color::Rgb(24, 28, 38);
const BORDER: Color = Color::Rgb(58, 66, 86);
const TRACK: Color = Color::Rgb(34, 38, 50);
const FG: Color = Color::Rgb(205, 212, 226);
const DIM: Color = Color::Rgb(110, 118, 138);
const FAINT: Color = Color::Rgb(52, 58, 74);
const ACCENT: Color = Color::Rgb(122, 162, 247);
const TITLE: Color = Color::Rgb(187, 154, 247);
const GREEN: Color = Color::Rgb(115, 218, 140);
const YELLOW: Color = Color::Rgb(240, 198, 100);
const RED: Color = Color::Rgb(247, 108, 108);
const CYAN: Color = Color::Rgb(94, 212, 230);
const MAGENTA: Color = Color::Rgb(230, 120, 200);
const SEL_BG: Color = Color::Rgb(44, 54, 84);

fn rgb(c: Color) -> (f64, f64, f64) {
    match c {
        Color::Rgb(r, g, b) => (r as f64, g as f64, b as f64),
        _ => (255.0, 255.0, 255.0),
    }
}

fn lerp(a: Color, b: Color, t: f64) -> Color {
    let (ar, ag, ab) = rgb(a);
    let (br, bg, bb) = rgb(b);
    let t = t.clamp(0.0, 1.0);
    Color::Rgb(
        (ar + (br - ar) * t).round() as u8,
        (ag + (bg - ag) * t).round() as u8,
        (ab + (bb - ab) * t).round() as u8,
    )
}

/// Green → yellow → red gradient for t in [0, 1].
fn heat(t: f64) -> Color {
    let t = t.clamp(0.0, 1.0);
    if t < 0.55 {
        lerp(GREEN, YELLOW, t / 0.55)
    } else {
        lerp(YELLOW, RED, (t - 0.55) / 0.45)
    }
}

/// Discrete threshold color for a percentage.
fn level(pct: f64) -> Color {
    if pct >= 80.0 {
        RED
    } else if pct >= 50.0 {
        YELLOW
    } else {
        GREEN
    }
}

// ───────────────────────────── app state ─────────────────────────────

#[derive(Clone, Copy, PartialEq)]
enum SortKey {
    Cpu,
    Mem,
    Pid,
    Name,
}

impl SortKey {
    fn next(self) -> Self {
        match self {
            SortKey::Cpu => SortKey::Mem,
            SortKey::Mem => SortKey::Pid,
            SortKey::Pid => SortKey::Name,
            SortKey::Name => SortKey::Cpu,
        }
    }
    fn label(self) -> &'static str {
        match self {
            SortKey::Cpu => "CPU%",
            SortKey::Mem => "MEM%",
            SortKey::Pid => "PID",
            SortKey::Name => "NAME",
        }
    }
    fn descending(self) -> bool {
        matches!(self, SortKey::Cpu | SortKey::Mem)
    }
}

struct App {
    m: Metrics,
    cur: usize,
    paused: bool,
    last_tick: Instant,
    procs: Vec<Process>,
    sort: SortKey,
    table: TableState,
    popup: bool,
}

impl App {
    fn new(m: Metrics) -> Self {
        let procs = m.processes.clone();
        let mut app = App {
            m,
            cur: 0,
            paused: false,
            last_tick: Instant::now(),
            procs,
            sort: SortKey::Cpu,
            table: TableState::default(),
            popup: false,
        };
        app.apply_sort(None);
        if !app.procs.is_empty() {
            app.table.select(Some(0));
        }
        app
    }

    fn total(&self) -> usize {
        self.m.samples.len()
    }

    fn finished(&self) -> bool {
        self.cur + 1 >= self.total()
    }

    fn interval(&self) -> Duration {
        Duration::from_millis(self.m.interval_ms.max(1))
    }

    fn sample(&self) -> Option<&Sample> {
        self.m.samples.get(self.cur)
    }

    fn tick(&mut self) {
        if self.paused {
            return;
        }
        let iv = self.interval();
        while !self.finished() && self.last_tick.elapsed() >= iv {
            self.cur += 1;
            self.last_tick += iv;
        }
    }

    fn time_to_next(&self) -> Duration {
        if self.paused || self.finished() {
            return Duration::from_millis(250);
        }
        self.interval()
            .checked_sub(self.last_tick.elapsed())
            .unwrap_or(Duration::ZERO)
    }

    fn toggle_pause(&mut self) {
        self.paused = !self.paused;
        if !self.paused {
            self.last_tick = Instant::now();
        }
    }

    fn apply_sort(&mut self, keep_pid: Option<u32>) {
        let key = self.sort;
        self.procs.sort_by(|a, b| {
            let ord = match key {
                SortKey::Cpu => b.cpu.total_cmp(&a.cpu),
                SortKey::Mem => b.mem.total_cmp(&a.mem),
                SortKey::Pid => a.pid.cmp(&b.pid),
                SortKey::Name => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
            };
            ord.then(a.pid.cmp(&b.pid))
        });
        if let Some(pid) = keep_pid {
            if let Some(i) = self.procs.iter().position(|p| p.pid == pid) {
                self.table.select(Some(i));
            }
        }
    }

    fn cycle_sort(&mut self) {
        let pid = self.selected().map(|p| p.pid);
        self.sort = self.sort.next();
        self.apply_sort(pid);
    }

    fn selected(&self) -> Option<&Process> {
        self.table.selected().and_then(|i| self.procs.get(i))
    }

    fn move_sel(&mut self, delta: isize) {
        if self.procs.is_empty() {
            return;
        }
        let max = self.procs.len() as isize - 1;
        let i = self.table.selected().unwrap_or(0) as isize;
        self.table.select(Some((i + delta).clamp(0, max) as usize));
    }

    /// Returns false when the app should quit.
    fn on_key(&mut self, code: KeyCode, mods: KeyModifiers) -> bool {
        if mods.contains(KeyModifiers::CONTROL) && code == KeyCode::Char('c') {
            return false;
        }
        match code {
            KeyCode::Char('q') | KeyCode::Char('Q') => return false,
            KeyCode::Char('p') | KeyCode::Char(' ') => self.toggle_pause(),
            _ => {}
        }
        if self.popup {
            if matches!(code, KeyCode::Esc | KeyCode::Enter) {
                self.popup = false;
            }
            return true;
        }
        match code {
            KeyCode::Char('j') | KeyCode::Down => self.move_sel(1),
            KeyCode::Char('k') | KeyCode::Up => self.move_sel(-1),
            KeyCode::PageDown => self.move_sel(10),
            KeyCode::PageUp => self.move_sel(-10),
            KeyCode::Home | KeyCode::Char('g') => self.move_sel(-(self.procs.len() as isize)),
            KeyCode::End | KeyCode::Char('G') => self.move_sel(self.procs.len() as isize),
            KeyCode::Char('s') => self.cycle_sort(),
            KeyCode::Enter => {
                if self.selected().is_some() {
                    self.popup = true;
                }
            }
            _ => {}
        }
        true
    }
}

// ───────────────────────────── main loop ─────────────────────────────

fn main() -> io::Result<()> {
    let raw = std::fs::read_to_string("data/metrics.json")
        .map_err(|e| io::Error::new(e.kind(), format!("cannot read data/metrics.json: {e}")))?;
    let metrics: Metrics = serde_json::from_str(&raw)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, format!("bad metrics.json: {e}")))?;
    let mut app = App::new(metrics);
    ratatui::run(|t| run(t, &mut app))
}

fn run(terminal: &mut DefaultTerminal, app: &mut App) -> io::Result<()> {
    app.last_tick = Instant::now();
    loop {
        app.tick();
        terminal.draw(|f| render(f, app))?;
        let timeout = app.time_to_next();
        if event::poll(timeout)? {
            loop {
                match event::read()? {
                    Event::Key(k) if k.kind == KeyEventKind::Press => {
                        if !app.on_key(k.code, k.modifiers) {
                            return Ok(());
                        }
                    }
                    _ => {}
                }
                if !event::poll(Duration::ZERO)? {
                    break;
                }
            }
        }
    }
}

// ───────────────────────────── helpers ─────────────────────────────

fn panel<'a>(title: &'a str, right: Option<Line<'a>>) -> Block<'a> {
    let mut b = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(Style::new().fg(BORDER))
        .style(Style::new().bg(BG).fg(FG))
        .title(Line::from(vec![
            Span::styled(" ", Style::new()),
            Span::styled(title, Style::new().fg(TITLE).add_modifier(Modifier::BOLD)),
            Span::styled(" ", Style::new()),
        ]));
    if let Some(r) = right {
        b = b.title_top(r.right_aligned());
    }
    b
}

fn put(buf: &mut Buffer, x: u16, y: u16, ch: &str, style: Style) {
    if let Some(c) = buf.cell_mut((x, y)) {
        c.set_symbol(ch).set_style(style);
    }
}

fn put_str(buf: &mut Buffer, x: u16, y: u16, s: &str, style: Style, max_w: u16) {
    let mut cx = x;
    for ch in s.chars() {
        if cx >= x + max_w {
            break;
        }
        let mut tmp = [0u8; 4];
        put(buf, cx, y, ch.encode_utf8(&mut tmp), style);
        cx += 1;
    }
}

const HBLOCKS: [&str; 8] = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
const VBLOCKS: [&str; 9] = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/// Horizontal meter with sub-cell precision and a heat gradient along its length.
fn draw_meter(buf: &mut Buffer, x: u16, y: u16, w: u16, pct: f64, gradient: bool) {
    if w == 0 {
        return;
    }
    let eighths = ((pct.clamp(0.0, 100.0) / 100.0) * w as f64 * 8.0).round() as u32;
    let solid = level(pct);
    for i in 0..w {
        let fill = eighths.saturating_sub(i as u32 * 8).min(8);
        let color = if gradient {
            heat((i as f64 + 0.5) / w as f64)
        } else {
            solid
        };
        let sym = if fill >= 8 {
            "█"
        } else if fill == 0 {
            " "
        } else {
            HBLOCKS[fill as usize]
        };
        put(buf, x + i, y, sym, Style::new().fg(color).bg(TRACK));
    }
}

fn fmt_rate(kib: f64) -> String {
    if kib >= 1024.0 {
        format!("{:.2} MiB/s", kib / 1024.0)
    } else {
        format!("{:.0} KiB/s", kib)
    }
}

fn short_rate(kib: f64) -> String {
    if kib >= 1024.0 {
        let m = kib / 1024.0;
        if (m - m.round()).abs() < 0.005 { format!("{m:.0}M") } else { format!("{m:.2}M") }
    } else {
        format!("{kib:.0}K")
    }
}

fn avg(v: &[f64]) -> f64 {
    if v.is_empty() {
        0.0
    } else {
        v.iter().sum::<f64>() / v.len() as f64
    }
}

fn truncate(s: &str, w: usize) -> String {
    if s.chars().count() <= w {
        s.to_string()
    } else if w == 0 {
        String::new()
    } else {
        let mut t: String = s.chars().take(w - 1).collect();
        t.push('…');
        t
    }
}

fn centered(area: Rect, w: u16, h: u16) -> Rect {
    let w = w.min(area.width);
    let h = h.min(area.height);
    Rect {
        x: area.x + (area.width - w) / 2,
        y: area.y + (area.height - h) / 2,
        width: w,
        height: h,
    }
}

// ───────────────────────────── render ─────────────────────────────

fn render(f: &mut Frame, app: &mut App) {
    let area = f.area();
    f.render_widget(Block::new().style(Style::new().bg(BG).fg(FG)), area);

    if area.width < 44 || area.height < 12 {
        let msg = vec![
            Line::from(Span::styled(
                "Terminal too small",
                Style::new().fg(YELLOW).add_modifier(Modifier::BOLD),
            )),
            Line::from(Span::styled(
                format!("{}x{} — need at least 44x12", area.width, area.height),
                Style::new().fg(DIM),
            )),
        ];
        let r = centered(area, area.width, 2);
        f.render_widget(Paragraph::new(msg).alignment(Alignment::Center), r);
        return;
    }

    let [header, body, footer] = Layout::vertical([
        Constraint::Length(1),
        Constraint::Fill(1),
        Constraint::Length(1),
    ])
    .areas(area);

    render_header(f, app, header);
    render_footer(f, app, footer);

    let avail = body.height;
    let ncores = app.sample().map(|s| s.cpu.len()).unwrap_or(app.m.cores) as u16;
    let row_a = ((avail as f64 * 0.40) as u16).min(ncores + 4).max(5);
    let row_b = ((avail as f64 * 0.27) as u16).clamp(5, 9);
    let [a, b, procs] = Layout::vertical([
        Constraint::Length(row_a),
        Constraint::Length(row_b),
        Constraint::Min(4),
    ])
    .areas(body);

    let left_w = ((area.width as f64 * 0.36) as u16).clamp(34, 46);
    let narrow = area.width < 72;
    let [cpu_area, hist_area] =
        Layout::horizontal([Constraint::Length(left_w), Constraint::Fill(1)]).areas(a);
    let load_w = if narrow { 0 } else if area.width >= 100 { 24 } else { 18 };
    let [mem_area, net_area, load_area] = Layout::horizontal([
        Constraint::Length(left_w),
        Constraint::Fill(1),
        Constraint::Length(load_w),
    ])
    .areas(b);

    render_cpu(f, app, cpu_area);
    render_history(f, app, hist_area);
    render_memory(f, app, mem_area, narrow);
    render_network(f, app, net_area);
    if !narrow {
        render_load(f, app, load_area);
    }
    render_processes(f, app, procs);

    if app.popup {
        render_popup(f, app, area);
    }
}

fn render_header(f: &mut Frame, app: &App, area: Rect) {
    let bar = Style::new().bg(BAR_BG).fg(FG);
    f.render_widget(Block::new().style(bar), area);

    let total = app.total();
    let pos = if total == 0 { 0 } else { app.cur + 1 };
    let short = area.width < 64;
    let (badge, badge_style) = if app.finished() {
        (if short { " ■ DONE " } else { " ■ REPLAY FINISHED " }, Style::new().bg(YELLOW).fg(BG).add_modifier(Modifier::BOLD))
    } else if app.paused {
        (" ❚❚ PAUSED ", Style::new().bg(MAGENTA).fg(BG).add_modifier(Modifier::BOLD))
    } else {
        (if short { " ▶ LIVE " } else { " ▶ LIVE REPLAY " }, Style::new().bg(GREEN).fg(BG).add_modifier(Modifier::BOLD))
    };
    let pos_txt = format!(" sample {pos}/{total} ");

    // progress track
    let prog_w: u16 = if area.width >= 110 { 20 } else if area.width >= 90 { 12 } else { 0 };
    let right_w = badge.chars().count() as u16 + pos_txt.chars().count() as u16 + prog_w + 2;

    let host = Span::styled(
        format!(" ◆ {} ", app.m.host),
        Style::new().fg(ACCENT).add_modifier(Modifier::BOLD),
    );
    let sep = Span::styled("│", Style::new().fg(FAINT));
    let kernel = Span::styled(format!(" {} ", app.m.kernel), Style::new().fg(FG));
    let up_l = Span::styled(" up ", Style::new().fg(DIM));
    let up = Span::styled(format!("{} ", app.m.uptime), Style::new().fg(FG));
    let cores = Span::styled(format!(" {} cores ", app.m.cores), Style::new().fg(DIM));

    let mut parts: Vec<Vec<Span>> = vec![
        vec![host],
        vec![sep.clone(), up_l, up],
        vec![sep.clone(), kernel],
        vec![sep.clone(), cores],
    ];
    let avail = area.width.saturating_sub(right_w) as usize;
    while parts.len() > 1 {
        let w: usize = parts.iter().flatten().map(|s| s.width()).sum();
        if w <= avail {
            break;
        }
        parts.pop();
    }
    let left: Vec<Span> = parts.into_iter().flatten().collect();
    f.render_widget(Paragraph::new(Line::from(left)), area);

    // right side
    let rx = area.x + area.width.saturating_sub(right_w);
    let buf = f.buffer_mut();
    let mut x = rx + 1;
    put_str(buf, x, area.y, badge, badge_style, badge.chars().count() as u16);
    x += badge.chars().count() as u16;
    put_str(
        buf,
        x,
        area.y,
        &pos_txt,
        Style::new().fg(FG).bg(BAR_BG).add_modifier(Modifier::BOLD),
        pos_txt.chars().count() as u16,
    );
    x += pos_txt.chars().count() as u16;
    if prog_w > 0 && total > 0 {
        let filled = ((pos as f64 / total as f64) * prog_w as f64).round() as u16;
        for i in 0..prog_w {
            let (sym, col) = if i < filled { ("━", ACCENT) } else { ("━", FAINT) };
            put(buf, x + i, area.y, sym, Style::new().fg(col).bg(BAR_BG));
        }
    }
}

fn render_footer(f: &mut Frame, app: &App, area: Rect) {
    let key = Style::new().fg(BG).bg(ACCENT).add_modifier(Modifier::BOLD);
    let txt = Style::new().fg(DIM).bg(BAR_BG);
    let mut spans = vec![Span::styled(" ", txt)];
    let items: Vec<(&str, &str)> = if app.popup {
        vec![("esc", "close"), ("p", if app.paused { "resume" } else { "pause" }), ("q", "quit")]
    } else {
        vec![
            ("↑↓ j/k", "select"),
            ("s", "sort"),
            ("enter", "details"),
            ("p", if app.paused { "resume" } else { "pause" }),
            ("q", "quit"),
        ]
    };
    let sort = format!("sort: {} {} ", app.sort.label(), if app.sort.descending() { "▼" } else { "▲" });
    let sort_w = sort.chars().count();
    let mut used = 1usize;
    let mut show_sort = true;
    for (k, d) in items {
        let iw = k.chars().count() + 2 + d.chars().count() + 3;
        if used + iw + sort_w > area.width as usize {
            show_sort = false;
        }
        if used + iw > area.width as usize {
            break;
        }
        used += iw;
        spans.push(Span::styled(format!(" {k} "), key));
        spans.push(Span::styled(format!(" {d}  "), txt));
    }
    f.render_widget(Block::new().style(Style::new().bg(BAR_BG)), area);
    f.render_widget(Paragraph::new(Line::from(spans)), area);

    let w = sort_w as u16;
    if show_sort && area.width as usize >= used + sort_w {
        let r = Rect { x: area.x + area.width - w, width: w, ..area };
        f.render_widget(
            Paragraph::new(Span::styled(sort, Style::new().fg(DIM).bg(BAR_BG))),
            r,
        );
    }
}

fn render_cpu(f: &mut Frame, app: &App, area: Rect) {
    let Some(s) = app.sample() else { return };
    let a = avg(&s.cpu);
    let right = Line::from(vec![
        Span::styled(" avg ", Style::new().fg(DIM)),
        Span::styled(
            format!("{a:.1}% "),
            Style::new().fg(level(a)).add_modifier(Modifier::BOLD),
        ),
    ]);
    let title = format!("CPU · {} cores", s.cpu.len());
    let block = panel(&title, Some(right));
    let inner = block.inner(area).inner(Margin::new(1, 0));
    f.render_widget(block, area);
    if inner.height == 0 || inner.width < 10 {
        return;
    }
    let buf = f.buffer_mut();
    let n = s.cpu.len();
    let ih = inner.height as usize;
    let (core_rows, ncols) = if ih >= n + 1 {
        (n.max(1), 1)
    } else {
        let avail = ih.saturating_sub(1).max(1);
        let ncols = n.div_ceil(avail).max(1);
        (n.div_ceil(ncols).max(1), ncols)
    };
    let col_gap = 2u16;
    let col_w = (inner.width + col_gap) / ncols as u16;
    let label_w: u16 = if n > 10 { 4 } else { 3 };
    for (i, &v) in s.cpu.iter().enumerate() {
        let col = (i / core_rows) as u16;
        let row = (i % core_rows) as u16;
        if row >= inner.height {
            continue;
        }
        let x = inner.x + col * col_w;
        let y = inner.y + row;
        if x >= inner.x + inner.width { continue; }
        let w = col_w.saturating_sub(col_gap).min(inner.x + inner.width - x);
        put_str(buf, x, y, &format!("C{i}"), Style::new().fg(DIM), label_w);
        let pct = if w < label_w + 6 { format!("{v:3.0}%") } else { format!("{v:5.1}%") };
        let pw = pct.chars().count() as u16;
        let bar_w = w.saturating_sub(label_w + 6);
        if bar_w >= 3 {
            draw_meter(buf, x + label_w, y, bar_w, v, true);
        }
        put_str(buf, x + w.saturating_sub(pw), y, &pct, Style::new().fg(level(v)), pw);
    }
    // average
    let y = inner.y + inner.height - 1;
    put_str(buf, inner.x, y, "AVG", Style::new().fg(FG).add_modifier(Modifier::BOLD), 4);
    let bar_w = inner.width.saturating_sub(4 + 7);
    draw_meter(buf, inner.x + 4, y, bar_w, a, true);
    put_str(
        buf,
        inner.x + inner.width - 6,
        y,
        &format!("{a:5.1}%"),
        Style::new().fg(level(a)).add_modifier(Modifier::BOLD),
        6,
    );
}

/// Draws a filled area graph (values in 0..=max) growing upwards.
fn area_graph(
    buf: &mut Buffer,
    r: Rect,
    values: &[f64],
    total: usize,
    max: f64,
    color: impl Fn(f64) -> Color,
    up: bool,
) {
    if r.width == 0 || r.height == 0 || total == 0 {
        return;
    }
    let h = r.height as f64;
    for c in 0..r.width {
        let idx = if total <= 1 {
            0
        } else {
            ((c as f64 / (r.width.max(2) - 1) as f64) * (total - 1) as f64).round() as usize
        };
        let Some(&v) = values.get(idx) else { continue };
        let eighths = ((v / max).clamp(0.0, 1.0) * h * 8.0).round() as i64;
        for row in 0..r.height {
            // row counted from the baseline
            let fill = (eighths - row as i64 * 8).clamp(0, 8) as usize;
            if fill == 0 {
                continue;
            }
            let t = (row as f64 + 0.5) / h;
            let (y, sym) = if up {
                (r.y + r.height - 1 - row, VBLOCKS[fill])
            } else {
                let sym = if fill >= 8 {
                    "█"
                } else if fill >= 4 {
                    "▀"
                } else {
                    "▔"
                };
                (r.y + row, sym)
            };
            put(buf, r.x + c, y, sym, Style::new().fg(color(t)).bg(BG));
        }
    }
}

fn render_history(f: &mut Frame, app: &App, area: Rect) {
    let played: Vec<f64> = app.m.samples[..=app.cur.min(app.total().saturating_sub(1))]
        .iter()
        .map(|s| avg(&s.cpu))
        .collect();
    let peak = played.iter().cloned().fold(0.0, f64::max);
    let mean = avg(&played);
    let right = Line::from(vec![
        Span::styled(" mean ", Style::new().fg(DIM)),
        Span::styled(format!("{mean:.1}%"), Style::new().fg(level(mean))),
        Span::styled("  peak ", Style::new().fg(DIM)),
        Span::styled(format!("{peak:.1}% "), Style::new().fg(level(peak))),
    ]);
    let block = panel("CPU history", if area.width >= 46 { Some(right) } else { None });
    let inner = block.inner(area).inner(Margin::new(1, 0));
    f.render_widget(block, area);
    if inner.height < 2 || inner.width < 12 {
        return;
    }
    let show_x = inner.height >= 6;
    let gh = if show_x { inner.height - 1 } else { inner.height };
    let gutter = 5u16;
    let g = Rect { x: inner.x + gutter, y: inner.y, width: inner.width - gutter, height: gh };
    let buf = f.buffer_mut();

    // gridlines & y labels
    for (frac, label) in [(1.0, "100"), (0.5, " 50"), (0.0, "  0")] {
        let row = ((1.0 - frac) * (gh - 1) as f64).round() as u16;
        let y = g.y + row;
        put_str(buf, inner.x, y, label, Style::new().fg(DIM), 3);
        put(buf, inner.x + 3, y, "┤", Style::new().fg(FAINT));
        if frac > 0.0 {
            for x in 0..g.width {
                if x % 2 == 0 {
                    put(buf, g.x + x, y, "·", Style::new().fg(FAINT));
                }
            }
        }
    }
    for row in 0..gh {
        let y = g.y + row;
        if buf.cell((inner.x + 3, y)).map(|c| c.symbol() == " ").unwrap_or(false) {
            put(buf, inner.x + 3, y, "│", Style::new().fg(FAINT));
        }
    }
    area_graph(buf, g, &played, app.total(), 100.0, |t| heat(t), true);

    if show_x {
        let y = inner.y + inner.height - 1;
        let secs = app.total() as f64 * app.m.interval_ms as f64 / 1000.0;
        put_str(buf, inner.x + 3, y, "└", Style::new().fg(FAINT), 1);
        for x in 0..g.width {
            put(buf, g.x + x, y, "─", Style::new().fg(FAINT));
        }
        if app.total() > 1 {
            let px = ((app.cur as f64 / (app.total() - 1) as f64) * (g.width - 1) as f64).round() as u16;
            for x in 0..=px.min(g.width - 1) {
                put(buf, g.x + x, y, "─", Style::new().fg(ACCENT));
            }
            put(buf, g.x + px.min(g.width - 1), y, "●", Style::new().fg(ACCENT));
        }
        put_str(buf, g.x, y, "0s", Style::new().fg(DIM), 2);
        let mid = format!("{:.1}s", secs / 2.0);
        put_str(buf, g.x + g.width / 2 - mid.len() as u16 / 2, y, &mid, Style::new().fg(DIM), 6);
        let end = format!("{secs:.1}s");
        put_str(buf, g.x + g.width - end.len() as u16, y, &end, Style::new().fg(DIM), 6);
    }
}

fn render_memory(f: &mut Frame, app: &App, area: Rect, with_load: bool) {
    let Some(s) = app.sample() else { return };
    let load = if with_load {
        let cores = app.m.cores.max(1) as f64;
        let mut spans = vec![Span::styled(" load", Style::new().fg(DIM))];
        for v in s.load.iter().take(3) {
            let pct = v / cores * 100.0;
            let col = if pct >= 100.0 { RED } else if pct >= 70.0 { YELLOW } else { GREEN };
            spans.push(Span::styled(format!(" {v:.2}"), Style::new().fg(col)));
        }
        spans.push(Span::raw(" "));
        Some(Line::from(spans))
    } else {
        None
    };
    let block = panel("Memory", load);
    let inner = block.inner(area).inner(Margin::new(1, 0));
    f.render_widget(block, area);
    if inner.height == 0 || inner.width < 16 {
        return;
    }
    let buf = f.buffer_mut();
    let items = [("Mem", &s.mem), ("Swap", &s.swap)];
    let roomy = inner.height >= 5;
    let mut y = inner.y;
    for (name, u) in items {
        let pct = if u.total_gi_b > 0.0 { u.used_gi_b / u.total_gi_b * 100.0 } else { 0.0 };
        let vals = format!("{:.2} / {:.1} GiB", u.used_gi_b, u.total_gi_b);
        let pct_s = format!("{pct:5.1}%");
        if roomy {
            if y >= inner.y + inner.height {
                break;
            }
            put_str(buf, inner.x, y, name, Style::new().fg(FG).add_modifier(Modifier::BOLD), 5);
            let vw = vals.chars().count() as u16;
            put_str(buf, inner.x + inner.width.saturating_sub(vw), y, &vals, Style::new().fg(DIM), vw);
            y += 1;
            if y >= inner.y + inner.height {
                break;
            }
            let bw = inner.width.saturating_sub(7);
            draw_meter(buf, inner.x, y, bw, pct, false);
            put_str(buf, inner.x + bw + 1, y, &pct_s, Style::new().fg(level(pct)).add_modifier(Modifier::BOLD), 6);
            y += if inner.height >= 6 { 2 } else { 1 };
        } else {
            if y >= inner.y + inner.height {
                break;
            }
            put_str(buf, inner.x, y, name, Style::new().fg(FG).add_modifier(Modifier::BOLD), 5);
            let bw = inner.width.saturating_sub(5 + 7);
            draw_meter(buf, inner.x + 5, y, bw, pct, false);
            put_str(buf, inner.x + 5 + bw + 1, y, &pct_s, Style::new().fg(level(pct)), 6);
            y += 1;
        }
    }
    // free memory summary on the last line when there is room
    if y < inner.y + inner.height {
        let free = s.mem.total_gi_b - s.mem.used_gi_b;
        let line = Line::from(vec![
            Span::styled("available ", Style::new().fg(DIM)),
            Span::styled(format!("{free:.2} GiB"), Style::new().fg(GREEN)),
        ]);
        let last = Rect { x: inner.x, y: inner.y + inner.height - 1, width: inner.width, height: 1 };
        f.render_widget(Paragraph::new(line), last);
    }
}

fn nice_rate(kib: f64) -> f64 {
    if kib > 1024.0 {
        nice_ceiling(kib / 1024.0) * 1024.0
    } else {
        nice_ceiling(kib)
    }
}

fn nice_ceiling(v: f64) -> f64 {
    if v <= 0.0 {
        return 1.0;
    }
    let mag = 10f64.powf(v.log10().floor());
    for m in [1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0, 8.0, 10.0] {
        if v <= m * mag {
            return m * mag;
        }
    }
    10.0 * mag
}

fn render_network(f: &mut Frame, app: &App, area: Rect) {
    let Some(s) = app.sample() else { return };
    let played = &app.m.samples[..=app.cur.min(app.total().saturating_sub(1))];
    let rx: Vec<f64> = played.iter().map(|s| s.net.rx_ki_bps).collect();
    let tx: Vec<f64> = played.iter().map(|s| s.net.tx_ki_bps).collect();
    let rx_peak = rx.iter().cloned().fold(0.0, f64::max);
    let tx_peak = tx.iter().cloned().fold(0.0, f64::max);
    let rx_max = nice_rate(rx_peak * 1.05);
    let tx_max = nice_rate(tx_peak * 1.05);

    let roomy = area.width >= 44;
    let r = |v: f64| if roomy { fmt_rate(v) } else { short_rate(v) };
    let bottom = Line::from(vec![
        Span::styled(" peak ", Style::new().fg(DIM)),
        Span::styled(format!("▼{}", r(rx_peak)), Style::new().fg(CYAN)),
        Span::styled(" ", Style::new()),
        Span::styled(format!("▲{} ", r(tx_peak)), Style::new().fg(MAGENTA)),
    ])
    .right_aligned();
    let block = panel("Network", None).title_bottom(bottom);
    let inner = block.inner(area).inner(Margin::new(1, 0));
    f.render_widget(block, area);
    if inner.height < 2 || inner.width < 10 {
        return;
    }
    let compact = inner.width < 36;
    let tiny = inner.width < 26;
    let cur = |v: f64| if tiny { format!("{}/s", short_rate(v)) } else { fmt_rate(v) };
    let head = Line::from(vec![
        Span::styled(if compact { "▼ " } else { "▼ RX " }, Style::new().fg(CYAN).add_modifier(Modifier::BOLD)),
        Span::styled(cur(s.net.rx_ki_bps), Style::new().fg(FG).add_modifier(Modifier::BOLD)),
        Span::styled(if compact { "  ▲ " } else { "   ▲ TX " }, Style::new().fg(MAGENTA).add_modifier(Modifier::BOLD)),
        Span::styled(cur(s.net.tx_ki_bps), Style::new().fg(FG).add_modifier(Modifier::BOLD)),
    ]);
    let hw = head.width() as u16;
    f.render_widget(Paragraph::new(head), Rect { height: 1, ..inner });
    let scale = if inner.width >= hw + 32 {
        format!("scale {} / {}", fmt_rate(rx_max), fmt_rate(tx_max))
    } else {
        format!("⇕ {} / {}", short_rate(rx_max), short_rate(tx_max))
    };
    let sw = scale.chars().count() as u16;
    if inner.width >= sw + hw + 2 {
        f.render_widget(
            Paragraph::new(Span::styled(scale, Style::new().fg(DIM))).right_aligned(),
            Rect { height: 1, ..inner },
        );
    }
    let g = Rect { y: inner.y + 1, height: inner.height - 1, ..inner };
    if g.height == 0 {
        return;
    }
    let up_h = g.height.div_ceil(2);
    let down_h = g.height - up_h;
    let total = app.total();
    let buf = f.buffer_mut();
    let up_r = Rect { height: up_h, ..g };
    let down_r = Rect { y: g.y + up_h, height: down_h, ..g };
    // baseline dots
    for x in 0..g.width {
        if x % 2 == 0 {
            put(buf, g.x + x, up_r.y + up_h - 1, "·", Style::new().fg(FAINT));
        }
    }
    area_graph(buf, up_r, &rx, total, rx_max, |t| lerp(Color::Rgb(40, 120, 150), CYAN, t), true);
    if down_h > 0 {
        area_graph(buf, down_r, &tx, total, tx_max, |t| lerp(Color::Rgb(130, 60, 120), MAGENTA, t), false);
    }
}

fn render_load(f: &mut Frame, app: &App, area: Rect) {
    let Some(s) = app.sample() else { return };
    let cores = app.m.cores.max(1) as f64;
    let block = panel("Load avg", None);
    let inner = block.inner(area).inner(Margin::new(1, 0));
    f.render_widget(block, area);
    if inner.height == 0 || inner.width < 8 {
        return;
    }
    let buf = f.buffer_mut();
    let labels = ["1 min", "5 min", "15 min"];
    let roomy = inner.height >= 6;
    let mut y = inner.y;
    for (i, lbl) in labels.iter().enumerate() {
        let v = s.load.get(i).copied().unwrap_or(0.0);
        let pct = v / cores * 100.0;
        let col = if pct >= 100.0 { RED } else if pct >= 70.0 { YELLOW } else { GREEN };
        if y >= inner.y + inner.height {
            break;
        }
        put_str(buf, inner.x, y, lbl, Style::new().fg(DIM), 6);
        let vs = format!("{v:.2}");
        let vw = vs.len() as u16;
        put_str(buf, inner.x + inner.width - vw, y, &vs, Style::new().fg(col).add_modifier(Modifier::BOLD), vw);
        if roomy {
            y += 1;
            if y >= inner.y + inner.height {
                break;
            }
            draw_meter(buf, inner.x, y, inner.width, pct.min(100.0), false);
            for x in 0..inner.width {
                if let Some(c) = buf.cell_mut((inner.x + x, y)) {
                    c.set_fg(col);
                }
            }
        }
        y += 1;
    }
    if y < inner.y + inner.height {
        let l1 = s.load.first().copied().unwrap_or(0.0);
        let l15 = s.load.get(2).copied().unwrap_or(0.0);
        let (arrow, word, col) = if l1 > l15 + 0.05 {
            ("▲", "rising", YELLOW)
        } else if l1 + 0.05 < l15 {
            ("▼", "falling", GREEN)
        } else {
            ("●", "steady", DIM)
        };
        let line = Line::from(vec![
            Span::styled(format!("{arrow} {word}"), Style::new().fg(col)),
            Span::styled(format!(" /{} cores", app.m.cores), Style::new().fg(DIM)),
        ]);
        let last = Rect { x: inner.x, y: inner.y + inner.height - 1, width: inner.width, height: 1 };
        f.render_widget(Paragraph::new(line), last);
    }
}

fn state_style(state: &str) -> (char, Color) {
    match state {
        "running" => ('●', GREEN),
        "sleeping" => ('◐', ACCENT),
        "idle" => ('○', DIM),
        "zombie" => ('✖', RED),
        "stopped" => ('■', YELLOW),
        _ => ('·', DIM),
    }
}

fn proc_level(cpu: f64) -> Color {
    if cpu >= 40.0 {
        RED
    } else if cpu >= 20.0 {
        YELLOW
    } else if cpu >= 5.0 {
        GREEN
    } else {
        DIM
    }
}

fn render_processes(f: &mut Frame, app: &mut App, area: Rect) {
    let sel = app.table.selected().map(|i| i + 1).unwrap_or(0);
    let right = Line::from(vec![
        Span::styled(format!(" {sel}/{} ", app.procs.len()), Style::new().fg(DIM)),
    ]);
    let block = panel("Processes", Some(right));
    let inner = block.inner(area);
    f.render_widget(block, area);
    if inner.height < 2 || inner.width < 20 {
        return;
    }

    let wide = inner.width >= 100;
    let medium = inner.width >= 76;
    let sort = app.sort;
    let hdr = |label: &'static str, key: Option<SortKey>, right: bool| -> Cell<'static> {
        let active = key == Some(sort);
        let text = if active {
            let arrow = if sort.descending() { "▼" } else { "▲" };
            if right { format!("{arrow}{label}") } else { format!("{label}{arrow}") }
        } else {
            label.to_string()
        };
        let style = if active {
            Style::new().fg(ACCENT).add_modifier(Modifier::BOLD | Modifier::UNDERLINED)
        } else {
            Style::new().fg(DIM).add_modifier(Modifier::BOLD)
        };
        let line = Line::styled(text, style);
        Cell::from(if right { line.right_aligned() } else { line })
    };

    let mut header = vec![
        hdr("PID", Some(SortKey::Pid), true),
        hdr("NAME", Some(SortKey::Name), false),
        hdr("USER", None, false),
        hdr("CPU%", Some(SortKey::Cpu), true),
    ];
    if medium {
        header.push(Cell::from(""));
    }
    header.push(hdr("MEM%", Some(SortKey::Mem), true));
    header.push(hdr("STATE", None, false));
    if wide {
        header.push(hdr("THR", None, true));
        header.push(hdr("COMMAND", None, false));
    }

    let rows: Vec<Row> = app
        .procs
        .iter()
        .map(|p| {
            let (dot, scol) = state_style(&p.state);
            let mut cells = vec![
                Cell::from(Line::styled(p.pid.to_string(), Style::new().fg(DIM)).right_aligned()),
                Cell::from(Span::styled(p.name.clone(), Style::new().fg(FG).add_modifier(Modifier::BOLD))),
                Cell::from(Span::styled(
                    p.user.clone(),
                    Style::new().fg(if p.user == "root" { RED } else { Color::Rgb(160, 170, 200) }),
                )),
                Cell::from(
                    Line::styled(format!("{:.1}", p.cpu), Style::new().fg(proc_level(p.cpu)))
                        .right_aligned(),
                ),
            ];
            if medium {
                // mini cpu bar (scale: 50% = full)
                let w = 8usize;
                let eighths = ((p.cpu / 50.0).clamp(0.0, 1.0) * w as f64 * 8.0).round() as usize;
                let mut s = String::new();
                for i in 0..w {
                    let fill = eighths.saturating_sub(i * 8).min(8);
                    s.push_str(if fill >= 8 { "█" } else if fill == 0 { "·" } else { HBLOCKS[fill] });
                }
                cells.push(Cell::from(Span::styled(s, Style::new().fg(proc_level(p.cpu).max_dim()))));
            }
            cells.push(Cell::from(
                Line::styled(format!("{:.1}", p.mem), Style::new().fg(if p.mem >= 10.0 { YELLOW } else { FG }))
                    .right_aligned(),
            ));
            cells.push(Cell::from(Line::from(vec![
                Span::styled(format!("{dot} "), Style::new().fg(scol)),
                Span::styled(p.state.clone(), Style::new().fg(scol)),
            ])));
            if wide {
                cells.push(Cell::from(Line::styled(p.threads.to_string(), Style::new().fg(DIM)).right_aligned()));
                cells.push(Cell::from(Span::styled(p.command.clone(), Style::new().fg(DIM))));
            }
            Row::new(cells)
        })
        .collect();

    let mut widths = vec![
        Constraint::Length(6),
        Constraint::Length(if wide { 24 } else { 18 }),
        Constraint::Length(10),
        Constraint::Length(6),
    ];
    if medium {
        widths.push(Constraint::Length(8));
    }
    widths.push(Constraint::Length(6));
    widths.push(Constraint::Length(10));
    if wide {
        widths.push(Constraint::Length(4));
        widths.push(Constraint::Fill(1));
    }
    if !wide {
        // let NAME absorb leftover space on narrower terminals
        widths[1] = Constraint::Min(10);
    }

    let table = Table::new(rows, widths)
        .header(
            Row::new(header)
                .style(Style::new().bg(BAR_BG))
                .bottom_margin(0),
        )
        .column_spacing(2)
        .row_highlight_style(Style::new().bg(SEL_BG).add_modifier(Modifier::BOLD))
        .highlight_symbol(Span::styled("▌", Style::new().fg(ACCENT)))
        .highlight_spacing(ratatui::widgets::HighlightSpacing::Always)
        .style(Style::new().bg(BG));

    let table_area = Rect { width: inner.width.saturating_sub(1), ..inner };
    f.render_stateful_widget(table, table_area, &mut app.table);

    let visible = inner.height.saturating_sub(1) as usize;
    if app.procs.len() > visible {
        let mut sb = ScrollbarState::new(app.procs.len().saturating_sub(visible))
            .position(app.table.offset());
        let sb_area = Rect { y: area.y + 1, height: area.height.saturating_sub(2), ..area };
        f.render_stateful_widget(
            Scrollbar::new(ScrollbarOrientation::VerticalRight)
                .begin_symbol(None)
                .end_symbol(None)
                .track_symbol(Some("│"))
                .track_style(Style::new().fg(BORDER))
                .thumb_symbol("┃")
                .thumb_style(Style::new().fg(ACCENT)),
            sb_area,
            &mut sb,
        );
    }
}

trait MaxDim {
    fn max_dim(self) -> Color;
}
impl MaxDim for Color {
    fn max_dim(self) -> Color {
        if self == DIM { FAINT } else { self }
    }
}

fn render_popup(f: &mut Frame, app: &App, area: Rect) {
    let Some(p) = app.selected().cloned() else { return };
    let w = 62u16.min(area.width.saturating_sub(4));
    let h = 15u16.min(area.height.saturating_sub(2));
    let r = centered(area, w, h);
    // shadow
    let shadow = Rect {
        x: (r.x + 2).min(area.x + area.width),
        y: (r.y + 1).min(area.y + area.height),
        width: r.width.min((area.x + area.width).saturating_sub(r.x + 2)),
        height: r.height.min((area.y + area.height).saturating_sub(r.y + 1)),
    };
    {
        let buf = f.buffer_mut();
        for y in shadow.y..shadow.y + shadow.height {
            for x in shadow.x..shadow.x + shadow.width {
                if let Some(c) = buf.cell_mut((x, y)) {
                    c.set_bg(Color::Rgb(6, 7, 10)).set_fg(FAINT);
                }
            }
        }
    }
    f.render_widget(Clear, r);
    let block = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(Style::new().fg(ACCENT))
        .style(Style::new().bg(BAR_BG).fg(FG))
        .title(Line::from(vec![
            Span::styled(" Process ", Style::new().fg(TITLE).add_modifier(Modifier::BOLD)),
            Span::styled(format!("{} ", p.pid), Style::new().fg(ACCENT).add_modifier(Modifier::BOLD)),
        ]))
        .title_bottom(
            Line::from(vec![
                Span::styled(" esc ", Style::new().fg(BG).bg(ACCENT).add_modifier(Modifier::BOLD)),
                Span::styled(" close ", Style::new().fg(DIM)),
            ])
            .right_aligned(),
        );
    let inner = block.inner(r).inner(Margin::new(2, 1));
    f.render_widget(block, r);
    if inner.width < 10 || inner.height == 0 {
        return;
    }

    let (dot, scol) = state_style(&p.state);
    let key = |k: &str| Span::styled(format!("{k:<10}"), Style::new().fg(DIM));
    let started = p.started.replace('T', " ").replace('Z', " UTC");
    let mem_gib = app.sample().map(|s| s.mem.total_gi_b * p.mem / 100.0).unwrap_or(0.0);
    let vw = inner.width.saturating_sub(10) as usize;

    let mut lines = vec![
        Line::from(vec![
            Span::styled(truncate(&p.name, inner.width as usize), Style::new().fg(FG).add_modifier(Modifier::BOLD)),
        ]),
        Line::from(""),
        Line::from(vec![key("PID"), Span::styled(p.pid.to_string(), Style::new().fg(ACCENT))]),
        Line::from(vec![key("Name"), Span::styled(truncate(&p.name, vw), Style::new().fg(FG))]),
        Line::from(vec![key("User"), Span::styled(truncate(&p.user, vw), Style::new().fg(FG))]),
        Line::from(vec![
            key("State"),
            Span::styled(format!("{dot} {}", p.state), Style::new().fg(scol)),
        ]),
        Line::from(vec![key("CPU"), Span::styled(format!("{:.1}%", p.cpu), Style::new().fg(proc_level(p.cpu)).add_modifier(Modifier::BOLD))]),
        Line::from(vec![
            key("Memory"),
            Span::styled(format!("{:.1}%", p.mem), Style::new().fg(FG).add_modifier(Modifier::BOLD)),
            Span::styled(format!("  (≈ {mem_gib:.2} GiB)"), Style::new().fg(DIM)),
        ]),
        Line::from(vec![key("Threads"), Span::styled(p.threads.to_string(), Style::new().fg(FG))]),
        Line::from(vec![key("Started"), Span::styled(truncate(&started, vw), Style::new().fg(FG))]),
        Line::from(vec![key("Command"), Span::styled(truncate(&p.command, vw), Style::new().fg(GREEN))]),
    ];
    lines.truncate(inner.height as usize);
    f.render_widget(Paragraph::new(lines), inner);

    // meters next to CPU / Memory values
    let buf = f.buffer_mut();
    let mx = inner.x + 10 + 8;
    let mw = inner.width.saturating_sub(10 + 8);
    if mw >= 6 {
        if inner.height > 6 {
            draw_meter(buf, mx + 2, inner.y + 6, mw.saturating_sub(2).min(30), p.cpu, true);
        }
    }
}
