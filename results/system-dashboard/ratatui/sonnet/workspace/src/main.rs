use std::{
    fs, io,
    time::{Duration, Instant},
};

use crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};
use ratatui::{
    DefaultTerminal, Frame,
    layout::{Alignment, Constraint, Layout, Margin, Rect},
    style::{Color, Modifier, Style},
    symbols::Marker,
    text::{Line, Span},
    widgets::{
        Axis, Block, BorderType, Cell, Chart, Clear, Dataset, GraphType, Paragraph, Row,
        Scrollbar, ScrollbarOrientation, ScrollbarState, Table, TableState, Wrap,
    },
};
use serde::Deserialize;

// ---------------------------------------------------------------- data

#[derive(Deserialize, Clone)]
struct MemInfo {
    #[serde(rename = "usedGiB")]
    used: f64,
    #[serde(rename = "totalGiB")]
    total: f64,
}

#[derive(Deserialize, Clone)]
struct NetInfo {
    #[serde(rename = "rxKiBps")]
    rx: f64,
    #[serde(rename = "txKiBps")]
    tx: f64,
}

#[derive(Deserialize, Clone)]
struct Sample {
    cpu: Vec<f64>,
    mem: MemInfo,
    swap: MemInfo,
    net: NetInfo,
    load: Vec<f64>,
}

impl Sample {
    fn avg(&self) -> f64 {
        if self.cpu.is_empty() {
            0.0
        } else {
            self.cpu.iter().sum::<f64>() / self.cpu.len() as f64
        }
    }
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

// ---------------------------------------------------------------- theme

const BG: Color = Color::Rgb(13, 16, 22);
const BORDER: Color = Color::Rgb(62, 71, 92);
const TITLE: Color = Color::Rgb(125, 166, 250);
const TEXT: Color = Color::Rgb(205, 210, 222);
const DIM: Color = Color::Rgb(112, 121, 140);
const FAINT: Color = Color::Rgb(46, 52, 66);
const GREEN: Color = Color::Rgb(106, 208, 128);
const YELLOW: Color = Color::Rgb(232, 197, 92);
const RED: Color = Color::Rgb(242, 98, 104);
const CYAN: Color = Color::Rgb(88, 204, 224);
const MAGENTA: Color = Color::Rgb(214, 128, 236);
const ORANGE: Color = Color::Rgb(246, 156, 80);
const SEL_BG: Color = Color::Rgb(40, 56, 92);

fn lerp(a: (u8, u8, u8), b: (u8, u8, u8), t: f64) -> (u8, u8, u8) {
    let f = |x: u8, y: u8| (x as f64 + (y as f64 - x as f64) * t).round() as u8;
    (f(a.0, b.0), f(a.1, b.1), f(a.2, b.2))
}

fn grad(t: f64) -> Color {
    let t = t.clamp(0.0, 1.0);
    let g = (106, 208, 128);
    let y = (232, 197, 92);
    let r = (242, 98, 104);
    let c = if t < 0.55 {
        lerp(g, y, t / 0.55)
    } else {
        lerp(y, r, (t - 0.55) / 0.45)
    };
    Color::Rgb(c.0, c.1, c.2)
}

fn usage_color(pct: f64) -> Color {
    if pct >= 80.0 {
        RED
    } else if pct >= 50.0 {
        YELLOW
    } else {
        GREEN
    }
}

fn st(fg: Color) -> Style {
    Style::new().fg(fg)
}

fn bold(fg: Color) -> Style {
    Style::new().fg(fg).add_modifier(Modifier::BOLD)
}

// ---------------------------------------------------------------- helpers

fn bar(frac: f64, width: usize) -> Vec<Span<'static>> {
    const PARTIAL: [&str; 8] = [" ", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
    let frac = frac.clamp(0.0, 1.0);
    let eighths = (frac * width as f64 * 8.0).round() as usize;
    let full = (eighths / 8).min(width);
    let rem = eighths % 8;
    let mut out = Vec::with_capacity(width);
    for i in 0..width {
        let pos = (i as f64 + 0.5) / width.max(1) as f64;
        if i < full {
            out.push(Span::styled("█", st(grad(pos))));
        } else if i == full && rem > 0 && full < width {
            out.push(Span::styled(PARTIAL[rem], Style::new().fg(grad(pos)).bg(FAINT)));
        } else {
            out.push(Span::styled("░", st(FAINT)));
        }
    }
    out
}

fn fmt_rate(kib: f64) -> String {
    if kib >= 1024.0 {
        format!("{:.2} MiB/s", kib / 1024.0)
    } else {
        format!("{:.0} KiB/s", kib)
    }
}

fn fmt_rate_short(kib: f64) -> String {
    if kib >= 1024.0 {
        format!("{:.1}M", kib / 1024.0)
    } else {
        format!("{:.0}K", kib)
    }
}

fn nice_ceil(v: f64) -> f64 {
    if v <= 1.0 {
        return 1.0;
    }
    let mag = 10f64.powf(v.log10().floor());
    for m in [1.0, 2.0, 2.5, 4.0, 5.0, 8.0, 10.0] {
        if v <= m * mag {
            return m * mag;
        }
    }
    10.0 * mag
}

fn panel<'a>(title: Vec<Span<'a>>) -> Block<'a> {
    Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(st(BORDER))
        .style(Style::new().bg(BG))
        .title(Line::from(title))
}

