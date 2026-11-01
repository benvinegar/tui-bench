use std::{
    fs, io,
    time::{Duration, Instant},
};

use crossterm::{
    event::{
        self, DisableMouseCapture, EnableMouseCapture, Event, KeyCode, KeyEvent, KeyEventKind,
        KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
    },
    execute,
};
use ratatui::{
    DefaultTerminal, Frame,
    buffer::{Buffer, Cell},
    style::{Color, Modifier, Style},
};
use serde::Deserialize;

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct G {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
}

impl G {
    const fn new(x: i32, y: i32, w: i32, h: i32) -> G {
        G { x, y, w, h }
    }
    fn contains(&self, px: i32, py: i32) -> bool {
        px >= self.x && py >= self.y && px < self.x + self.w && py < self.y + self.h
    }
    fn inner(&self) -> G {
        G::new(self.x + 1, self.y + 1, (self.w - 2).max(0), (self.h - 2).max(0))
    }
    fn intersect(&self, o: &G) -> G {
        let x0 = self.x.max(o.x);
        let y0 = self.y.max(o.y);
        let x1 = (self.x + self.w).min(o.x + o.w);
        let y1 = (self.y + self.h).min(o.y + o.h);
        G::new(x0, y0, (x1 - x0).max(0), (y1 - y0).max(0))
    }
}

fn clampi(v: i32, lo: i32, hi: i32) -> i32 {
    if hi < lo { lo } else { v.max(lo).min(hi) }
}

const MIN_W: i32 = 20;
const MIN_H: i32 = 7;

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

const fn rgb(r: u8, g: u8, b: u8) -> Color {
    Color::Rgb(r, g, b)
}

const DESK_BG: Color = rgb(20, 28, 56);
const DESK_FG: Color = rgb(40, 54, 96);
const BAR_BG: Color = rgb(196, 198, 206);
const BAR_FG: Color = rgb(18, 18, 24);
const BAR_HOT: Color = rgb(190, 20, 20);
const BAR_DIM: Color = rgb(120, 122, 132);
const ACCENT: Color = rgb(0, 138, 92);
const ACCENT_FG: Color = rgb(255, 255, 255);
const WHITE: Color = rgb(255, 255, 255);
const BLACK: Color = rgb(0, 0, 0);

fn rgb_of(c: Color) -> (u8, u8, u8) {
    match c {
        Color::Rgb(r, g, b) => (r, g, b),
        Color::Black | Color::Reset => (0, 0, 0),
        Color::White => (255, 255, 255),
        _ => (128, 128, 128),
    }
}

fn scale(c: Color, f: f32) -> Color {
    let (r, g, b) = rgb_of(c);
    rgb(
        (r as f32 * f) as u8,
        (g as f32 * f) as u8,
        (b as f32 * f) as u8,
    )
}

fn mix(c: Color, t: Color, a: f32) -> Color {
    let (r, g, b) = rgb_of(c);
    let (tr, tg, tb) = rgb_of(t);
    let m = |x: u8, y: u8| (x as f32 * (1.0 - a) + y as f32 * a).round() as u8;
    rgb(m(r, tr), m(g, tg), m(b, tb))
}

fn st(fg: Color, bg: Color) -> Style {
    Style::new().fg(fg).bg(bg)
}

#[derive(Clone, Copy)]
struct Pal {
    bg: Color,
    text: Color,
    frame_on: Color,
    frame_off: Color,
    title_on: Color,
    title_off: Color,
    btn: Color,
}

const PAL_NOTES: Pal = Pal {
    bg: rgb(26, 56, 146),
    text: rgb(228, 232, 246),
    frame_on: rgb(255, 255, 255),
    frame_off: rgb(140, 160, 210),
    title_on: rgb(255, 255, 255),
    title_off: rgb(176, 190, 226),
    btn: rgb(110, 255, 150),
};
const PAL_CALC: Pal = Pal {
    bg: rgb(182, 184, 192),
    text: rgb(18, 18, 24),
    frame_on: rgb(255, 255, 255),
    frame_off: rgb(96, 98, 110),
    title_on: rgb(0, 0, 0),
    title_off: rgb(70, 72, 84),
    btn: rgb(0, 120, 40),
};
const PAL_FILES: Pal = Pal {
    bg: rgb(0, 100, 114),
    text: rgb(214, 238, 240),
    frame_on: rgb(255, 255, 255),
    frame_off: rgb(120, 172, 178),
    title_on: rgb(255, 255, 255),
    title_off: rgb(170, 206, 210),
    btn: rgb(110, 255, 150),
};
const PAL_MENU: Pal = Pal {
    bg: BAR_BG,
    text: BAR_FG,
    frame_on: rgb(40, 40, 48),
    frame_off: rgb(40, 40, 48),
    title_on: BAR_FG,
    title_off: BAR_FG,
    btn: ACCENT,
};

// ---------------------------------------------------------------------------
// Canvas: clipped drawing into a ratatui buffer
// ---------------------------------------------------------------------------

struct Canvas<'a> {
    buf: &'a mut Buffer,
    clip: G,
}

impl Canvas<'_> {
    fn cell(&mut self, x: i32, y: i32) -> Option<&mut Cell> {
        if !self.clip.contains(x, y) {
            return None;
        }
        let a = self.buf.area;
        if x < a.x as i32
            || y < a.y as i32
            || x >= a.x as i32 + a.width as i32
            || y >= a.y as i32 + a.height as i32
        {
            return None;
        }
        self.buf.cell_mut((x as u16, y as u16))
    }
    fn put(&mut self, x: i32, y: i32, ch: char, s: Style) {
        if let Some(c) = self.cell(x, y) {
            c.reset();
            c.set_char(ch);
            c.set_style(s);
        }
    }
    fn text(&mut self, x: i32, y: i32, t: &str, s: Style) -> i32 {
        let mut cx = x;
        for ch in t.chars() {
            self.put(cx, y, ch, s);
            cx += 1;
        }
        cx - x
    }
    fn fill(&mut self, g: G, ch: char, s: Style) {
        for yy in g.y..g.y + g.h {
            for xx in g.x..g.x + g.w {
                self.put(xx, yy, ch, s);
            }
        }
    }
    fn modify(&mut self, g: G, f: impl Fn(&mut Cell)) {
        for yy in g.y..g.y + g.h {
            for xx in g.x..g.x + g.w {
                if let Some(c) = self.cell(xx, yy) {
                    f(c);
                }
            }
        }
    }
    fn shadow(&mut self, g: G) {
        let dark = |c: &mut Cell| {
            c.fg = scale(c.fg, 0.38);
            c.bg = scale(c.bg, 0.32);
        };
        self.modify(G::new(g.x + g.w, g.y + 1, 2, g.h), dark);
        self.modify(G::new(g.x + 2, g.y + g.h, (g.w - 2).max(0), 1), dark);
    }
}

fn chars_len(s: &str) -> i32 {
    s.chars().count() as i32
}

fn truncate(s: &str, w: i32) -> String {
    if w <= 0 {
        return String::new();
    }
    let n = chars_len(s);
    if n <= w {
        s.to_string()
    } else if w == 1 {
        "…".to_string()
    } else {
        let mut t: String = s.chars().take((w - 1) as usize).collect();
        t.push('…');
        t
    }
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
    Notes,
    Calc,
    Files,
}

const KINDS: [Kind; 3] = [Kind::Notes, Kind::Calc, Kind::Files];