fn title_spans(name: &str, extra: Vec<Span<'static>>) -> Vec<Span<'static>> {
    let mut v = vec![Span::styled(format!(" {name} "), bold(TITLE))];
    v.extend(extra);
    v
}

fn put(f: &mut Frame, line: Line<'static>, area: Rect) {
    if area.width == 0 || area.height == 0 {
        return;
    }
    f.render_widget(Paragraph::new(line), area);
}

fn sub(area: Rect, x: u16, y: u16, w: u16, h: u16) -> Rect {
    let x0 = area.x.saturating_add(x).min(area.right());
    let y0 = area.y.saturating_add(y).min(area.bottom());
    Rect::new(
        x0,
        y0,
        w.min(area.right().saturating_sub(x0)),
        h.min(area.bottom().saturating_sub(y0)),
    )
}

/// Label on the left, value on the right of a line of `width` columns.
fn lr_line(left: Vec<Span<'static>>, right: Vec<Span<'static>>, width: usize) -> Line<'static> {
    let lw: usize = left.iter().map(|s| s.content.chars().count()).sum();
    let rw: usize = right.iter().map(|s| s.content.chars().count()).sum();
    let mut spans = left;
    spans.push(Span::raw(" ".repeat(width.saturating_sub(lw + rw).max(1))));
    spans.extend(right);
    Line::from(spans)
}

// ---------------------------------------------------------------- app state

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
    fn arrow(self) -> &'static str {
        match self {
            SortKey::Cpu | SortKey::Mem => "▼",
            SortKey::Pid | SortKey::Name => "▲",
        }
    }
}

struct App {
    m: Metrics,
    played_ms: u64,
    paused: bool,
    sort: SortKey,
    order: Vec<usize>,
    table: TableState,
    popup: bool,
    quit: bool,
}

impl App {
    fn new(m: Metrics) -> Self {
        let mut a = App {
            m,
            played_ms: 0,
            paused: false,
            sort: SortKey::Cpu,
            order: vec![],
            table: TableState::default().with_selected(Some(0)),
            popup: false,
            quit: false,
        };
        a.resort();
        a
    }

    fn n(&self) -> usize {
        self.m.samples.len()
    }

    fn idx(&self) -> usize {
        let iv = self.m.interval_ms.max(1);
        ((self.played_ms / iv) as usize).min(self.n().saturating_sub(1))
    }

    fn finished(&self) -> bool {
        self.n() == 0 || self.idx() >= self.n() - 1
    }

    fn cur(&self) -> &Sample {
        &self.m.samples[self.idx()]
    }

    fn resort(&mut self) {
        let p = &self.m.processes;
        let mut o: Vec<usize> = (0..p.len()).collect();
        match self.sort {
            SortKey::Cpu => o.sort_by(|&a, &b| p[b].cpu.partial_cmp(&p[a].cpu).unwrap()),
            SortKey::Mem => o.sort_by(|&a, &b| p[b].mem.partial_cmp(&p[a].mem).unwrap()),
            SortKey::Pid => o.sort_by_key(|&a| p[a].pid),
            SortKey::Name => o.sort_by_key(|&a| p[a].name.to_lowercase()),
        }
        self.order = o;
    }

    fn selected(&self) -> usize {
        self.table.selected().unwrap_or(0).min(self.order.len().saturating_sub(1))
    }

    fn select(&mut self, i: isize) {
        if self.order.is_empty() {
            return;
        }
        let i = i.clamp(0, self.order.len() as isize - 1) as usize;
        self.table.select(Some(i));
    }

    fn key(&mut self, code: KeyCode, mods: KeyModifiers) {
        if mods.contains(KeyModifiers::CONTROL) {
            if code == KeyCode::Char('c') {
                self.quit = true;
            }
            return;
        }
        match code {
            KeyCode::Char('q') | KeyCode::Char('Q') => self.quit = true,
            KeyCode::Esc => self.popup = false,
            KeyCode::Char('p') | KeyCode::Char('P') => self.paused = !self.paused,
            _ if self.popup => {}
            KeyCode::Char('j') | KeyCode::Down => self.select(self.selected() as isize + 1),
            KeyCode::Char('k') | KeyCode::Up => self.select(self.selected() as isize - 1),
            KeyCode::PageDown => self.select(self.selected() as isize + 10),
            KeyCode::PageUp => self.select(self.selected() as isize - 10),
            KeyCode::Home | KeyCode::Char('g') => self.select(0),
            KeyCode::End | KeyCode::Char('G') => self.select(isize::MAX / 2),
            KeyCode::Char('s') | KeyCode::Char('S') => {
                self.sort = self.sort.next();
                self.resort();
            }
            KeyCode::Enter => {
                if !self.order.is_empty() {
                    self.popup = true;
                }
            }
            _ => {}
        }
    }
}

// ---------------------------------------------------------------- rendering

fn render(f: &mut Frame, app: &mut App) {
    let area = f.area();
    f.render_widget(Block::new().style(Style::new().bg(BG).fg(TEXT)), area);
    if area.width < 4 || area.height < 2 {
        return;
    }
    let h = area.height;
    let w = area.width;
    let hdr_h = if h >= 20 { 3 } else { 1 };
    let [hdr, body, ftr] = Layout::vertical([
        Constraint::Length(hdr_h),
        Constraint::Min(0),
        Constraint::Length(1),
    ])
    .areas(area);

    render_header(f, app, hdr);
    render_footer(f, app, ftr);

    let wide = w >= 100;
    let procs;
    if h >= 32 {
        let (ah, bh) = if h >= 44 { (11, 10) } else { (9, 8) };
        let [a, b, c] = Layout::vertical([
            Constraint::Length(ah),
            Constraint::Length(bh),
            Constraint::Min(3),
        ])
        .areas(body);
        render_top(f, app, a);
        render_mid(f, app, b, wide);
        procs = c;
    } else if h >= 26 {
        let [a, b, c] = Layout::vertical([
            Constraint::Length(8),
            Constraint::Length(7),
            Constraint::Min(3),
        ])
        .areas(body);
        render_top(f, app, a);
        render_mid(f, app, b, wide);
        procs = c;
    } else if h >= 20 {
        let [a, b, c] = Layout::vertical([
            Constraint::Length(7),
            Constraint::Length(3),
            Constraint::Min(3),
        ])
        .areas(body);
        render_top(f, app, a);
        let blk = panel(title_spans("System", vec![]));
        let inner = blk.inner(b);
        f.render_widget(blk, b);
        put(f, strip_line(app, inner.width as usize), inner);
        procs = c;
    } else if h >= 10 {
        let [a, c] = Layout::vertical([Constraint::Length(1), Constraint::Min(3)]).areas(body);
        put(f, strip_line(app, a.width as usize), a);
        procs = c;
    } else {
        procs = body;
    }
    render_procs(f, app, procs);

    if app.popup {
        f.buffer_mut().set_style(area, Style::new().add_modifier(Modifier::DIM));
        render_popup(f, app, area);
    }
}

fn status_spans(app: &App) -> Vec<Span<'static>> {
    let mut v = vec![];
    if app.finished() {
        v.push(Span::styled(
            " ■ REPLAY FINISHED ",
            Style::new().fg(Color::Rgb(20, 20, 24)).bg(ORANGE).add_modifier(Modifier::BOLD),
        ));
    } else if app.paused {
        v.push(Span::styled(
            " ⏸ PAUSED ",
            Style::new().fg(Color::Rgb(20, 20, 24)).bg(YELLOW).add_modifier(Modifier::BOLD),
        ));
    } else {
        v.push(Span::styled(
            " ▶ PLAYING ",
            Style::new().fg(Color::Rgb(20, 20, 24)).bg(GREEN).add_modifier(Modifier::BOLD),
        ));
    }
    v
}

fn render_header(f: &mut Frame, app: &App, area: Rect) {
    let inner = if area.height >= 3 {
        let b = Block::bordered()
            .border_type(BorderType::Rounded)
            .border_style(st(BORDER))
            .style(Style::new().bg(BG));
        let i = b.inner(area);
        f.render_widget(b, area);
        sub(i, 1, 0, i.width.saturating_sub(2), i.height)
    } else {
        area
    };
    let w = inner.width as usize;
    let n = app.n();
    let pos = format!("sample {}/{}", app.idx() + 1, n);

    let mut right = status_spans(app);
    right.push(Span::raw(" "));
    right.push(Span::styled(pos, bold(TEXT)));
    if w >= 100 {
        right.push(Span::raw(" "));
        let frac = if n > 1 { app.idx() as f64 / (n - 1) as f64 } else { 1.0 };
        let bw = 14usize;
        let filled = (frac * bw as f64).round() as usize;
        right.push(Span::styled("━".repeat(filled), st(if app.finished() { ORANGE } else { CYAN })));
        right.push(Span::styled("─".repeat(bw - filled), st(FAINT)));
    }
    let rw: usize = right.iter().map(|s| s.content.chars().count()).sum();
    let avail = w.saturating_sub(rw + 2);
    let sep = || Span::styled("  │  ", st(BORDER));
    let mut left = vec![
        Span::styled("◆ ", bold(CYAN)),
        Span::styled(app.m.host.clone(), bold(TEXT)),
    ];
    let mut used = 2 + app.m.host.chars().count();
    let opts: Vec<Vec<Span<'static>>> = vec![
        vec![Span::styled(app.m.kernel.clone(), st(DIM))],
        vec![Span::styled("up ", st(DIM)), Span::styled(app.m.uptime.clone(), st(TEXT))],
        vec![Span::styled(format!("{} cores", app.m.cores), st(DIM))],
    ];
    for o in opts {
        let ow: usize = o.iter().map(|s| s.content.chars().count()).sum::<usize>() + 5;
        if used + ow > avail {
            break;
        }
        used += ow;
        left.push(sep());
        left.extend(o);
    }
    let rw = rw as u16;
    put(f, Line::from(left), inner);
    if inner.width > rw {
        let r = sub(inner, inner.width - rw, 0, rw, inner.height);
        put(f, Line::from(right), r);
    }
}