impl Kind {
    fn title(self) -> &'static str {
        match self {
            Kind::Notes => "Notes",
            Kind::Calc => "Calculator",
            Kind::Files => "Files",
        }
    }
    fn default_geom(self) -> G {
        match self {
            Kind::Notes => G::new(4, 3, 44, 16),
            Kind::Calc => G::new(72, 4, 28, 17),
            Kind::Files => G::new(8, 14, 56, 14),
        }
    }
    fn pal(self) -> Pal {
        match self {
            Kind::Notes => PAL_NOTES,
            Kind::Calc => PAL_CALC,
            Kind::Files => PAL_FILES,
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct Win {
    kind: Kind,
    g: G,
    /// Geometry the user asked for; used to refit after terminal resizes.
    pref: G,
    /// Geometry to return to when the window is maximized.
    restore: Option<G>,
}

// ---------------------------------------------------------------------------
// Notes editor
// ---------------------------------------------------------------------------

struct Notes {
    lines: Vec<Vec<char>>,
    row: usize,
    col: usize,
    want: usize,
    top: usize,
    left: usize,
    vis_h: usize,
    modified: bool,
}

impl Notes {
    fn load() -> Notes {
        let text = fs::read_to_string("data/notes.txt").unwrap_or_default();
        let mut lines: Vec<Vec<char>> = text
            .lines()
            .map(|l| l.trim_end_matches('\r').replace('\t', "    ").chars().collect())
            .collect();
        if lines.is_empty() {
            lines.push(Vec::new());
        }
        Notes {
            lines,
            row: 0,
            col: 0,
            want: 0,
            top: 0,
            left: 0,
            vis_h: 10,
            modified: false,
        }
    }

    fn insert(&mut self, ch: char) {
        let line = &mut self.lines[self.row];
        let col = self.col.min(line.len());
        line.insert(col, ch);
        self.col = col + 1;
        self.want = self.col;
        self.modified = true;
    }

    fn key(&mut self, k: KeyEvent) {
        let len = |s: &Self, r: usize| s.lines[r].len();
        match k.code {
            KeyCode::Char(c) => {
                if k.modifiers.contains(KeyModifiers::CONTROL) || k.modifiers.contains(KeyModifiers::ALT) {
                    return;
                }
                self.insert(c);
            }
            KeyCode::Tab => {
                for _ in 0..4 {
                    self.insert(' ');
                }
            }
            KeyCode::Enter => {
                let col = self.col.min(len(self, self.row));
                let rest = self.lines[self.row].split_off(col);
                self.lines.insert(self.row + 1, rest);
                self.row += 1;
                self.col = 0;
                self.want = 0;
                self.modified = true;
            }
            KeyCode::Backspace => {
                if self.col > 0 {
                    let col = self.col.min(len(self, self.row));
                    self.lines[self.row].remove(col - 1);
                    self.col = col - 1;
                    self.modified = true;
                } else if self.row > 0 {
                    let cur = self.lines.remove(self.row);
                    self.row -= 1;
                    self.col = self.lines[self.row].len();
                    self.lines[self.row].extend(cur);
                    self.modified = true;
                }
                self.want = self.col;
            }
            KeyCode::Delete => {
                let l = len(self, self.row);
                if self.col < l {
                    self.lines[self.row].remove(self.col);
                    self.modified = true;
                } else if self.row + 1 < self.lines.len() {
                    let next = self.lines.remove(self.row + 1);
                    self.lines[self.row].extend(next);
                    self.modified = true;
                }
            }
            KeyCode::Left => {
                if self.col > 0 {
                    self.col -= 1;
                } else if self.row > 0 {
                    self.row -= 1;
                    self.col = len(self, self.row);
                }
                self.want = self.col;
            }
            KeyCode::Right => {
                if self.col < len(self, self.row) {
                    self.col += 1;
                } else if self.row + 1 < self.lines.len() {
                    self.row += 1;
                    self.col = 0;
                }
                self.want = self.col;
            }
            KeyCode::Up => {
                if self.row > 0 {
                    self.row -= 1;
                    self.col = self.want.min(len(self, self.row));
                }
            }
            KeyCode::Down => {
                if self.row + 1 < self.lines.len() {
                    self.row += 1;
                    self.col = self.want.min(len(self, self.row));
                }
            }
            KeyCode::Home => {
                self.col = 0;
                self.want = 0;
            }
            KeyCode::End => {
                self.col = len(self, self.row);
                self.want = self.col;
            }
            KeyCode::PageUp => {
                self.row = self.row.saturating_sub(self.vis_h.max(1));
                self.col = self.want.min(len(self, self.row));
            }
            KeyCode::PageDown => {
                self.row = (self.row + self.vis_h.max(1)).min(self.lines.len() - 1);
                self.col = self.want.min(len(self, self.row));
            }
            _ => {}
        }
    }

    fn scroll(&mut self, d: i32) {
        let max_top = self.lines.len().saturating_sub(self.vis_h.max(1));
        let t = (self.top as i32 + d).max(0) as usize;
        self.top = t.min(max_top);
        // keep the cursor inside the view
        if self.row < self.top {
            self.row = self.top;
        } else if self.row >= self.top + self.vis_h.max(1) {
            self.row = self.top + self.vis_h.max(1) - 1;
        }
        self.row = self.row.min(self.lines.len() - 1);
        self.col = self.want.min(self.lines[self.row].len());
    }
}

// ---------------------------------------------------------------------------
// Calculator
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum CK {
    Digit(u8),
    Dot,
    Op(char),
    Eq,
    Clear,
    Back,
    Neg,
}

struct Calc {
    entry: String,
    acc: Option<f64>,
    op: Option<char>,
    fresh: bool,
    expr: String,
    error: bool,
}

fn fmt_num(v: f64) -> String {
    if !v.is_finite() {
        return "Error".into();
    }
    if v == 0.0 {
        return "0".into();
    }
    if v.fract() == 0.0 && v.abs() < 1e15 {
        return format!("{}", v as i64);
    }
    if v.abs() >= 1e15 || v.abs() < 1e-9 {
        return format!("{:.6e}", v)
            .replace("0e", "e")
            .replace("00e", "e");
    }
    let s = format!("{:.10}", v);
    let s = s.trim_end_matches('0').trim_end_matches('.').to_string();
    // limit total significant length
    if s.len() > 16 {
        let int_len = s.find('.').unwrap_or(s.len());
        let dec = 15usize.saturating_sub(int_len);
        let t = format!("{:.*}", dec, v);
        if t.contains('.') {
            return t.trim_end_matches('0').trim_end_matches('.').to_string();
        }
        return t;
    }
    s
}

impl Calc {
    fn new() -> Calc {
        Calc {
            entry: "0".into(),
            acc: None,
            op: None,
            fresh: true,
            expr: String::new(),
            error: false,
        }
    }
    fn val(&self) -> f64 {
        self.entry.parse::<f64>().unwrap_or(0.0)
    }
    fn apply(a: f64, op: char, b: f64) -> Option<f64> {
        let r = match op {
            '+' => a + b,
            '−' => a - b,
            '×' => a * b,
            '÷' => {
                if b == 0.0 {
                    return None;
                }
                a / b
            }
            _ => b,
        };
        if r.is_finite() { Some(r) } else { None }
    }
    fn fail(&mut self) {
        *self = Calc::new();
        self.entry = "Error".into();
        self.expr = "cannot divide by zero".into();
        self.error = true;
    }
    fn press(&mut self, k: CK) {
        if self.error && k != CK::Clear {
            if matches!(k, CK::Digit(_) | CK::Dot) {
                *self = Calc::new();
            } else {
                return;
            }
        }
        match k {
            CK::Digit(d) => {
                let c = (b'0' + d) as char;
                if self.fresh {
                    self.entry = c.to_string();
                    self.fresh = false;
                    if self.op.is_none() {
                        self.expr.clear();
                    }
                } else if self.entry == "0" {
                    self.entry = c.to_string();
                } else if self.entry == "-0" {
                    self.entry = format!("-{c}");
                } else if self.entry.chars().filter(|c| c.is_ascii_digit()).count() < 15 {
                    self.entry.push(c);
                }
            }
            CK::Dot => {
                if self.fresh {
                    self.entry = "0.".into();
                    self.fresh = false;
                    if self.op.is_none() {
                        self.expr.clear();
                    }
                } else if !self.entry.contains('.') {
                    self.entry.push('.');
                }
            }
            CK::Op(o) => {
                match (self.acc, self.op) {
                    (Some(a), Some(p)) if !self.fresh => match Calc::apply(a, p, self.val()) {
                        Some(r) => {
                            self.acc = Some(r);
                            self.entry = fmt_num(r);
                        }
                        None => return self.fail(),
                    },
                    (Some(_), Some(_)) => {}
                    _ => self.acc = Some(self.val()),
                }
                self.op = Some(o);
                self.fresh = true;
                self.expr = format!("{} {}", fmt_num(self.acc.unwrap_or(0.0)), o);
            }
            CK::Eq => {
                if let (Some(a), Some(p)) = (self.acc, self.op) {
                    let b = self.val();
                    match Calc::apply(a, p, b) {
                        Some(r) => {
                            self.expr = format!("{} {} {} =", fmt_num(a), p, fmt_num(b));
                            self.entry = fmt_num(r);
                            self.acc = None;
                            self.op = None;
                            self.fresh = true;
                        }
                        None => self.fail(),
                    }
                }
            }
            CK::Clear => *self = Calc::new(),
            CK::Back => {
                if !self.fresh {
                    self.entry.pop();
                    if self.entry.is_empty() || self.entry == "-" {
                        self.entry = "0".into();
                    }
                }
            }
            CK::Neg => {
                if self.entry != "0" {
                    if let Some(s) = self.entry.strip_prefix('-') {
                        self.entry = s.to_string();
                    } else {
                        self.entry = format!("-{}", self.entry);
                    }
                    if self.fresh && self.op.is_none() {
                        self.expr.clear();
                    }
                }
            }
        }
    }
}

struct Btn {
    label: &'static str,
    key: CK,
    col: i32,
    row: i32,
    span: i32,
}

const BTNS: [Btn; 19] = [
    Btn { label: "C", key: CK::Clear, col: 0, row: 0, span: 2 },
    Btn { label: "←", key: CK::Back, col: 2, row: 0, span: 1 },
    Btn { label: "±", key: CK::Neg, col: 3, row: 0, span: 1 },
    Btn { label: "7", key: CK::Digit(7), col: 0, row: 1, span: 1 },
    Btn { label: "8", key: CK::Digit(8), col: 1, row: 1, span: 1 },
    Btn { label: "9", key: CK::Digit(9), col: 2, row: 1, span: 1 },
    Btn { label: "÷", key: CK::Op('÷'), col: 3, row: 1, span: 1 },
    Btn { label: "4", key: CK::Digit(4), col: 0, row: 2, span: 1 },
    Btn { label: "5", key: CK::Digit(5), col: 1, row: 2, span: 1 },
    Btn { label: "6", key: CK::Digit(6), col: 2, row: 2, span: 1 },
    Btn { label: "×", key: CK::Op('×'), col: 3, row: 2, span: 1 },
    Btn { label: "1", key: CK::Digit(1), col: 0, row: 3, span: 1 },
    Btn { label: "2", key: CK::Digit(2), col: 1, row: 3, span: 1 },
    Btn { label: "3", key: CK::Digit(3), col: 2, row: 3, span: 1 },
    Btn { label: "−", key: CK::Op('−'), col: 3, row: 3, span: 1 },
    Btn { label: "0", key: CK::Digit(0), col: 0, row: 4, span: 1 },
    Btn { label: ".", key: CK::Dot, col: 1, row: 4, span: 1 },
    Btn { label: "=", key: CK::Eq, col: 2, row: 4, span: 1 },
    Btn { label: "+", key: CK::Op('+'), col: 3, row: 4, span: 1 },
];

struct CalcLayout {
    display: G,
    btns: Vec<G>,
    shadow: bool,
}

fn calc_layout(win: G) -> CalcLayout {
    let i = win.inner();
    let usable = (i.w - 2).max(4);
    let cw = (usable / 4).clamp(1, 9);
    let block_w = cw * 4;
    let ox = i.x + (i.w - block_w + 1) / 2;
    let disp_w = block_w - 1;
    let (rh, shadow) = if i.h >= 13 { (2, true) } else { (1, false) };
    let gap = if i.h >= 8 { 1 } else { 0 };
    let block_h = 2 + gap + 5 * rh;
    let oy = i.y + ((i.h - block_h) / 2).max(0);
    let display = G::new(ox, oy, disp_w, 2);
    let top = oy + 2 + gap;
    let btns = BTNS
        .iter()
        .map(|b| G::new(ox + b.col * cw, top + b.row * rh, (b.span * cw - 1).max(1), 1))
        .collect();
    CalcLayout { display, btns, shadow }
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct RawEntry {
    name: String,
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    modified: String,
}

struct Entry {
    name: String,
    dir: bool,
    size: u64,
    modified: String,
}

struct Files {
    entries: Vec<Entry>,
    sel: usize,
    top: usize,
    vis_h: usize,
}

fn human(n: u64) -> String {
    const K: f64 = 1024.0;
    let f = n as f64;
    if f < K {
        format!("{n} B")
    } else if f < K * K {
        format!("{:.1} KB", f / K)
    } else if f < K * K * K {
        format!("{:.1} MB", f / K / K)
    } else {
        format!("{:.1} GB", f / K / K / K)
    }
}

impl Files {
    fn load() -> Files {
        let raw: Vec<RawEntry> = fs::read_to_string("data/files.json")
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let mut entries: Vec<Entry> = raw
            .into_iter()
            .map(|r| Entry {
                dir: r.kind == "dir" || r.kind == "directory" || r.kind == "folder",
                name: r.name,
                size: r.size,
                modified: r.modified,
            })
            .collect();
        entries.sort_by(|a, b| {
            b.dir
                .cmp(&a.dir)
                .then_with(|| (b.name == "..").cmp(&(a.name == "..")))
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Files { entries, sel: 0, top: 0, vis_h: 8 }
    }
    fn move_sel(&mut self, d: i32) {
        if self.entries.is_empty() {
            return;
        }
        let n = self.entries.len() as i32;
        self.sel = clampi(self.sel as i32 + d, 0, n - 1) as usize;
    }
    fn key(&mut self, k: KeyEvent) {
        let page = self.vis_h.max(1) as i32;
        match k.code {
            KeyCode::Up => self.move_sel(-1),
            KeyCode::Down => self.move_sel(1),
            KeyCode::PageUp => self.move_sel(-page),
            KeyCode::PageDown => self.move_sel(page),
            KeyCode::Home => self.move_sel(-100000),
            KeyCode::End => self.move_sel(100000),
            _ => {}
        }
    }
}

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Act {
    About,
    Reset,
    Open(Kind),
    Quit,
    Tile,
    Cascade,
    Next,
    Zoom,
    Close,
}

struct MItem {
    label: &'static str,
    key: &'static str,
    act: Option<Act>,
}

const fn mi(label: &'static str, key: &'static str, act: Act) -> MItem {
    MItem { label, key, act: Some(act) }
}
const SEP: MItem = MItem { label: "", key: "", act: None };

const MENU_TITLES: [&str; 4] = ["≡", "File", "Window", "Help"];

fn menu_items(i: usize) -> Vec<MItem> {
    match i {
        0 => vec![mi("About…", "", Act::About), SEP, mi("Reset desktop", "", Act::Reset)],
        1 => vec![
            mi("Notes", "", Act::Open(Kind::Notes)),
            mi("Calculator", "", Act::Open(Kind::Calc)),
            mi("Files", "", Act::Open(Kind::Files)),
            SEP,
            mi("Exit", "Ctrl+Q", Act::Quit),
        ],
        2 => vec![
            mi("Tile", "", Act::Tile),
            mi("Cascade", "", Act::Cascade),
            SEP,
            mi("Next", "F6", Act::Next),
            mi("Zoom", "F5", Act::Zoom),
            mi("Close", "Ctrl+W", Act::Close),
        ],
        _ => vec![mi("About…", "", Act::About)],
    }
}

fn menu_title_rect(i: usize) -> (i32, i32) {
    let mut x = 1;
    for (k, t) in MENU_TITLES.iter().enumerate() {
        let w = chars_len(t) + 2;
        if k == i {
            return (x, w);
        }
        x += w;
    }
    (x, 0)
}

struct MenuState {
    menu: usize,
    item: Option<usize>,
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

enum Drag {
    Move { kind: Kind, mx: i32, my: i32, start: G },
    Resize { kind: Kind },
}

struct App {
    w: i32,
    h: i32,
    stack: Vec<Win>,
    notes: Notes,
    calc: Calc,
    files: Files,
    menu: Option<MenuState>,
    about: bool,
    drag: Option<Drag>,
    last_title_click: Option<(Instant, Kind)>,
    calc_pressed: Option<usize>,
    quit: bool,
}

impl App {
    fn new(w: i32, h: i32) -> App {
        let mut app = App {
            w,
            h,
            stack: Vec::new(),
            notes: Notes::load(),
            calc: Calc::new(),
            files: Files::load(),
            menu: None,
            about: false,
            drag: None,
            last_title_click: None,
            calc_pressed: None,
            quit: false,
        };
        app.reset_windows();
        app
    }

    fn reset_windows(&mut self) {
        self.stack = KINDS
            .iter()
            .map(|&k| {
                let g = k.default_geom();
                Win { kind: k, g, pref: g, restore: None }
            })
            .collect();
        self.refit();
    }

    fn desk(&self) -> G {
        G::new(0, 1, self.w.max(0), (self.h - 2).max(0))
    }

    fn fit(&self, g: G) -> G {
        let d = self.desk();
        let w = g.w.min(d.w).max(1);
        let h = g.h.min(d.h).max(1);
        let x = clampi(g.x, 0, d.w - w);
        let y = clampi(g.y, d.y, d.y + d.h - h);
        G::new(x, y, w, h)
    }

    fn refit(&mut self) {
        let d = self.desk();
        for i in 0..self.stack.len() {
            let win = self.stack[i];
            self.stack[i].g = if win.restore.is_some() { d } else { self.fit(win.pref) };
        }
    }

    fn resize(&mut self, w: i32, h: i32) {
        if w == self.w && h == self.h {
            return;
        }
        self.w = w;
        self.h = h;
        self.drag = None;
        self.refit();
    }

    /// Keep a moved window's title bar reachable.
    fn clamp_move(&self, g: G) -> G {
        let keep = g.w.min(6);
        let x = clampi(g.x, keep - g.w, self.w - keep);
        let y = clampi(g.y, 1, (self.h - 2).max(1));
        G::new(x, y, g.w, g.h)
    }

    fn idx(&self, k: Kind) -> Option<usize> {
        self.stack.iter().position(|w| w.kind == k)
    }

    fn top_kind(&self) -> Option<Kind> {
        self.stack.last().map(|w| w.kind)
    }

    fn raise(&mut self, k: Kind) {
        if let Some(i) = self.idx(k) {
            let w = self.stack.remove(i);
            self.stack.push(w);
        }
    }

    fn close(&mut self, k: Kind) {
        if let Some(i) = self.idx(k) {
            self.stack.remove(i);
        }
        if matches!(self.drag, Some(Drag::Move { kind, .. }) | Some(Drag::Resize { kind }) if kind == k) {
            self.drag = None;
        }
        if k == Kind::Calc {
            self.calc_pressed = None;
        }
    }

    fn toggle_max(&mut self, k: Kind) {
        let d = self.desk();
        if let Some(i) = self.idx(k) {
            let win = self.stack[i];
            if let Some(r) = win.restore {
                let g = self.fit(r);
                let w = &mut self.stack[i];
                w.g = g;
                w.pref = g;
                w.restore = None;
            } else {
                let w = &mut self.stack[i];
                w.restore = Some(w.g);
                w.g = d;
            }
        }
    }

    fn next_window(&mut self) {
        if self.stack.len() > 1 {
            let w = self.stack.remove(0);
            self.stack.push(w);
        }
    }

    fn open(&mut self, k: Kind) {
        if self.idx(k).is_some() {
            self.raise(k);
        } else {
            let pref = k.default_geom();
            let g = self.fit(pref);
            self.stack.push(Win { kind: k, g, pref, restore: None });
        }
    }

    fn ordered_kinds(&self) -> Vec<Kind> {
        KINDS.iter().copied().filter(|k| self.idx(*k).is_some()).collect()
    }

    fn tile(&mut self) {
        let kinds = self.ordered_kinds();
        let n = kinds.len() as i32;
        if n == 0 {
            return;
        }
        let d = self.desk();
        let cols = ((n as f64).sqrt().ceil() as i32).max(1);
        let base = n / cols;
        let extra = n % cols;
        let mut k = 0usize;
        for c in 0..cols {
            // later columns take the extra windows
            let rows = base + if c >= cols - extra { 1 } else { 0 };
            if rows == 0 {
                continue;
            }
            let x0 = d.x + d.w * c / cols;
            let x1 = d.x + d.w * (c + 1) / cols;
            for r in 0..rows {
                let y0 = d.y + d.h * r / rows;
                let y1 = d.y + d.h * (r + 1) / rows;
                let g = G::new(x0, y0, (x1 - x0).max(1), (y1 - y0).max(1));
                if let Some(i) = self.idx(kinds[k]) {
                    let w = &mut self.stack[i];
                    w.g = g;
                    w.pref = g;
                    w.restore = None;
                }
                k += 1;
            }
        }
    }

    fn cascade(&mut self) {
        let n = self.stack.len() as i32;
        if n == 0 {
            return;
        }
        let d = self.desk();
        let step_x = 3;
        let step_y = 1;
        let w = (d.w - step_x * (n - 1) - 2).max(MIN_W.min(d.w));
        let h = (d.h - step_y * (n - 1) - 1).max(MIN_H.min(d.h));
        for i in 0..self.stack.len() {
            let g = self.fit(G::new(d.x + step_x * i as i32, d.y + step_y * i as i32, w, h));
            let win = &mut self.stack[i];
            win.g = g;
            win.pref = g;
            win.restore = None;
        }
    }

    fn run_act(&mut self, a: Act) {
        self.menu = None;
        match a {
            Act::About => self.about = true,
            Act::Reset => self.reset_windows(),
            Act::Open(k) => self.open(k),
            Act::Quit => self.quit = true,
            Act::Tile => self.tile(),
            Act::Cascade => self.cascade(),
            Act::Next => self.next_window(),
            Act::Zoom => {
                if let Some(k) = self.top_kind() {
                    self.toggle_max(k)
                }
            }
            Act::Close => {
                if let Some(k) = self.top_kind() {
                    self.close(k)
                }
            }
        }
    }

    // ---------------- menu helpers ----------------

    fn item_enabled(&self, it: &MItem) -> bool {
        match it.act {
            None => false,
            Some(Act::Tile | Act::Cascade | Act::Next | Act::Zoom | Act::Close) => !self.stack.is_empty(),
            Some(_) => true,
        }
    }

    fn first_enabled(&self, menu: usize) -> Option<usize> {
        menu_items(menu).iter().position(|it| self.item_enabled(it))
    }

    fn open_menu(&mut self, m: usize) {
        self.menu = Some(MenuState { menu: m, item: self.first_enabled(m) });
    }

    fn dropdown_geom(&self, m: usize) -> G {
        let items = menu_items(m);
        let mut iw = 0;
        for it in &items {
            let mut l = chars_len(it.label);
            if !it.key.is_empty() {
                l += 3 + chars_len(it.key);
            }
            iw = iw.max(l);
        }
        let w = iw.max(10) + 4;
        let h = items.len() as i32 + 2;
        let (tx, _) = menu_title_rect(m);
        let x = clampi(tx - 1, 0, self.w - w - 2);
        G::new(x, 1, w, h)
    }

    fn menu_key(&mut self, k: KeyEvent) {
        let Some(ms) = self.menu.as_ref() else { return };
        let m = ms.menu;
        let cur = ms.item;
        let items = menu_items(m);
        let n = MENU_TITLES.len();
        match k.code {
            KeyCode::Esc | KeyCode::F(10) => self.menu = None,
            KeyCode::Left => self.open_menu((m + n - 1) % n),
            KeyCode::Right => self.open_menu((m + 1) % n),
            KeyCode::Up | KeyCode::Down => {
                let dir: i32 = if k.code == KeyCode::Up { -1 } else { 1 };
                let len = items.len() as i32;
                let mut i = cur.map(|c| c as i32).unwrap_or(if dir > 0 { -1 } else { len });
                for _ in 0..len {
                    i = (i + dir).rem_euclid(len);
                    if self.item_enabled(&items[i as usize]) {
                        if let Some(ms) = self.menu.as_mut() {
                            ms.item = Some(i as usize);
                        }
                        break;
                    }
                }
            }
            KeyCode::Home => {
                let f = self.first_enabled(m);
                if let Some(ms) = self.menu.as_mut() {
                    ms.item = f;
                }
            }
            KeyCode::End => {
                let l = items.iter().rposition(|it| self.item_enabled(it));
                if let Some(ms) = self.menu.as_mut() {
                    ms.item = l;
                }
            }
            KeyCode::Enter | KeyCode::Char(' ') => {
                if let Some(i) = cur {
                    if let Some(a) = items[i].act {
                        if self.item_enabled(&items[i]) {
                            self.run_act(a);
                        }
                    }
                }
            }
            KeyCode::Char(c) => {
                let c = c.to_ascii_lowercase();
                if let Some(i) = items.iter().position(|it| {
                    self.item_enabled(it) && it.label.chars().next().map(|f| f.to_ascii_lowercase()) == Some(c)
                }) {
                    if let Some(a) = items[i].act {
                        self.run_act(a);
                    }
                }
            }
            _ => {}
        }
    }

    // ---------------- events ----------------

    fn handle(&mut self, ev: Event) {
        match ev {
            Event::Key(k) if k.kind != KeyEventKind::Release => self.key(k),
            Event::Mouse(m) => self.mouse(m),
            Event::Resize(w, h) => self.resize(w as i32, h as i32),
            _ => {}
        }
    }

    fn key(&mut self, k: KeyEvent) {
        let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
        let alt = k.modifiers.contains(KeyModifiers::ALT);
        if ctrl && matches!(k.code, KeyCode::Char('q') | KeyCode::Char('Q')) {
            self.quit = true;
            return;
        }
        if self.about {
            if matches!(k.code, KeyCode::Enter | KeyCode::Esc | KeyCode::Char(' ')) {
                self.about = false;
            }
            return;
        }
        if self.menu.is_some() {
            self.menu_key(k);
            return;
        }
        if alt {
            match k.code {
                KeyCode::Char('f') | KeyCode::Char('F') => return self.open_menu(1),
                KeyCode::Char('w') | KeyCode::Char('W') => return self.open_menu(2),
                KeyCode::Char('h') | KeyCode::Char('H') => return self.open_menu(3),
                KeyCode::Char(' ') => return self.open_menu(0),
                _ => {}
            }
        }
        match k.code {
            KeyCode::F(10) => return self.open_menu(0),
            KeyCode::F(5) => return self.run_act(Act::Zoom),
            KeyCode::F(6) => return self.run_act(Act::Next),
            KeyCode::Char('w') | KeyCode::Char('W') if ctrl => return self.run_act(Act::Close),
            _ => {}
        }
        match self.top_kind() {
            Some(Kind::Notes) => self.notes.key(k),
            Some(Kind::Files) => self.files.key(k),
            Some(Kind::Calc) => {
                if ctrl || alt {
                    return;
                }
                let ck = match k.code {
                    KeyCode::Char(c @ '0'..='9') => Some(CK::Digit(c as u8 - b'0')),
                    KeyCode::Char('.') | KeyCode::Char(',') => Some(CK::Dot),
                    KeyCode::Char('+') => Some(CK::Op('+')),
                    KeyCode::Char('-') => Some(CK::Op('−')),
                    KeyCode::Char('*') | KeyCode::Char('x') | KeyCode::Char('X') => Some(CK::Op('×')),
                    KeyCode::Char('/') => Some(CK::Op('÷')),
                    KeyCode::Char('=') | KeyCode::Enter => Some(CK::Eq),
                    KeyCode::Char('c') | KeyCode::Char('C') | KeyCode::Esc | KeyCode::Delete => Some(CK::Clear),
                    KeyCode::Backspace => Some(CK::Back),
                    KeyCode::Char('n') | KeyCode::Char('_') => Some(CK::Neg),
                    _ => None,
                };
                if let Some(ck) = ck {
                    self.calc.press(ck);
                }
            }
            None => {}
        }
    }

    fn window_at(&self, x: i32, y: i32) -> Option<usize> {
        let d = self.desk();
        if !d.contains(x, y) {
            return None;
        }
        self.stack.iter().rposition(|w| w.g.contains(x, y))
    }

    fn taskbar_entries(&self) -> Vec<(Kind, i32, i32)> {
        let mut x = 1;
        let mut v = Vec::new();
        for k in self.ordered_kinds() {
            let w = chars_len(k.title()) + 4;
            v.push((k, x, w));
            x += w + 1;
        }
        v
    }

    fn about_geom(&self) -> (G, G) {
        let w = 46.min(self.w);
        let h = 12.min((self.h - 2).max(3));
        let x = (self.w - w) / 2;
        let y = 1 + ((self.h - 2) - h).max(0) / 2;
        let g = G::new(x, y, w, h);
        let ok = G::new(x + (w - 8) / 2, y + h - 3, 8, 1);
        (g, ok)
    }

    fn mouse(&mut self, m: MouseEvent) {
        let (mx, my) = (m.column as i32, m.row as i32);
        match m.kind {
            MouseEventKind::Down(MouseButton::Left) => self.mouse_down(mx, my),
            MouseEventKind::Drag(MouseButton::Left) => self.mouse_drag(mx, my),
            MouseEventKind::Up(_) => {
                self.drag = None;
                self.calc_pressed = None;
            }
            MouseEventKind::Moved => {
                if let Some(ms) = &self.menu {
                    let mi = ms.menu;
                    let g = self.dropdown_geom(mi);
                    if g.contains(mx, my) && my > g.y && my < g.y + g.h - 1 {
                        let i = (my - g.y - 1) as usize;
                        let items = menu_items(mi);
                        if i < items.len() && self.item_enabled(&items[i]) {
                            self.menu.as_mut().unwrap().item = Some(i);
                        }
                    }
                }
            }
            MouseEventKind::ScrollUp | MouseEventKind::ScrollDown => {
                if self.about || self.menu.is_some() {
                    return;
                }
                let d = if matches!(m.kind, MouseEventKind::ScrollUp) { -1 } else { 1 };
                if let Some(i) = self.window_at(mx, my) {
                    match self.stack[i].kind {
                        Kind::Files => self.files.move_sel(d),
                        Kind::Notes => self.notes.scroll(d),
                        Kind::Calc => {}
                    }
                }
            }
            _ => {}
        }
    }

    fn mouse_down(&mut self, mx: i32, my: i32) {
        if self.about {
            let (_, ok) = self.about_geom();
            if ok.contains(mx, my) {
                self.about = false;
            }
            return;
        }
        if let Some(ms) = &self.menu {
            let cur = ms.menu;
            if my == 0 {
                for i in 0..MENU_TITLES.len() {
                    let (x, w) = menu_title_rect(i);
                    if mx >= x && mx < x + w {
                        if i == cur {
                            self.menu = None;
                        } else {
                            self.open_menu(i);
                        }
                        return;
                    }
                }
            }
            let g = self.dropdown_geom(cur);
            if g.contains(mx, my) {
                if my > g.y && my < g.y + g.h - 1 {
                    let i = (my - g.y - 1) as usize;
                    let items = menu_items(cur);
                    if i < items.len() && self.item_enabled(&items[i]) {
                        if let Some(a) = items[i].act {
                            self.run_act(a);
                        }
                    }
                }
                return;
            }
            self.menu = None;
            return;
        }
        if my == 0 {
            for i in 0..MENU_TITLES.len() {
                let (x, w) = menu_title_rect(i);
                if mx >= x && mx < x + w {
                    self.open_menu(i);
                    return;
                }
            }
            return;
        }
        if my == self.h - 1 {
            for (k, x, w) in self.taskbar_entries() {
                if mx >= x && mx < x + w {
                    self.raise(k);
                    return;
                }
            }
            return;
        }
        let Some(i) = self.window_at(mx, my) else { return };
        let kind = self.stack[i].kind;
        self.raise(kind);
        let g = self.stack.last().unwrap().g;
        if my == g.y {
            if mx >= g.x + 1 && mx <= g.x + 3 {
                self.close(kind);
                self.last_title_click = None;
                return;
            }
            if mx >= g.x + g.w - 4 && mx <= g.x + g.w - 2 {
                self.toggle_max(kind);
                self.last_title_click = None;
                return;
            }
            let now = Instant::now();
            if let Some((t, k)) = self.last_title_click {
                if k == kind && now.duration_since(t) < Duration::from_millis(500) {
                    self.toggle_max(kind);
                    self.last_title_click = None;
                    return;
                }
            }
            self.last_title_click = Some((now, kind));
            self.drag = Some(Drag::Move { kind, mx, my, start: g });
            return;
        }
        self.last_title_click = None;
        if mx == g.x + g.w - 1 && my == g.y + g.h - 1 {
            self.drag = Some(Drag::Resize { kind });
            return;
        }
        let inner = g.inner();
        if !inner.contains(mx, my) {
            return;
        }
        match kind {
            Kind::Notes => {
                let n = &mut self.notes;
                let r = (n.top as i32 + (my - inner.y)).max(0) as usize;
                n.row = r.min(n.lines.len() - 1);
                let c = (n.left as i32 + (mx - inner.x - 1)).max(0) as usize;
                n.col = c.min(n.lines[n.row].len());
                n.want = n.col;
            }
            Kind::Files => {
                let row = my - inner.y - 2;
                if row >= 0 {
                    let idx = self.files.top + row as usize;
                    if idx < self.files.entries.len() {
                        self.files.sel = idx;
                    }
                }
            }
            Kind::Calc => {
                let lay = calc_layout(g);
                for (bi, b) in lay.btns.iter().enumerate() {
                    if b.contains(mx, my) && b.y < inner.y + inner.h {
                        self.calc_pressed = Some(bi);
                        self.calc.press(BTNS[bi].key);
                        break;
                    }
                }
            }
        }
    }

    fn mouse_drag(&mut self, mx: i32, my: i32) {
        let Some(drag) = &self.drag else { return };
        match *drag {
            Drag::Move { kind, mx: sx, my: sy, start } => {
                let (dx, dy) = (mx - sx, my - sy);
                let g = self.clamp_move(G::new(start.x + dx, start.y + dy, start.w, start.h));
                if let Some(i) = self.idx(kind) {
                    let w = &mut self.stack[i];
                    if g != w.g {
                        w.g = g;
                        w.pref = g;
                        w.restore = None;
                    }
                }
            }
            Drag::Resize { kind } => {
                if let Some(i) = self.idx(kind) {
                    let g0 = self.stack[i].g;
                    let max_h = (self.h - 1 - g0.y).max(MIN_H);
                    let nw = (mx - g0.x + 1).max(MIN_W);
                    let nh = (my - g0.y + 1).max(MIN_H).min(max_h);
                    let g = G::new(g0.x, g0.y, nw, nh);
                    let w = &mut self.stack[i];
                    if g != w.g {
                        w.g = g;
                        w.pref = g;
                        w.restore = None;
                    }
                }
            }
        }
    }

    // ---------------- rendering ----------------

    fn render(&mut self, f: &mut Frame) {
        let a = f.area();
        self.resize(a.width as i32, a.height as i32);
        let screen = G::new(0, 0, self.w, self.h);
        let desk = self.desk();
        let buf = f.buffer_mut();
        let mut c = Canvas { buf, clip: screen };

        // desktop pattern
        c.fill(desk, '░', st(DESK_FG, DESK_BG));

        // windows bottom to top
        let n = self.stack.len();
        for i in 0..n {
            let win = self.stack[i];
            let focused = i + 1 == n;
            c.clip = desk;
            c.shadow(win.g);
            self.draw_window(&mut c, win, focused);
            if !focused {
                c.clip = desk;
                c.modify(win.g, |cell| {
                    cell.fg = mix(cell.fg, DESK_BG, 0.38);
                    cell.bg = mix(cell.bg, DESK_BG, 0.30);
                    cell.modifier.remove(Modifier::BOLD);
                });
            }
        }
        if n == 0 && desk.h > 2 {
            c.clip = desk;
            let msg = "No open windows — press F10 and choose File to reopen one";
            let msg = truncate(msg, desk.w - 2);
            let x = (self.w - chars_len(&msg)) / 2;
            c.text(x, desk.y + desk.h / 2, &msg, st(rgb(120, 136, 180), DESK_BG));
        }

        c.clip = screen;
        self.draw_menubar(&mut c);
        self.draw_taskbar(&mut c);
        if let Some(ms) = &self.menu {
            self.draw_dropdown(&mut c, ms.menu, ms.item);
        }
        if self.about {
            c.modify(screen, |cell| {
                cell.fg = scale(cell.fg, 0.55);
                cell.bg = scale(cell.bg, 0.55);
            });
            self.draw_about(&mut c);
        }
    }

    fn draw_frame(&self, c: &mut Canvas, g: G, focused: bool, pal: Pal, title: &str, maxed: bool, buttons: bool) {
        let (hz, vt, tl, tr, bl, br) = if focused {
            ('═', '║', '╔', '╗', '╚', '╝')
        } else {
            ('─', '│', '┌', '┐', '└', '┘')
        };
        let fc = if focused { pal.frame_on } else { pal.frame_off };
        let fs = st(fc, pal.bg);
        for xx in g.x + 1..g.x + g.w - 1 {
            c.put(xx, g.y, hz, fs);
            c.put(xx, g.y + g.h - 1, hz, fs);
        }
        for yy in g.y + 1..g.y + g.h - 1 {
            c.put(g.x, yy, vt, fs);
            c.put(g.x + g.w - 1, yy, vt, fs);
        }
        c.put(g.x, g.y, tl, fs);
        c.put(g.x + g.w - 1, g.y, tr, fs);
        c.put(g.x, g.y + g.h - 1, bl, fs);
        c.put(g.x + g.w - 1, g.y + g.h - 1, br, fs);
        if buttons && g.w >= 10 {
            let bs = st(pal.btn, pal.bg).add_modifier(Modifier::BOLD);
            c.put(g.x + 1, g.y, '[', fs);
            c.put(g.x + 2, g.y, '×', bs);
            c.put(g.x + 3, g.y, ']', fs);
            c.put(g.x + g.w - 4, g.y, '[', fs);
            c.put(g.x + g.w - 3, g.y, if maxed { '↕' } else { '↑' }, bs);
            c.put(g.x + g.w - 2, g.y, ']', fs);
            if focused {
                c.put(g.x + g.w - 1, g.y + g.h - 1, '◢', st(pal.btn, pal.bg));
            }
        }
        let avail = if buttons { g.w - 12 } else { g.w - 4 };
        let t = truncate(title, avail - 2);
        if !t.is_empty() {
            let t = format!(" {t} ");
            let tw = chars_len(&t);
            let tx = g.x + (g.w - tw) / 2;
            let ts = if focused {
                st(pal.title_on, pal.bg).add_modifier(Modifier::BOLD)
            } else {
                st(pal.title_off, pal.bg)
            };
            c.text(tx, g.y, &t, ts);
        }
    }

    fn vscroll(c: &mut Canvas, x: i32, y: i32, h: i32, total: usize, top: usize, vis: usize, pal: Pal, focused: bool) {
        if h < 3 || total <= vis || vis == 0 {
            return;
        }
        let fc = if focused { pal.frame_on } else { pal.frame_off };
        let s = st(fc, pal.bg);
        c.put(x, y, '▲', s);
        c.put(x, y + h - 1, '▼', s);
        let track = h - 2;
        for i in 0..track {
            c.put(x, y + 1 + i, '░', s);
        }
        let max_top = (total - vis).max(1);
        let pos = ((top as f64 / max_top as f64) * (track - 1) as f64).round() as i32;
        c.put(x, y + 1 + clampi(pos, 0, track - 1), '■', s);
    }

    fn draw_window(&mut self, c: &mut Canvas, win: Win, focused: bool) {
        let g = win.g;
        let pal = win.kind.pal();
        let desk = self.desk();
        c.clip = desk;
        c.fill(g, ' ', st(pal.text, pal.bg));
        self.draw_frame(c, g, focused, pal, win.kind.title(), win.restore.is_some(), true);
        let inner = g.inner();
        match win.kind {
            Kind::Notes => self.draw_notes(c, g, inner, focused, pal),
            Kind::Calc => self.draw_calc(c, g, inner, focused, pal),
            Kind::Files => self.draw_files(c, g, inner, focused, pal),
        }
    }

    fn draw_notes(&mut self, c: &mut Canvas, g: G, inner: G, focused: bool, pal: Pal) {
        let desk = self.desk();
        let n = &mut self.notes;
        let vis_h = inner.h.max(1) as usize;
        let text_w = (inner.w - 2).max(1) as usize;
        n.vis_h = vis_h;
        if n.row < n.top {
            n.top = n.row;
        }
        if n.row >= n.top + vis_h {
            n.top = n.row + 1 - vis_h;
        }
        let max_top = n.lines.len().saturating_sub(vis_h);
        n.top = n.top.min(max_top.max(n.row.saturating_sub(vis_h - 1)));
        let col = n.col.min(n.lines[n.row].len());
        if col < n.left {
            n.left = col;
        }
        if col >= n.left + text_w {
            n.left = col + 1 - text_w;
        }
        c.clip = inner.intersect(&desk);
        let ts = st(pal.text, pal.bg);
        for r in 0..vis_h {
            let li = n.top + r;
            if li >= n.lines.len() {
                break;
            }
            let y = inner.y + r as i32;
            let line = &n.lines[li];
            for (k, ch) in line.iter().skip(n.left).take(text_w).enumerate() {
                // headings (lines without a leading "- ") get a highlight
                let s = if !line.is_empty() && line[0] != '-' && line[0] != ' ' {
                    st(rgb(255, 236, 140), pal.bg).add_modifier(Modifier::BOLD)
                } else {
                    ts
                };
                c.put(inner.x + 1 + k as i32, y, *ch, s);
            }
        }
        if focused {
            let cy = inner.y + (n.row - n.top) as i32;
            let cx = inner.x + 1 + (col - n.left) as i32;
            let ch = n.lines[n.row].get(col).copied().unwrap_or(' ');
            c.put(cx, cy, ch, st(rgb(10, 20, 60), rgb(255, 214, 90)));
        }
        // frame decorations
        c.clip = desk;
        let fc = if focused { pal.frame_on } else { pal.frame_off };
        let pos = format!(" {}:{} ", n.row + 1, col + 1);
        if g.w > chars_len(&pos) + 8 {
            let s = if focused { st(rgb(255, 236, 140), pal.bg) } else { st(fc, pal.bg) };
            c.text(g.x + 3, g.y + g.h - 1, &pos, s);
            if n.modified && g.w > chars_len(&pos) + 16 {
                c.text(g.x + 3 + chars_len(&pos), g.y + g.h - 1, "• edited ", st(fc, pal.bg));
            }
        }
        let (total, top) = (n.lines.len(), n.top);
        App::vscroll(c, g.x + g.w - 1, inner.y, inner.h, total, top, vis_h, pal, focused);
    }

    fn draw_calc(&mut self, c: &mut Canvas, g: G, inner: G, _focused: bool, pal: Pal) {
        let desk = self.desk();
        c.clip = inner.intersect(&desk);
        let lay = calc_layout(g);
        let d = lay.display;
        let lcd_bg = rgb(22, 34, 30);
        let lcd_fg = rgb(140, 255, 170);
        let lcd_dim = rgb(80, 150, 104);
        c.fill(G::new(d.x, d.y, d.w, 2), ' ', st(lcd_fg, lcd_bg));
        let expr = truncate(&self.calc.expr, d.w - 2);
        c.text(d.x + d.w - 1 - chars_len(&expr), d.y, &expr, st(lcd_dim, lcd_bg));
        let mut val = self.calc.entry.clone();
        let maxw = d.w - 2;
        if chars_len(&val) > maxw && maxw > 1 {
            let skip = (chars_len(&val) - maxw + 1) as usize;
            val = format!("…{}", val.chars().skip(skip).collect::<String>());
        }
        c.text(
            d.x + d.w - 1 - chars_len(&val),
            d.y + 1,
            &val,
            st(lcd_fg, lcd_bg).add_modifier(Modifier::BOLD),
        );
        if let Some(op) = self.calc.op {
            c.put(d.x + 1, d.y + 1, op, st(lcd_dim, lcd_bg));
        }
        for (bi, b) in lay.btns.iter().enumerate() {
            let spec = &BTNS[bi];
            let (bg, fg) = match spec.key {
                CK::Digit(_) | CK::Dot => (rgb(236, 236, 240), rgb(20, 20, 28)),
                CK::Op(_) => (rgb(42, 96, 176), WHITE),
                CK::Eq => (rgb(232, 150, 30), BLACK),
                CK::Clear => (rgb(186, 52, 52), WHITE),
                CK::Back | CK::Neg => (rgb(110, 112, 128), WHITE),
            };
            let pressed = self.calc_pressed == Some(bi);
            let bx = if pressed && lay.shadow { b.x + 1 } else { b.x };
            let s = st(fg, bg).add_modifier(Modifier::BOLD);
            let s = if pressed { st(fg, scale(bg, 0.75)).add_modifier(Modifier::BOLD) } else { s };
            c.fill(G::new(bx, b.y, b.w, 1), ' ', s);
            let lx = bx + (b.w - chars_len(spec.label)) / 2;
            c.text(lx, b.y, spec.label, s);
            if lay.shadow && !pressed {
                let ss = st(rgb(40, 40, 46), pal.bg);
                c.put(b.x + b.w, b.y, '▄', ss);
                for xx in b.x + 1..=b.x + b.w {
                    c.put(xx, b.y + 1, '▀', ss);
                }
            }
        }
    }

    fn draw_files(&mut self, c: &mut Canvas, g: G, inner: G, focused: bool, pal: Pal) {
        let desk = self.desk();
        let fs = &mut self.files;
        c.clip = inner.intersect(&desk);
        let date_w = 16;
        let size_w = 9;
        let mut show_date = true;
        let mut show_size = true;
        let mut name_w = inner.w - 2 - size_w - 2 - date_w - 1;
        if name_w < 10 {
            show_date = false;
            name_w = inner.w - 2 - size_w - 1;
        }
        if name_w < 8 {
            show_size = false;
            name_w = inner.w - 2;
        }
        let x0 = inner.x + 1;
        let size_x = x0 + name_w + 1;
        let date_x = size_x + size_w + 2;
        let hs = st(rgb(255, 236, 120), pal.bg).add_modifier(Modifier::BOLD);
        c.text(x0 + 2, inner.y, "Name", hs);
        if show_size {
            c.text(size_x + size_w - 4, inner.y, "Size", hs);
        }
        if show_date {
            c.text(date_x, inner.y, "Modified", hs);
        }
        let sep = st(rgb(70, 150, 160), pal.bg);
        for xx in inner.x..inner.x + inner.w {
            c.put(xx, inner.y + 1, '─', sep);
        }
        let vis = (inner.h - 2).max(0) as usize;
        fs.vis_h = vis.max(1);
        if fs.sel < fs.top {
            fs.top = fs.sel;
        }
        if vis > 0 && fs.sel >= fs.top + vis {
            fs.top = fs.sel + 1 - vis;
        }
        let max_top = fs.entries.len().saturating_sub(vis.max(1));
        fs.top = fs.top.min(max_top);
        for r in 0..vis {
            let i = fs.top + r;
            if i >= fs.entries.len() {
                break;
            }
            let e = &fs.entries[i];
            let y = inner.y + 2 + r as i32;
            let selected = i == fs.sel;
            let (bg, fg_name, fg_meta, fg_mark) = if selected && focused {
                (rgb(80, 220, 210), BLACK, rgb(10, 50, 56), rgb(0, 0, 0))
            } else if selected {
                (rgb(0, 70, 82), WHITE, rgb(170, 210, 214), rgb(255, 220, 100))
            } else if e.dir {
                (pal.bg, WHITE, rgb(150, 200, 206), rgb(255, 220, 100))
            } else {
                (pal.bg, pal.text, rgb(150, 200, 206), rgb(110, 170, 178))
            };
            c.fill(G::new(inner.x, y, inner.w, 1), ' ', st(fg_name, bg));
            let mark = if e.dir { '▸' } else { '·' };
            c.put(x0, y, mark, st(fg_mark, bg).add_modifier(Modifier::BOLD));
            let label = if e.dir && e.name != ".." { format!("{}/", e.name) } else { e.name.clone() };
            let label = truncate(&label, name_w - 2);
            let ns = if e.dir { st(fg_name, bg).add_modifier(Modifier::BOLD) } else { st(fg_name, bg) };
            c.text(x0 + 2, y, &label, ns);
            if show_size {
                let s = if e.name == ".." {
                    "<UP>".to_string()
                } else if e.dir {
                    "<DIR>".to_string()
                } else {
                    human(e.size)
                };
                c.text(size_x + size_w - chars_len(&s), y, &s, st(fg_meta, bg));
            }
            if show_date {
                let dt = truncate(&e.modified, date_w);
                c.text(date_x, y, &dt, st(fg_meta, bg));
            }
        }
        // footer in the bottom border
        c.clip = desk;
        let dirs = fs.entries.iter().filter(|e| e.dir && e.name != "..").count();
        let files = fs.entries.iter().filter(|e| !e.dir).count();
        let total: u64 = fs.entries.iter().filter(|e| !e.dir).map(|e| e.size).sum();
        let fc = if focused { pal.frame_on } else { pal.frame_off };
        let long = format!(" {dirs} folders · {files} files · {} ", human(total));
        let short = format!(" {}/{} ", fs.sel + 1, fs.entries.len());
        let foot = if chars_len(&long) + 8 <= g.w { long } else { short };
        if chars_len(&foot) + 6 <= g.w {
            c.text(g.x + 3, g.y + g.h - 1, &foot, st(fc, pal.bg));
        }
        let (total_n, top) = (fs.entries.len(), fs.top);
        App::vscroll(c, g.x + g.w - 1, inner.y + 2, inner.h - 2, total_n, top, vis, pal, focused);
    }

    fn draw_menubar(&self, c: &mut Canvas) {
        if self.h < 1 {
            return;
        }
        let bar = G::new(0, 0, self.w, 1);
        c.fill(bar, ' ', st(BAR_FG, BAR_BG));
        let open = self.menu.as_ref().map(|m| m.menu);
        for (i, t) in MENU_TITLES.iter().enumerate() {
            let (x, w) = menu_title_rect(i);
            let active = open == Some(i);
            let (fg, bg) = if active { (ACCENT_FG, ACCENT) } else { (BAR_FG, BAR_BG) };
            c.fill(G::new(x, 0, w, 1), ' ', st(fg, bg));
            for (k, ch) in t.chars().enumerate() {
                let s = if k == 0 && i != 0 && !active {
                    st(BAR_HOT, bg)
                } else if k == 0 && i != 0 {
                    st(rgb(255, 240, 150), bg)
                } else {
                    st(fg, bg)
                };
                let s = if i == 0 { s.add_modifier(Modifier::BOLD) } else { s };
                c.put(x + 1 + k as i32, 0, ch, s);
            }
        }
        let clock = " 10:42 ";
        let cx = self.w - chars_len(clock);
        if cx > 26 {
            c.text(cx, 0, clock, st(BAR_FG, BAR_BG).add_modifier(Modifier::BOLD));
            let title = "Text-Mode Desktop";
            let tx = cx - chars_len(title) - 2;
            let (_, lw) = menu_title_rect(3);
            let (lx, _) = menu_title_rect(3);
            if tx > lx + lw + 4 {
                c.text(tx, 0, title, st(BAR_DIM, BAR_BG));
                c.put(cx - 1, 0, '│', st(BAR_DIM, BAR_BG));
            }
        } else if self.w >= 6 {
            c.text(self.w - 6, 0, "10:42 ", st(BAR_FG, BAR_BG).add_modifier(Modifier::BOLD));
        }
    }

    fn draw_taskbar(&self, c: &mut Canvas) {
        if self.h < 2 {
            return;
        }
        let y = self.h - 1;
        c.fill(G::new(0, y, self.w, 1), ' ', st(BAR_FG, BAR_BG));
        let top = self.top_kind();
        let entries = self.taskbar_entries();
        let mut end = 0;
        for (k, x, w) in &entries {
            let focused = top == Some(*k);
            let maxed = self.idx(*k).map(|i| self.stack[i].restore.is_some()).unwrap_or(false);
            let (fg, bg) = if focused { (ACCENT_FG, ACCENT) } else { (BAR_FG, rgb(170, 172, 182)) };
            let mut s = st(fg, bg);
            if focused {
                s = s.add_modifier(Modifier::BOLD);
            }
            c.fill(G::new(*x, y, *w, 1), ' ', s);
            let mark = if focused { '▶' } else if maxed { '▪' } else { '·' };
            c.put(*x + 1, y, mark, s);
            c.text(*x + 3, y, k.title(), s);
            end = x + w;
        }
        if entries.is_empty() {
            end = 1 + c.text(1, y, "no windows", st(BAR_DIM, BAR_BG));
        }
        let hints: [(&str, &str); 5] = [("F10", "Menu"), ("F5", "Zoom"), ("F6", "Next"), ("^W", "Close"), ("^Q", "Quit")];
        let mut total;
        let mut count = hints.len();
        let widths: Vec<i32> = hints.iter().map(|(k, l)| chars_len(k) + chars_len(l) + 3).collect();
        loop {
            total = widths[..count].iter().sum::<i32>();
            if count == 0 || end + 2 + total <= self.w {
                break;
            }
            count -= 1;
        }
        let mut x = self.w - total;
        for (k, l) in &hints[..count] {
            c.text(x + 1, y, k, st(BAR_HOT, BAR_BG));
            c.text(x + 1 + chars_len(k) + 1, y, l, st(BAR_FG, BAR_BG));
            x += chars_len(k) + chars_len(l) + 3;
        }
    }

    fn draw_dropdown(&self, c: &mut Canvas, m: usize, sel: Option<usize>) {
        let g = self.dropdown_geom(m);
        let items = menu_items(m);
        c.clip = G::new(0, 0, self.w, self.h);
        c.shadow(g);
        c.fill(g, ' ', st(BAR_FG, BAR_BG));
        self.draw_frame(c, g, false, PAL_MENU, "", false, false);
        for (i, it) in items.iter().enumerate() {
            let y = g.y + 1 + i as i32;
            if it.act.is_none() {
                let s = st(PAL_MENU.frame_on, BAR_BG);
                c.put(g.x, y, '├', s);
                for xx in g.x + 1..g.x + g.w - 1 {
                    c.put(xx, y, '─', s);
                }
                c.put(g.x + g.w - 1, y, '┤', s);
                continue;
            }
            let enabled = self.item_enabled(it);
            let active = sel == Some(i) && enabled;
            let (fg, bg) = if active {
                (ACCENT_FG, ACCENT)
            } else if enabled {
                (BAR_FG, BAR_BG)
            } else {
                (BAR_DIM, BAR_BG)
            };
            c.fill(G::new(g.x + 1, y, g.w - 2, 1), ' ', st(fg, bg));
            for (k, ch) in it.label.chars().enumerate() {
                let s = if k == 0 && enabled {
                    st(if active { rgb(255, 240, 150) } else { BAR_HOT }, bg)
                } else {
                    st(fg, bg)
                };
                c.put(g.x + 2 + k as i32, y, ch, s);
            }
            if !it.key.is_empty() {
                let kx = g.x + g.w - 2 - chars_len(it.key);
                c.text(kx, y, it.key, st(if active { fg } else if enabled { rgb(70, 72, 84) } else { BAR_DIM }, bg));
            }
        }
    }

    fn draw_about(&self, c: &mut Canvas) {
        let (g, ok) = self.about_geom();
        c.clip = G::new(0, 0, self.w, self.h);
        c.shadow(g);
        let pal = PAL_CALC;
        c.fill(g, ' ', st(pal.text, pal.bg));
        self.draw_frame(c, g, true, pal, "About", false, false);
        let lines: [(&str, Style); 6] = [
            ("≡ Text-Mode Desktop", st(rgb(20, 40, 120), pal.bg).add_modifier(Modifier::BOLD)),
            ("version 1.0", st(rgb(70, 72, 84), pal.bg)),
            ("", st(pal.text, pal.bg)),
            ("Overlapping windows in the spirit of", st(pal.text, pal.bg)),
            ("Turbo Vision. Built with Rust + ratatui.", st(pal.text, pal.bg)),
            ("", st(pal.text, pal.bg)),
        ];
        c.clip = g.inner();
        for (i, (t, s)) in lines.iter().enumerate() {
            let t = truncate(t, g.w - 4);
            let x = g.x + (g.w - chars_len(&t)) / 2;
            c.text(x, g.y + 2 + i as i32, &t, *s);
        }
        let s = st(BLACK, rgb(0, 170, 100)).add_modifier(Modifier::BOLD);
        c.fill(ok, ' ', s);
        c.text(ok.x + (ok.w - 2) / 2, ok.y, "OK", s);
        let ss = st(rgb(40, 40, 46), pal.bg);
        c.put(ok.x + ok.w, ok.y, '▄', ss);
        for xx in ok.x + 1..=ok.x + ok.w {
            c.put(xx, ok.y + 1, '▀', ss);
        }
    }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

fn main() -> io::Result<()> {
    let mut terminal = ratatui::init();
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = execute!(io::stdout(), DisableMouseCapture);
        prev(info);
    }));
    execute!(io::stdout(), EnableMouseCapture)?;
    let res = run(&mut terminal);
    let _ = execute!(io::stdout(), DisableMouseCapture);
    ratatui::restore();
    res
}

fn run(terminal: &mut DefaultTerminal) -> io::Result<()> {
    let size = terminal.size()?;
    let mut app = App::new(size.width as i32, size.height as i32);
    loop {
        terminal.draw(|f| app.render(f))?;
        let ev = event::read()?;
        app.handle(ev);
        while !app.quit && event::poll(Duration::from_millis(0))? {
            app.handle(event::read()?);
        }
        if app.quit {
            break;
        }
    }
    Ok(())
}