fn render_footer(f: &mut Frame, app: &App, area: Rect) {
    let key = |k: &'static str| {
        Span::styled(format!(" {k} "), Style::new().fg(Color::Rgb(20, 22, 30)).bg(DIM).add_modifier(Modifier::BOLD))
    };
    let lab = |t: &'static str| Span::styled(format!(" {t}  "), st(DIM));
    let mut v = vec![Span::raw(" ")];
    if app.popup {
        v.extend([key("esc"), lab("Close"), key("p"), lab("Pause"), key("q"), lab("Quit")]);
    } else {
        v.extend([
            key("j/k ↑↓"),
            lab("Select"),
            key("s"),
            lab("Sort"),
            key("enter"),
            lab("Details"),
            key("p"),
            lab(if app.paused { "Resume" } else { "Pause" }),
            key("q"),
            lab("Quit"),
        ]);
    }
    put(f, Line::from(v), area);
    let r = format!("sort: {} {} ", app.sort.label(), app.sort.arrow());
    let rw = r.chars().count() as u16;
    if area.width > rw + 60 {
        put(f, Line::from(Span::styled(r, st(DIM))), sub(area, area.width - rw, 0, rw, 1));
    }
}

fn render_top(f: &mut Frame, app: &App, area: Rect) {
    if area.width >= 80 {
        let [l, r] = Layout::horizontal([Constraint::Percentage(50), Constraint::Percentage(50)]).areas(area);
        render_cpu(f, app, l);
        render_cpu_history(f, app, r);
    } else {
        render_cpu(f, app, area);
    }
}

fn render_cpu(f: &mut Frame, app: &App, area: Rect) {
    let s = app.cur();
    let avg = s.avg();
    let title = title_spans(
        "CPU",
        vec![Span::styled(format!("{} cores ", s.cpu.len()), st(DIM))],
    );
    let blk = panel(title);
    let inner = blk.inner(area);
    f.render_widget(blk, area);
    let inner = inner.inner(Margin::new(1, 0));
    if inner.width < 12 || inner.height == 0 {
        return;
    }
    // overall average
    let bw = (inner.width as usize).saturating_sub(4 + 8);
    let mut sp = vec![Span::styled("AVG ", bold(TEXT))];
    sp.extend(bar(avg / 100.0, bw));
    sp.push(Span::styled(format!(" {avg:5.1}%"), bold(usage_color(avg))));
    put(f, Line::from(sp), sub(inner, 0, 0, inner.width, 1));

    let nc = s.cpu.len();
    if nc == 0 {
        return;
    }
    let gap = if inner.height >= 7 { 2 } else { 1 };
    let rows = (inner.height as usize).saturating_sub(gap).max(1);
    let mut cols = nc.div_ceil(rows).max(1);
    let max_cols = ((inner.width as usize) / 20).max(1);
    cols = cols.min(max_cols);
    let per_col = nc.div_ceil(cols).min(rows);
    let cw = inner.width as usize / cols;
    for (i, &v) in s.cpu.iter().enumerate() {
        let c = i / per_col.max(1);
        let r = i % per_col.max(1);
        if c >= cols {
            break;
        }
        let x = (c * cw) as u16;
        let w_here = if c + 1 == cols { inner.width - x } else { (cw - 2) as u16 };
        let bw = (w_here as usize).saturating_sub(4 + 7);
        let mut sp = vec![Span::styled(format!("{:>2}  ", i), st(DIM))];
        sp.extend(bar(v / 100.0, bw));
        sp.push(Span::styled(format!(" {v:5.1}%"), st(usage_color(v))));
        put(f, Line::from(sp), sub(inner, x, gap as u16 + r as u16, w_here, 1));
    }
}

fn render_cpu_history(f: &mut Frame, app: &App, area: Rect) {
    let cur = app.idx();
    let avg = app.cur().avg();
    let played = &app.m.samples[..=cur];
    let peak = played.iter().map(|s| s.avg()).fold(0.0, f64::max);
    let title = title_spans(
        "CPU History",
        vec![
            Span::styled(format!("now {avg:.1}%"), bold(usage_color(avg))),
            Span::styled(format!("  peak {peak:.1}% "), st(DIM)),
        ],
    );
    let blk = panel(title);
    let inner = blk.inner(area);
    f.render_widget(blk, area);
    let inner = inner.inner(Margin::new(1, 0));
    if inner.width < 12 || inner.height < 3 {
        return;
    }
    let axis_w = 4u16;
    let plot_w = (inner.width - axis_w) as usize;
    let plot_h = (inner.height - 1) as usize;
    let n = app.n();
    let avgs: Vec<f64> = app.m.samples.iter().map(|s| s.avg()).collect();
    const LV: [&str; 9] = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

    // value per column (None = not yet played)
    let mut vals: Vec<Option<f64>> = Vec::with_capacity(plot_w);
    for c in 0..plot_w {
        let pos = if plot_w > 1 { c as f64 * (n - 1) as f64 / (plot_w - 1) as f64 } else { 0.0 };
        if pos > cur as f64 + 1e-9 {
            vals.push(None);
            continue;
        }
        let i0 = pos.floor() as usize;
        let i1 = (i0 + 1).min(cur);
        let t = pos - i0 as f64;
        vals.push(Some(avgs[i0] * (1.0 - t) + avgs[i1] * t));
    }
    let mid_row = plot_h / 2;
    let mut lines = Vec::new();
    for r in 0..plot_h {
        let label = if r == 0 {
            "100 ".to_string()
        } else if r == mid_row && plot_h >= 4 {
            " 50 ".to_string()
        } else if r == plot_h - 1 {
            "  0 ".to_string()
        } else {
            "    ".to_string()
        };
        let mut sp = vec![Span::styled(label, st(DIM))];
        let base = (plot_h - 1 - r) as f64;
        for v in &vals {
            let color = grad((base + 0.5) / plot_h as f64);
            match v {
                Some(v) => {
                    let e = (v / 100.0 * plot_h as f64 * 8.0).round() - base * 8.0;
                    let e = e.clamp(0.0, 8.0) as usize;
                    if e == 0 {
                        if r == mid_row && plot_h >= 4 {
                            sp.push(Span::styled("┈", st(FAINT)));
                        } else {
                            sp.push(Span::raw(" "));
                        }
                    } else {
                        sp.push(Span::styled(LV[e], st(color)));
                    }
                }
                None => {
                    if r == mid_row && plot_h >= 4 {
                        sp.push(Span::styled("┈", st(FAINT)));
                    } else {
                        sp.push(Span::raw(" "));
                    }
                }
            }
        }
        lines.push(Line::from(sp));
    }
    // x axis
    let total = n as f64 * app.m.interval_ms as f64 / 1000.0;
    let l = "0s".to_string();
    let m = format!("{:.1}s", total / 2.0);
    let rr = format!("{:.1}s", total);
    let pw = plot_w;
    let mut x = " ".repeat(axis_w as usize);
    x.push_str(&l);
    let mid_at = pw / 2usize;
    let used = l.len();
    x.push_str(&" ".repeat(mid_at.saturating_sub(used + m.len() / 2)));
    x.push_str(&m);
    let used2 = used + mid_at.saturating_sub(used + m.len() / 2) + m.len();
    x.push_str(&" ".repeat(pw.saturating_sub(used2 + rr.len())));
    x.push_str(&rr);
    lines.push(Line::from(Span::styled(x, st(DIM))));
    f.render_widget(Paragraph::new(lines), inner);
}

fn render_mid(f: &mut Frame, app: &App, area: Rect, wide: bool) {
    if wide {
        let [a, b, c] = Layout::horizontal([
            Constraint::Fill(30),
            Constraint::Fill(45),
            Constraint::Fill(25),
        ])
        .areas(area);
        render_memory(f, app, a);
        render_network(f, app, b);
        render_load(f, app, c);
    } else {
        let [a, b] = Layout::horizontal([Constraint::Fill(1), Constraint::Fill(1)]).areas(area);
        render_memory(f, app, a);
        render_network(f, app, b);
    }
}

fn mem_row(
    f: &mut Frame,
    inner: Rect,
    y: u16,
    name: &str,
    used: f64,
    total: f64,
    two_line: bool,
) {
    let pct = if total > 0.0 { used / total * 100.0 } else { 0.0 };
    let col = usage_color(pct);
    let w = inner.width as usize;
    if two_line {
        let amount = if w >= 34 {
            format!("{used:.2} / {total:.2} GiB  ")
        } else {
            format!("{used:.1}/{total:.1}G  ")
        };
        let l = lr_line(
            vec![Span::styled(name.to_string(), bold(TEXT))],
            vec![
                Span::styled(amount, st(DIM)),
                Span::styled(format!("{pct:4.1}%"), bold(col)),
            ],
            w,
        );
        put(f, l, sub(inner, 0, y, inner.width, 1));
        put(f, Line::from(bar(pct / 100.0, w)), sub(inner, 0, y + 1, inner.width, 1));
    } else {
        let txt = format!(" {used:.1}/{total:.1}G {pct:4.1}%");
        let bw = w.saturating_sub(name.len() + 1 + txt.len());
        let mut sp = vec![Span::styled(format!("{name} "), bold(TEXT))];
        sp.extend(bar(pct / 100.0, bw));
        sp.push(Span::styled(txt, st(col)));
        put(f, Line::from(sp), sub(inner, 0, y, inner.width, 1));
    }
}

fn render_memory(f: &mut Frame, app: &App, area: Rect) {
    let s = app.cur();
    let blk = panel(title_spans("Memory", vec![]));
    let inner = blk.inner(area);
    f.render_widget(blk, area);
    let inner = inner.inner(Margin::new(1, 0));
    if inner.width < 10 || inner.height == 0 {
        return;
    }
    let two = inner.height >= 4;
    mem_row(f, inner, 0, "Memory", s.mem.used, s.mem.total, two);
    let y = if two { if inner.height >= 6 { 3 } else { 2 } } else { 1 };
    mem_row(f, inner, y, "Swap", s.swap.used, s.swap.total, two);
    if two && inner.height >= 6 {
        let free = (s.mem.total - s.mem.used).max(0.0);
        put(
            f,
            Line::from(vec![
                Span::styled("Free ", st(DIM)),
                Span::styled(format!("{free:.2} GiB"), st(GREEN)),
            ]),
            sub(inner, 0, 5, inner.width, 1),
        );
    }
}

fn render_network(f: &mut Frame, app: &App, area: Rect) {
    let cur = app.idx();
    let s = app.cur();
    let blk = panel(title_spans("Network", vec![]));
    let inner = blk.inner(area);
    f.render_widget(blk, area);
    let inner = inner.inner(Margin::new(1, 0));
    if inner.width < 16 || inner.height == 0 {
        return;
    }
    let l = lr_line(
        vec![
            Span::styled("▼ RX ", bold(CYAN)),
            Span::styled(fmt_rate(s.net.rx), bold(TEXT)),
        ],
        vec![
            Span::styled("▲ TX ", bold(MAGENTA)),
            Span::styled(fmt_rate(s.net.tx), bold(TEXT)),
        ],
        inner.width as usize,
    );
    put(f, l, sub(inner, 0, 0, inner.width, 1));
    if inner.height < 3 {
        return;
    }
    let played = &app.m.samples[..=cur];
    let rx: Vec<(f64, f64)> = played.iter().enumerate().map(|(i, s)| (i as f64, s.net.rx)).collect();
    let tx: Vec<(f64, f64)> = played.iter().enumerate().map(|(i, s)| (i as f64, s.net.tx)).collect();
    let peak = played.iter().map(|s| s.net.rx.max(s.net.tx)).fold(0.0, f64::max);
    let ymax = nice_ceil(peak * 1.1);
    let n = app.n();
    let total = n as f64 * app.m.interval_ms as f64 / 1000.0;
    let ds = vec![
        Dataset::default()
            .marker(Marker::Braille)
            .graph_type(GraphType::Line)
            .style(st(CYAN))
            .data(&rx),
        Dataset::default()
            .marker(Marker::Braille)
            .graph_type(GraphType::Line)
            .style(st(MAGENTA))
            .data(&tx),
    ];
    let xl = vec![
        Span::styled("0s", st(DIM)),
        Span::styled(format!("{:.1}s", total / 2.0), st(DIM)),
        Span::styled(format!("{:.1}s", total), st(DIM)),
    ];
    let yl = vec![
        Span::styled("0", st(DIM)),
        Span::styled(fmt_rate_short(ymax / 2.0), st(DIM)),
        Span::styled(fmt_rate_short(ymax), st(DIM)),
    ];
    let chart = Chart::new(ds)
        .style(Style::new().bg(BG))
        .x_axis(Axis::default().style(st(FAINT)).bounds([0.0, (n - 1) as f64]).labels(xl))
        .y_axis(Axis::default().style(st(FAINT)).bounds([0.0, ymax]).labels(yl))
        .legend_position(None);
    f.render_widget(chart, sub(inner, 0, 1, inner.width, inner.height - 1));
}

fn render_load(f: &mut Frame, app: &App, area: Rect) {
    let s = app.cur();
    let cores = app.m.cores.max(1) as f64;
    let blk = panel(title_spans(
        "Load Average",
        vec![],
    ));
    let inner = blk.inner(area);
    f.render_widget(blk, area);
    let inner = inner.inner(Margin::new(1, 0));
    if inner.width < 10 || inner.height == 0 {
        return;
    }
    let names = ["1 min", "5 min", "15 min"];
    let two = inner.height >= 6;
    for i in 0..3 {
        let v = s.load.get(i).copied().unwrap_or(0.0);
        let ratio = v / cores;
        let col = if ratio >= 1.0 {
            RED
        } else if ratio >= 0.6 {
            YELLOW
        } else {
            GREEN
        };
        let trend = if i < 2 {
            let o = s.load.get(i + 1).copied().unwrap_or(v);
            if v > o + 0.05 {
                Span::styled(" ▲", st(RED))
            } else if v < o - 0.05 {
                Span::styled(" ▼", st(GREEN))
            } else {
                Span::styled(" ▬", st(DIM))
            }
        } else {
            Span::raw("")
        };
        let y = if two { (i * 2) as u16 } else { i as u16 };
        if two {
            let l = lr_line(
                vec![Span::styled(names[i], st(DIM))],
                vec![Span::styled(format!("{v:.2}"), bold(col)), trend],
                inner.width as usize,
            );
            put(f, l, sub(inner, 0, y, inner.width, 1));
            put(f, Line::from(bar(ratio, inner.width as usize)), sub(inner, 0, y + 1, inner.width, 1));
        } else {
            let txt = format!(" {v:.2}");
            let bw = (inner.width as usize).saturating_sub(7 + txt.len() + 2);
            let mut sp = vec![Span::styled(format!("{:<6}", names[i]), st(DIM))];
            sp.extend(bar(ratio, bw));
            sp.push(Span::styled(txt, bold(col)));
            sp.push(trend);
            put(f, Line::from(sp), sub(inner, 0, y, inner.width, 1));
        }
    }
}

fn strip_line(app: &App, width: usize) -> Line<'static> {
    let s = app.cur();
    let mp = s.mem.used / s.mem.total.max(0.001) * 100.0;
    let sp = s.swap.used / s.swap.total.max(0.001) * 100.0;
    let avg = s.avg();
    let mut v = vec![
        Span::styled("CPU ", bold(TEXT)),
        Span::styled(format!("{avg:4.1}% "), bold(usage_color(avg))),
        Span::styled("│ ", st(BORDER)),
        Span::styled("MEM ", bold(TEXT)),
    ];
    v.extend(bar(mp / 100.0, 8));
    v.push(Span::styled(format!(" {mp:.0}% "), st(usage_color(mp))));
    v.push(Span::styled("│ ", st(BORDER)));
    v.push(Span::styled("SWP ", bold(TEXT)));
    v.push(Span::styled(format!("{sp:.0}% "), st(usage_color(sp))));
    v.push(Span::styled("│ ", st(BORDER)));
    v.push(Span::styled(format!("▼{} ", fmt_rate_short(s.net.rx)), st(CYAN)));
    v.push(Span::styled(format!("▲{} ", fmt_rate_short(s.net.tx)), st(MAGENTA)));
    v.push(Span::styled("│ ", st(BORDER)));
    v.push(Span::styled("LOAD ", bold(TEXT)));
    v.push(Span::styled(
        s.load.iter().map(|l| format!("{l:.2}")).collect::<Vec<_>>().join(" "),
        st(TEXT),
    ));
    let _ = width;
    Line::from(v)
}

fn state_style(s: &str) -> Style {
    match s {
        "running" => bold(GREEN),
        "sleeping" => st(DIM),
        "idle" => st(CYAN),
        _ => st(YELLOW),
    }
}

fn cpu_proc_color(v: f64) -> Color {
    if v >= 40.0 {
        RED
    } else if v >= 25.0 {
        YELLOW
    } else {
        GREEN
    }
}

fn mem_proc_color(v: f64) -> Color {
    if v >= 10.0 {
        ORANGE
    } else if v >= 5.0 {
        YELLOW
    } else {
        TEXT
    }
}

fn render_procs(f: &mut Frame, app: &mut App, area: Rect) {
    let title = title_spans(
        "Processes",
        vec![
            Span::styled(format!("{} ", app.order.len()), st(DIM)),
            Span::styled("│ ", st(BORDER)),
            Span::styled(
                format!("sorted by {} {} ", app.sort.label(), app.sort.arrow()),
                st(DIM),
            ),
        ],
    );
    let blk = panel(title);
    let inner = blk.inner(area);
    f.render_widget(blk, area);
    if inner.height == 0 || inner.width < 10 {
        return;
    }
    let w = inner.width;
    let show_user = w >= 60;
    let show_state = w >= 46;
    let show_bar = w >= 90;
    let needs_sb = app.order.len() > inner.height.saturating_sub(1) as usize;
    let sorted = app.sort;
    let hdr = |label: &str, k: Option<SortKey>| {
        if k == Some(sorted) {
            Cell::from(format!("{label} {}", sorted.arrow())).style(
                Style::new().fg(Color::Rgb(20, 22, 30)).bg(TITLE).add_modifier(Modifier::BOLD),
            )
        } else {
            Cell::from(label.to_string()).style(bold(DIM))
        }
    };
    let mut hcells = vec![hdr("PID", Some(SortKey::Pid)), hdr("NAME", Some(SortKey::Name))];
    let mut widths = vec![Constraint::Length(7), Constraint::Min(12)];
    if show_user {
        hcells.push(hdr("USER", None));
        widths.push(Constraint::Length(12));
    }
    hcells.push(hdr("CPU%", Some(SortKey::Cpu)));
    widths.push(Constraint::Length(if show_bar { 20 } else { 8 }));
    hcells.push(hdr("MEM%", Some(SortKey::Mem)));
    widths.push(Constraint::Length(8));
    if show_state {
        hcells.push(hdr("STATE", None));
        widths.push(Constraint::Length(10));
    }
    let header = Row::new(hcells).style(Style::new().bg(Color::Rgb(24, 29, 40)));

    let rows: Vec<Row> = app
        .order
        .iter()
        .map(|&i| {
            let p = &app.m.processes[i];
            let mut c = vec![
                Cell::from(p.pid.to_string()).style(st(DIM)),
                Cell::from(p.name.clone()).style(st(TEXT)),
            ];
            if show_user {
                c.push(Cell::from(p.user.clone()).style(st(DIM)));
            }
            if show_bar {
                let mut sp = vec![Span::styled(format!("{:<6.1}", p.cpu), st(cpu_proc_color(p.cpu)))];
                sp.extend(bar(p.cpu / 100.0, 12));
                c.push(Cell::from(Line::from(sp)));
            } else {
                c.push(Cell::from(format!("{:.1}", p.cpu)).style(st(cpu_proc_color(p.cpu))));
            }
            c.push(Cell::from(format!("{:.1}", p.mem)).style(st(mem_proc_color(p.mem))));
            if show_state {
                c.push(Cell::from(format!("{} {}", if p.state == "running" { "●" } else { "○" }, p.state)).style(state_style(&p.state)));
            }
            Row::new(c)
        })
        .collect();

    let table = Table::new(rows, widths)
        .header(header)
        .column_spacing(2)
        .row_highlight_style(Style::new().bg(SEL_BG).add_modifier(Modifier::BOLD))
        .highlight_symbol("▌ ");
    let sel = app.selected();
    app.table.select(Some(sel));
    {
        let visible = inner.height.saturating_sub(1) as usize;
        let off = app.table.offset().min(app.order.len().saturating_sub(visible));
        *app.table.offset_mut() = off;
    }
    let tarea = sub(inner, 0, 0, inner.width.saturating_sub(if needs_sb { 1 } else { 0 }), inner.height);
    f.render_stateful_widget(table, tarea, &mut app.table);

    let visible = inner.height.saturating_sub(1) as usize;
    if app.order.len() > visible && visible > 0 {
        let mut ss = ScrollbarState::new(app.order.len().saturating_sub(visible)).position(app.table.offset());
        let sb = Scrollbar::new(ScrollbarOrientation::VerticalRight)
            .begin_symbol(None)
            .end_symbol(None)
            .track_symbol(Some("│"))
            .thumb_symbol("┃")
            .style(st(BORDER));
        let sbar = sub(area, 0, 2, area.width, area.height.saturating_sub(3));
        f.render_stateful_widget(sb, sbar, &mut ss);
    }
}

fn render_popup(f: &mut Frame, app: &App, area: Rect) {
    if app.order.is_empty() {
        return;
    }
    let p = &app.m.processes[app.order[app.selected()]];
    let w = area.width.saturating_sub(4).min(64).max(20.min(area.width));
    let h = area.height.saturating_sub(2).min(16).max(6.min(area.height));
    let r = Rect::new(
        area.x + (area.width.saturating_sub(w)) / 2,
        area.y + (area.height.saturating_sub(h)) / 2,
        w.min(area.width),
        h.min(area.height),
    );
    f.render_widget(Clear, r);
    let blk = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(st(CYAN))
        .style(Style::new().bg(Color::Rgb(18, 23, 33)).fg(TEXT))
        .title(Line::from(vec![
            Span::styled(" Process ", bold(CYAN)),
            Span::styled(format!("{} ", p.pid), bold(TEXT)),
        ]))
        .title_bottom(Line::from(Span::styled(" esc to close ", st(DIM))).alignment(Alignment::Right));
    let inner = blk.inner(r);
    f.render_widget(blk, r);
    let inner = inner.inner(Margin::new(2, 1));
    let lw = 10usize;
    let field = |k: &str, v: Vec<Span<'static>>| {
        let mut s = vec![Span::styled(format!("{k:<lw$}"), st(DIM))];
        s.extend(v);
        Line::from(s)
    };
    let bw = (inner.width as usize).saturating_sub(lw + 8).clamp(4, 24);
    let mut cpu = bar(p.cpu / 100.0, bw);
    cpu.insert(0, Span::styled(format!("{:5.1}%  ", p.cpu), bold(cpu_proc_color(p.cpu))));
    let mut mem = bar(p.mem / 100.0, bw);
    mem.insert(0, Span::styled(format!("{:5.1}%  ", p.mem), bold(mem_proc_color(p.mem))));
    let lines = vec![
        field("PID", vec![Span::styled(p.pid.to_string(), bold(TEXT))]),
        field("Name", vec![Span::styled(p.name.clone(), bold(TEXT))]),
        field("User", vec![Span::raw(p.user.clone())]),
        field("State", vec![Span::styled(p.state.clone(), state_style(&p.state))]),
        field("CPU%", cpu),
        field("MEM%", mem),
        field("Threads", vec![Span::raw(p.threads.to_string())]),
        field("Started", vec![Span::raw(p.started.clone())]),
        field("Command", vec![Span::styled(p.command.clone(), st(YELLOW))]),
    ];
    f.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), inner);
}

// ---------------------------------------------------------------- main loop

fn run(terminal: &mut DefaultTerminal, mut app: App) -> io::Result<()> {
    let mut last = Instant::now();
    loop {
        terminal.draw(|f| render(f, &mut app))?;
        if app.quit {
            return Ok(());
        }
        let iv = app.m.interval_ms.max(1);
        let timeout = if app.paused || app.finished() {
            Duration::from_millis(200)
        } else {
            Duration::from_millis((iv - app.played_ms % iv).max(2))
        };
        if event::poll(timeout)? {
            match event::read()? {
                Event::Key(k) if k.kind != KeyEventKind::Release => app.key(k.code, k.modifiers),
                _ => {}
            }
        }
        let now = Instant::now();
        if !app.paused && !app.finished() {
            app.played_ms += now.duration_since(last).as_millis() as u64;
        }
        last = now;
    }
}

fn main() -> io::Result<()> {
    let raw = fs::read_to_string("data/metrics.json").unwrap_or_else(|e| {
        eprintln!("cannot read data/metrics.json: {e}");
        std::process::exit(1);
    });
    let metrics: Metrics = serde_json::from_str(&raw).unwrap_or_else(|e| {
        eprintln!("invalid metrics.json: {e}");
        std::process::exit(1);
    });
    if metrics.samples.is_empty() {
        eprintln!("metrics.json has no samples");
        std::process::exit(1);
    }
    let app = App::new(metrics);
    let mut terminal = ratatui::init();
    let res = run(&mut terminal, app);
    ratatui::restore();
    res
}
