use std::io::{self, stdout};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::time::{Duration, Instant};

use crossterm::event::{
    self, DisableMouseCapture, EnableMouseCapture, Event, KeyCode, KeyEvent, KeyEventKind,
    KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
};
use crossterm::execute;
use ratatui::buffer::{Buffer, Cell};
use ratatui::style::{Color, Modifier, Style};
use ratatui::Frame;
use serde::Deserialize;

// ---------------------------------------------------------------- theme

const fn rgb(r: u8, g: u8, b: u8) -> Color {
    Color::Rgb(r, g, b)
}

const DESK_BG: Color = rgb(14, 20, 34);
const DESK_FG: Color = rgb(30, 42, 66);
const BAR_BG: Color = rgb(198, 204, 216);
const BAR_FG: Color = rgb(16, 20, 30);
const BAR_SEL: Color = rgb(24, 90, 160);
const TASK_BG: Color = rgb(22, 26, 38);
const TASK_FG: Color = rgb(165, 172, 188);
const ACC: Color = rgb(86, 182, 194);
const WIN_BG: Color = rgb(24, 29, 44);
const WIN_FG: Color = rgb(214, 219, 230);
const SHADOW_BG: Color = rgb(6, 8, 14);
const SHADOW_FG: Color = rgb(26, 32, 46);

fn dim(c: Color, f: f32) -> Color {
    if let Color::Rgb(r, g, b) = c {
        Color::Rgb((r as f32 * f) as u8, (g as f32 * f) as u8, (b as f32 * f) as u8)
    } else {
        c
    }
}
fn adj(c: Color, focused: bool) -> Color {
    if focused { c } else { dim(c, 0.62) }
}

// ---------------------------------------------------------------- geometry & painting

#[derive(Clone, Copy, PartialEq, Debug)]
struct R {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
}
impl R {
    fn new(x: i32, y: i32, w: i32, h: i32) -> R {
        R { x, y, w, h }
    }
    fn contains(&self, px: i32, py: i32) -> bool {
        px >= self.x && py >= self.y && px < self.x + self.w && py < self.y + self.h
    }
    fn intersect(&self, o: &R) -> R {
        let x0 = self.x.max(o.x);
        let y0 = self.y.max(o.y);
        let x1 = (self.x + self.w).min(o.x + o.w);
        let y1 = (self.y + self.h).min(o.y + o.h);
        R { x: x0, y: y0, w: (x1 - x0).max(0), h: (y1 - y0).max(0) }
    }
}

fn put(buf: &mut Buffer, x: i32, y: i32, ch: char, st: Style) {
    let a = buf.area;
    if x < a.x as i32 || y < a.y as i32 || x >= (a.x + a.width) as i32 || y >= (a.y + a.height) as i32 {
        return;
    }
    if let Some(c) = buf.cell_mut((x as u16, y as u16)) {
        let mut n = Cell::default();
        n.set_char(ch);
        n.set_style(st);
        *c = n;
    }
}
fn putc(buf: &mut Buffer, x: i32, y: i32, ch: char, st: Style, clip: R) {
    if clip.contains(x, y) {
        put(buf, x, y, ch, st);
    }
}
fn fill(buf: &mut Buffer, r: R, clip: R, ch: char, st: Style) {
    let r = r.intersect(&clip);
    for y in r.y..r.y + r.h {
        for x in r.x..r.x + r.w {
            put(buf, x, y, ch, st);
        }
    }
}
fn text(buf: &mut Buffer, x: i32, y: i32, s: &str, st: Style, clip: R) {
    for (i, ch) in s.chars().enumerate() {
        putc(buf, x + i as i32, y, ch, st, clip);
    }
}
fn shade(buf: &mut Buffer, r: R, clip: R) {
    let r = r.intersect(&clip);
    let a = buf.area;
    for y in r.y..r.y + r.h {
        for x in r.x..r.x + r.w {
            if x < 0 || y < 0 || x >= a.width as i32 || y >= a.height as i32 {
                continue;
            }
            if let Some(c) = buf.cell_mut((x as u16, y as u16)) {
                c.set_fg(SHADOW_FG);
                c.set_bg(SHADOW_BG);
                c.modifier = Modifier::empty();
            }
        }
    }
}
fn st(fg: Color, bg: Color) -> Style {
    Style::default().fg(fg).bg(bg)
}
fn trunc(s: &str, n: usize) -> String {
    let cnt = s.chars().count();
    if cnt <= n {
        s.to_string()
    } else if n == 0 {
        String::new()
    } else {
        let mut t: String = s.chars().take(n - 1).collect();
        t.push('…');
        t
    }
}

// ---------------------------------------------------------------- content models

#[derive(Clone, Copy, PartialEq, Debug)]
enum Kind {
    Notes,
    Calc,
    Files,
}

struct Notes {
    lines: Vec<Vec<char>>,
    cy: usize,
    cx: usize,
    sy: usize,
    sx: usize,
    view_h: usize,
}
impl Notes {
    fn load() -> Notes {
        let raw = std::fs::read_to_string("data/notes.txt").unwrap_or_default();
        let mut lines: Vec<Vec<char>> = raw.split('\n').map(|l| l.trim_end_matches('\r').chars().collect()).collect();
        if lines.len() > 1 && lines.last().map(|l| l.is_empty()).unwrap_or(false) {
            lines.pop();
        }
        if lines.is_empty() {
            lines.push(vec![]);
        }
        Notes { lines, cy: 0, cx: 0, sy: 0, sx: 0, view_h: 12 }
    }
    fn clamp(&mut self) {
        if self.cy >= self.lines.len() {
            self.cy = self.lines.len() - 1;
        }
        let l = self.lines[self.cy].len();
        if self.cx > l {
            self.cx = l;
        }
    }
    fn key(&mut self, k: &KeyEvent) {
        self.clamp();
        match k.code {
            KeyCode::Char(c) if !k.modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) => {
                self.lines[self.cy].insert(self.cx, c);
                self.cx += 1;
            }
            KeyCode::Tab => {
                for _ in 0..2 {
                    self.lines[self.cy].insert(self.cx, ' ');
                    self.cx += 1;
                }
            }
            KeyCode::Enter => {
                let rest = self.lines[self.cy].split_off(self.cx);
                self.lines.insert(self.cy + 1, rest);
                self.cy += 1;
                self.cx = 0;
            }
            KeyCode::Backspace => {
                if self.cx > 0 {
                    self.lines[self.cy].remove(self.cx - 1);
                    self.cx -= 1;
                } else if self.cy > 0 {
                    let cur = self.lines.remove(self.cy);
                    self.cy -= 1;
                    self.cx = self.lines[self.cy].len();
                    self.lines[self.cy].extend(cur);
                }
            }
            KeyCode::Delete => {
                if self.cx < self.lines[self.cy].len() {
                    self.lines[self.cy].remove(self.cx);
                } else if self.cy + 1 < self.lines.len() {
                    let nx = self.lines.remove(self.cy + 1);
                    self.lines[self.cy].extend(nx);
                }
            }
            KeyCode::Left => {
                if self.cx > 0 {
                    self.cx -= 1;
                } else if self.cy > 0 {
                    self.cy -= 1;
                    self.cx = self.lines[self.cy].len();
                }
            }
            KeyCode::Right => {
                if self.cx < self.lines[self.cy].len() {
                    self.cx += 1;
                } else if self.cy + 1 < self.lines.len() {
                    self.cy += 1;
                    self.cx = 0;
                }
            }
            KeyCode::Up => {
                if self.cy > 0 {
                    self.cy -= 1;
                }
            }
            KeyCode::Down => {
                if self.cy + 1 < self.lines.len() {
                    self.cy += 1;
                }
            }
            KeyCode::Home => self.cx = 0,
            KeyCode::End => self.cx = self.lines[self.cy].len(),
            KeyCode::PageUp => self.cy = self.cy.saturating_sub(self.view_h.max(1)),
            KeyCode::PageDown => self.cy = (self.cy + self.view_h.max(1)).min(self.lines.len() - 1),
            _ => {}
        }
        self.clamp();
    }
}

#[derive(Deserialize, Clone)]
struct FileItem {
    name: String,
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    modified: String,
}
impl FileItem {
    fn is_dir(&self) -> bool {
        self.kind == "dir"
    }
}

struct Files {
    items: Vec<FileItem>,
    sel: usize,
    scroll: usize,
    view_rows: usize,
}
impl Files {
    fn load() -> Files {
        let raw = std::fs::read_to_string("data/files.json").unwrap_or_default();
        let mut items: Vec<FileItem> = serde_json::from_str(&raw).unwrap_or_default();
        items.sort_by_key(|i| !i.is_dir());
        Files { items, sel: 0, scroll: 0, view_rows: 8 }
    }
    fn key(&mut self, code: KeyCode) {
        if self.items.is_empty() {
            return;
        }
        let last = self.items.len() - 1;
        match code {
            KeyCode::Up => self.sel = self.sel.saturating_sub(1),
            KeyCode::Down => self.sel = (self.sel + 1).min(last),
            KeyCode::Home => self.sel = 0,
            KeyCode::End => self.sel = last,
            KeyCode::PageUp => self.sel = self.sel.saturating_sub(self.view_rows.max(1)),
            KeyCode::PageDown => self.sel = (self.sel + self.view_rows.max(1)).min(last),
            _ => {}
        }
    }
}

fn human(n: u64) -> String {
    let units = ["B", "KB", "MB", "GB", "TB"];
    let mut v = n as f64;
    let mut i = 0;
    while v >= 1024.0 && i < units.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 { format!("{} B", n) } else { format!("{:.1} {}", v, units[i]) }
}

struct Calc {
    acc: f64,
    op: Option<char>,
    cur: String,
    entering: bool,
    error: bool,
}
fn fmt_num(f: f64) -> String {
    if !f.is_finite() {
        return "Error".into();
    }
    if f.abs() >= 1e15 {
        return format!("{:e}", f);
    }
    let mut s = format!("{:.8}", f);
    if s.contains('.') {
        while s.ends_with('0') {
            s.pop();
        }
        if s.ends_with('.') {
            s.pop();
        }
    }
    if s == "-0" { "0".into() } else { s }
}
fn apply(a: f64, op: char, b: f64) -> Option<f64> {
    match op {
        '+' => Some(a + b),
        '-' => Some(a - b),
        '*' => Some(a * b),
        '/' => if b == 0.0 { None } else { Some(a / b) },
        _ => Some(b),
    }
}
impl Calc {
    fn new() -> Calc {
        Calc { acc: 0.0, op: None, cur: "0".into(), entering: false, error: false }
    }
    fn reset(&mut self) {
        *self = Calc::new();
    }
    fn value(&self) -> f64 {
        self.cur.parse::<f64>().unwrap_or(0.0)
    }
    fn set_error(&mut self) {
        self.cur = "Error".into();
        self.error = true;
        self.op = None;
        self.entering = false;
    }
    fn press(&mut self, c: char) {
        match c {
            '0'..='9' => {
                if self.error {
                    self.reset();
                }
                if !self.entering {
                    self.cur.clear();
                    self.entering = true;
                }
                if self.cur == "0" {
                    self.cur.clear();
                }
                if self.cur.len() < 14 {
                    self.cur.push(c);
                }
            }
            '.' => {
                if self.error {
                    self.reset();
                }
                if !self.entering {
                    self.cur = "0".into();
                    self.entering = true;
                }
                if !self.cur.contains('.') {
                    self.cur.push('.');
                }
            }
            '+' | '-' | '*' | '/' => {
                if self.error {
                    return;
                }
                let v = self.value();
                if let Some(op) = self.op {
                    if self.entering {
                        match apply(self.acc, op, v) {
                            Some(r) => {
                                self.acc = r;
                                self.cur = fmt_num(r);
                            }
                            None => {
                                self.set_error();
                                return;
                            }
                        }
                    }
                } else {
                    self.acc = v;
                }
                self.op = Some(c);
                self.entering = false;
            }
            '=' => {
                if self.error {
                    return;
                }
                if let Some(op) = self.op {
                    let v = self.value();
                    match apply(self.acc, op, v) {
                        Some(r) => {
                            self.acc = r;
                            self.cur = fmt_num(r);
                            self.op = None;
                            self.entering = false;
                        }
                        None => self.set_error(),
                    }
                }
            }
            'C' => self.reset(),
            'B' => {
                if self.error {
                    self.reset();
                } else if self.entering {
                    if self.cur.len() > 1 {
                        self.cur.pop();
                    } else {
                        self.cur = "0".into();
                    }
                }
            }
            _ => {}
        }
    }
    fn expr(&self) -> String {
        match self.op {
            Some(op) => {
                let s = match op {
                    '*' => '×',
                    '/' => '÷',
                    '-' => '−',
                    o => o,
                };
                format!("{} {}", fmt_num(self.acc), s)
            }
            None => String::new(),
        }
    }
}

struct CalcBtn {
    key: char,
    label: &'static str,
    r: R,
    style: u8, // 0 digit, 1 op, 2 equals, 3 clear
}
struct CalcLayout {
    expr_y: Option<i32>,
    disp: R,
    btns: Vec<CalcBtn>,
}
fn calc_layout(iw: i32, ih: i32) -> CalcLayout {
    let box_h = if ih >= 8 { 3 } else { 1 };
    let remaining = ih - box_h;
    let bh = (remaining / 5).max(1);
    let spare = remaining - 5 * bh;
    let (box_y, expr_y) = if spare >= 1 { (1, Some(0)) } else { (0, None) };
    let by = if spare >= 0 { ih - 5 * bh } else { box_h };
    let disp = R::new(0, box_y, iw, box_h);
    let bwt = (iw / 4).max(1);
    let margin = ((iw - 4 * bwt) / 2).max(0);
    let bw = if bwt >= 3 { bwt - 1 } else { bwt };
    let btn_h = if bh >= 2 { bh - 1 } else { 1 };
    let rows: [[(&'static str, char, u8); 4]; 4] = [
        [("7", '7', 0), ("8", '8', 0), ("9", '9', 0), ("÷", '/', 1)],
        [("4", '4', 0), ("5", '5', 0), ("6", '6', 0), ("×", '*', 1)],
        [("1", '1', 0), ("2", '2', 0), ("3", '3', 0), ("−", '-', 1)],
        [("0", '0', 0), (".", '.', 0), ("=", '=', 2), ("+", '+', 1)],
    ];
    let mut btns = vec![CalcBtn {
        key: 'C',
        label: "C",
        r: R::new(margin, by, 4 * bwt - (bwt - bw), btn_h),
        style: 3,
    }];
    for (ri, row) in rows.iter().enumerate() {
        for (ci, (label, key, style)) in row.iter().enumerate() {
            btns.push(CalcBtn {
                key: *key,
                label,
                r: R::new(margin + ci as i32 * bwt, by + (ri as i32 + 1) * bh, bw, btn_h),
                style: *style,
            });
        }
    }
    CalcLayout { expr_y, disp, btns }
}

// ---------------------------------------------------------------- windows & app

#[derive(Clone)]
struct Win {
    id: usize,
    kind: Kind,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    restore: Option<(i32, i32, i32, i32)>,
    maxed: bool,
}
impl Win {
    fn title(&self) -> &'static str {
        match self.kind {
            Kind::Notes => "Notes",
            Kind::Calc => "Calculator",
            Kind::Files => "Files",
        }
    }
    fn rect(&self) -> R {
        R::new(self.x, self.y, self.w, self.h)
    }
    fn inner(&self) -> R {
        R::new(self.x + 1, self.y + 1, (self.w - 2).max(0), (self.h - 2).max(0))
    }
}

fn default_win(id: usize) -> Win {
    let (kind, x, y, w, h) = match id {
        0 => (Kind::Notes, 4, 3, 44, 16),
        1 => (Kind::Calc, 72, 4, 28, 17),
        _ => (Kind::Files, 8, 14, 56, 14),
    };
    Win { id, kind, x, y, w, h, restore: None, maxed: false }
}

#[derive(Clone, Copy, PartialEq)]
enum Action {
    About,
    Quit,
    Reopen,
    Tile,
    Cascade,
    Next,
    Zoom,
    Close,
}

struct MenuDef {
    label: &'static str,
    items: &'static [(&'static str, &'static str, Action)],
}
const MENUS: [MenuDef; 4] = [
    MenuDef { label: " ≡ ", items: &[("About", "", Action::About), ("Quit", "ctrl+q", Action::Quit)] },
    MenuDef { label: " File ", items: &[("Reopen windows", "", Action::Reopen), ("Quit", "ctrl+q", Action::Quit)] },
    MenuDef {
        label: " Window ",
        items: &[
            ("Tile", "", Action::Tile),
            ("Cascade", "", Action::Cascade),
            ("Next", "F6", Action::Next),
            ("Zoom", "F5", Action::Zoom),
            ("Close", "ctrl+w", Action::Close),
        ],
    },
    MenuDef { label: " Help ", items: &[("About", "", Action::About)] },
];

fn menu_x(m: usize) -> i32 {
    MENUS[..m].iter().map(|d| d.label.chars().count() as i32).sum()
}
fn dropdown_rect(m: usize) -> R {
    let items = MENUS[m].items;
    let w = items
        .iter()
        .map(|(l, s, _)| l.chars().count() + if s.is_empty() { 0 } else { s.chars().count() + 3 })
        .max()
        .unwrap_or(4) as i32
        + 4;
    R::new(menu_x(m), 1, w, items.len() as i32 + 2)
}

enum Drag {
    Move { id: usize, dx: i32, dy: i32 },
    Resize { id: usize },
}

struct App {
    wins: Vec<Win>, // bottom -> top
    notes: Notes,
    calc: Calc,
    files: Files,
    menu: Option<(usize, usize)>,
    about: bool,
    drag: Option<Drag>,
    last_click: Option<(Instant, usize, i32, i32)>,
    w: i32,
    h: i32,
    quit: bool,
}

impl App {
    fn new(w: i32, h: i32) -> App {
        let mut app = App {
            wins: vec![default_win(0), default_win(1), default_win(2)],
            notes: Notes::load(),
            calc: Calc::new(),
            files: Files::load(),
            menu: None,
            about: false,
            drag: None,
            last_click: None,
            w,
            h,
            quit: false,
        };
        app.resize(w, h);
        app
    }

    fn desk_h(&self) -> i32 {
        (self.h - 2).max(1)
    }
    fn desk_rect(&self) -> R {
        R::new(0, 1, self.w, self.desk_h())
    }

    fn fit(&self, win: &mut Win) {
        let dh = self.desk_h();
        if win.maxed {
            win.x = 0;
            win.y = 1;
            win.w = self.w;
            win.h = dh;
            return;
        }
        win.w = win.w.min(self.w).max(1);
        win.h = win.h.min(dh).max(1);
        win.x = win.x.clamp(0, (self.w - win.w).max(0));
        win.y = win.y.clamp(1, (1 + dh - win.h).max(1));
    }

    fn resize(&mut self, w: i32, h: i32) {
        self.w = w;
        self.h = h;
        let mut wins = std::mem::take(&mut self.wins);
        for win in wins.iter_mut() {
            self.fit(win);
        }
        self.wins = wins;
    }

    fn focused(&self) -> Option<usize> {
        if self.wins.is_empty() { None } else { Some(self.wins.len() - 1) }
    }
    fn index_of(&self, id: usize) -> Option<usize> {
        self.wins.iter().position(|w| w.id == id)
    }
    fn raise_idx(&mut self, i: usize) {
        let w = self.wins.remove(i);
        self.wins.push(w);
    }
    fn close_idx(&mut self, i: usize) {
        self.wins.remove(i);
        self.drag = None;
    }
    fn toggle_max_idx(&mut self, i: usize) {
        let mut win = self.wins[i].clone();
        if win.maxed {
            if let Some((x, y, w, h)) = win.restore.take() {
                win.x = x;
                win.y = y;
                win.w = w;
                win.h = h;
            }
            win.maxed = false;
        } else {
            win.restore = Some((win.x, win.y, win.w, win.h));
            win.maxed = true;
        }
        self.fit(&mut win);
        self.wins[i] = win;
    }

    fn run(&mut self, a: Action) {
        match a {
            Action::About => self.about = true,
            Action::Quit => self.quit = true,
            Action::Reopen => {
                for id in 0..3 {
                    if self.index_of(id).is_none() {
                        let mut w = default_win(id);
                        self.fit(&mut w);
                        self.wins.push(w);
                    }
                }
            }
            Action::Tile => self.tile(),
            Action::Cascade => self.cascade(),
            Action::Next => {
                if self.wins.len() > 1 {
                    self.raise_idx(0);
                }
            }
            Action::Zoom => {
                if let Some(i) = self.focused() {
                    self.toggle_max_idx(i);
                }
            }
            Action::Close => {
                if let Some(i) = self.focused() {
                    self.close_idx(i);
                }
            }
        }
    }

    fn tile(&mut self) {
        let n = self.wins.len() as i32;
        if n == 0 {
            return;
        }
        let cols = (n as f64).sqrt().ceil() as i32;
        let rows = (n + cols - 1) / cols;
        let dh = self.desk_h();
        let mut idx = 0;
        for r in 0..rows {
            let cnt = if r == rows - 1 { n - cols * (rows - 1) } else { cols };
            let y0 = 1 + dh * r / rows;
            let y1 = 1 + dh * (r + 1) / rows;
            for c in 0..cnt {
                let x0 = self.w * c / cnt;
                let x1 = self.w * (c + 1) / cnt;
                let win = &mut self.wins[idx as usize];
                win.maxed = false;
                win.restore = None;
                win.x = x0;
                win.y = y0;
                win.w = x1 - x0;
                win.h = y1 - y0;
                idx += 1;
            }
        }
    }

    fn cascade(&mut self) {
        let n = self.wins.len() as i32;
        if n == 0 {
            return;
        }
        let dh = self.desk_h();
        let cw = (self.w - 4 * (n - 1) - 2).min(60).max(20).min(self.w);
        let ch = (dh - 2 * (n - 1)).min(18).max(7).min(dh);
        for (i, win) in self.wins.iter_mut().enumerate() {
            win.maxed = false;
            win.restore = None;
            win.w = cw;
            win.h = ch;
            win.x = (1 + 4 * i as i32).min((self.w - cw).max(0));
            win.y = (1 + 2 * i as i32).min((1 + dh - ch).max(1));
        }
    }

    // ------------------------------------------------------------ input

    fn on_event(&mut self, ev: Event) {
        match ev {
            Event::Key(k) => {
                if k.kind != KeyEventKind::Release {
                    self.on_key(k)
                }
            }
            Event::Mouse(m) => self.on_mouse(m),
            Event::Resize(w, h) => self.resize(w as i32, h as i32),
            _ => {}
        }
    }

    fn on_key(&mut self, k: KeyEvent) {
        let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
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
        if let Some((m, i)) = self.menu {
            let nm = MENUS.len();
            match k.code {
                KeyCode::Esc | KeyCode::F(10) => self.menu = None,
                KeyCode::Left => self.menu = Some(((m + nm - 1) % nm, 0)),
                KeyCode::Right => self.menu = Some(((m + 1) % nm, 0)),
                KeyCode::Up => {
                    let n = MENUS[m].items.len();
                    self.menu = Some((m, (i + n - 1) % n));
                }
                KeyCode::Down => {
                    let n = MENUS[m].items.len();
                    self.menu = Some((m, (i + 1) % n));
                }
                KeyCode::Enter => {
                    let a = MENUS[m].items[i].2;
                    self.menu = None;
                    self.run(a);
                }
                _ => {}
            }
            return;
        }
        match k.code {
            KeyCode::F(10) => {
                self.menu = Some((0, 0));
                return;
            }
            KeyCode::F(5) => {
                self.run(Action::Zoom);
                return;
            }
            KeyCode::F(6) => {
                self.run(Action::Next);
                return;
            }
            KeyCode::Char('w') | KeyCode::Char('W') if ctrl => {
                self.run(Action::Close);
                return;
            }
            _ => {}
        }
        let Some(fi) = self.focused() else { return };
        match self.wins[fi].kind {
            Kind::Notes => self.notes.key(&k),
            Kind::Files => self.files.key(k.code),
            Kind::Calc => {
                if ctrl || k.modifiers.contains(KeyModifiers::ALT) {
                    return;
                }
                match k.code {
                    KeyCode::Char(c) => match c {
                        '0'..='9' | '.' | '+' | '-' | '*' | '/' | '=' => self.calc.press(c),
                        'x' | 'X' => self.calc.press('*'),
                        'c' | 'C' => self.calc.press('C'),
                        '×' => self.calc.press('*'),
                        '÷' => self.calc.press('/'),
                        '−' => self.calc.press('-'),
                        _ => {}
                    },
                    KeyCode::Enter => self.calc.press('='),
                    KeyCode::Backspace => self.calc.press('B'),
                    KeyCode::Delete | KeyCode::Esc => {}
                    _ => {}
                }
            }
        }
    }

    fn taskbar_entries(&self) -> Vec<(usize, R)> {
        let mut ids: Vec<(usize, &'static str)> = self.wins.iter().map(|w| (w.id, w.title())).collect();
        ids.sort_by_key(|(id, _)| *id);
        let mut x = 1;
        let mut out = vec![];
        for (id, t) in ids {
            let w = t.chars().count() as i32 + 2;
            out.push((id, R::new(x, self.h - 1, w, 1)));
            x += w + 1;
        }
        out
    }

    fn win_at(&self, x: i32, y: i32) -> Option<usize> {
        (0..self.wins.len()).rev().find(|&i| self.wins[i].rect().contains(x, y))
    }

    fn on_mouse(&mut self, m: MouseEvent) {
        let mx = m.column as i32;
        let my = m.row as i32;
        match m.kind {
            MouseEventKind::Down(MouseButton::Left) => self.mouse_down(mx, my),
            MouseEventKind::Drag(MouseButton::Left) => self.mouse_drag(mx, my),
            MouseEventKind::Up(MouseButton::Left) => self.drag = None,
            MouseEventKind::ScrollUp => self.mouse_scroll(mx, my, -1),
            MouseEventKind::ScrollDown => self.mouse_scroll(mx, my, 1),
            _ => {}
        }
    }

    fn mouse_scroll(&mut self, mx: i32, my: i32, dir: i32) {
        if self.menu.is_some() || self.about {
            return;
        }
        if let Some(i) = self.win_at(mx, my) {
            match self.wins[i].kind {
                Kind::Notes => {
                    let n = self.notes.lines.len() as i32;
                    let ny = (self.notes.cy as i32 + dir * 3).clamp(0, n - 1);
                    self.notes.cy = ny as usize;
                    self.notes.clamp();
                }
                Kind::Files => {
                    if !self.files.items.is_empty() {
                        let n = self.files.items.len() as i32;
                        self.files.sel = (self.files.sel as i32 + dir).clamp(0, n - 1) as usize;
                    }
                }
                Kind::Calc => {}
            }
        }
    }

    fn about_rect(&self) -> R {
        let w = 46.min(self.w);
        let h = 9.min(self.h);
        R::new((self.w - w) / 2, (self.h - h) / 2, w, h)
    }

    fn mouse_down(&mut self, mx: i32, my: i32) {
        // modal dialog
        if self.about {
            let r = self.about_rect();
            let ok = R::new(r.x + r.w / 2 - 4, r.y + r.h - 3, 8, 1);
            if ok.contains(mx, my) {
                self.about = false;
            }
            return;
        }
        // open menu
        if let Some((m, _)) = self.menu {
            if my == 0 {
                for (i, d) in MENUS.iter().enumerate() {
                    let x = menu_x(i);
                    if mx >= x && mx < x + d.label.chars().count() as i32 {
                        self.menu = if i == m { None } else { Some((i, 0)) };
                        return;
                    }
                }
                self.menu = None;
                return;
            }
            let r = dropdown_rect(m);
            if r.contains(mx, my) {
                let idx = my - r.y - 1;
                if idx >= 0 && (idx as usize) < MENUS[m].items.len() && mx > r.x && mx < r.x + r.w - 1 {
                    let a = MENUS[m].items[idx as usize].2;
                    self.menu = None;
                    self.run(a);
                }
                return;
            }
            self.menu = None;
            return;
        }
        // menu bar
        if my == 0 {
            for (i, d) in MENUS.iter().enumerate() {
                let x = menu_x(i);
                if mx >= x && mx < x + d.label.chars().count() as i32 {
                    self.menu = Some((i, 0));
                    return;
                }
            }
            return;
        }
        // taskbar
        if my == self.h - 1 {
            for (id, r) in self.taskbar_entries() {
                if r.contains(mx, my) {
                    if let Some(i) = self.index_of(id) {
                        self.raise_idx(i);
                    }
                    return;
                }
            }
            return;
        }
        // windows
        let Some(i) = self.win_at(mx, my) else {
            self.last_click = None;
            return;
        };
        self.raise_idx(i);
        let top = self.wins.len() - 1;
        let win = self.wins[top].clone();
        let lx = mx - win.x;
        let ly = my - win.y;
        if ly == 0 {
            if (1..=3).contains(&lx) {
                self.close_idx(top);
                return;
            }
            if lx >= win.w - 4 && lx <= win.w - 2 {
                self.toggle_max_idx(top);
                self.last_click = None;
                return;
            }
            // title bar
            let now = Instant::now();
            if let Some((t, id, px, py)) = self.last_click {
                if id == win.id && (px - mx).abs() <= 2 && py == my && now.duration_since(t) < Duration::from_millis(600) {
                    self.last_click = None;
                    self.toggle_max_idx(top);
                    return;
                }
            }
            self.last_click = Some((now, win.id, mx, my));
            if !win.maxed {
                self.drag = Some(Drag::Move { id: win.id, dx: lx, dy: ly });
            }
            return;
        }
        self.last_click = None;
        if lx == win.w - 1 && ly == win.h - 1 {
            self.drag = Some(Drag::Resize { id: win.id });
            return;
        }
        // content
        let inner = win.inner();
        if !inner.contains(mx, my) {
            return;
        }
        match win.kind {
            Kind::Notes => {
                let ny = self.notes.sy + (my - inner.y) as usize;
                let nx = self.notes.sx + (mx - inner.x - 1).max(0) as usize;
                self.notes.cy = ny.min(self.notes.lines.len() - 1);
                self.notes.cx = nx;
                self.notes.clamp();
            }
            Kind::Files => {
                let row = my - inner.y - 1;
                if row >= 0 {
                    let idx = self.files.scroll + row as usize;
                    if idx < self.files.items.len() {
                        self.files.sel = idx;
                    }
                }
            }
            Kind::Calc => {
                let lay = calc_layout(inner.w, inner.h);
                for b in &lay.btns {
                    let r = R::new(inner.x + b.r.x, inner.y + b.r.y, b.r.w, b.r.h);
                    if r.contains(mx, my) {
                        self.calc.press(b.key);
                        break;
                    }
                }
            }
        }
    }

    fn mouse_drag(&mut self, mx: i32, my: i32) {
        let (w, h) = (self.w, self.h);
        let dh = self.desk_h();
        match self.drag {
            Some(Drag::Move { id, dx, dy }) => {
                if let Some(i) = self.index_of(id) {
                    let win = &mut self.wins[i];
                    let nx = (mx - dx).clamp(8 - win.w, (w - 8).max(8 - win.w));
                    let ny = (my - dy).clamp(1, (h - 2).max(1));
                    win.x = nx;
                    win.y = ny;
                    win.maxed = false;
                    win.restore = None;
                }
            }
            Some(Drag::Resize { id }) => {
                if let Some(i) = self.index_of(id) {
                    let win = &mut self.wins[i];
                    let nw = (mx - win.x + 1).min((w - win.x).max(1)).max(20);
                    let nh = (my - win.y + 1).min((1 + dh - win.y).max(1)).max(7);
                    win.w = nw;
                    win.h = nh;
                    win.maxed = false;
                    win.restore = None;
                }
            }
            None => {}
        }
    }

    // ------------------------------------------------------------ drawing

    fn draw(&mut self, f: &mut Frame) {
        let area = f.area();
        let (w, h) = (area.width as i32, area.height as i32);
        if w != self.w || h != self.h {
            self.resize(w, h);
        }
        let buf = f.buffer_mut();
        let full = R::new(0, 0, w, h);
        let desk = self.desk_rect().intersect(&full);

        // desktop pattern
        for y in desk.y..desk.y + desk.h {
            for x in desk.x..desk.x + desk.w {
                let ch = if (x + y) % 2 == 0 { '░' } else { ' ' };
                put(buf, x, y, ch, st(DESK_FG, DESK_BG));
            }
        }

        let n = self.wins.len();
        for i in 0..n {
            self.draw_window(buf, i, desk);
        }

        self.draw_menubar(buf, full);
        self.draw_taskbar(buf, full);
        if let Some((m, sel)) = self.menu {
            self.draw_dropdown(buf, m, sel, full);
        }
        if self.about {
            self.draw_about(buf, full);
        }
    }

    fn draw_menubar(&self, buf: &mut Buffer, full: R) {
        let bar = R::new(0, 0, self.w, 1);
        fill(buf, bar, full, ' ', st(BAR_FG, BAR_BG));
        for (i, d) in MENUS.iter().enumerate() {
            let x = menu_x(i);
            let active = self.menu.map(|(m, _)| m == i).unwrap_or(false);
            let style = if active {
                st(rgb(255, 255, 255), BAR_SEL).add_modifier(Modifier::BOLD)
            } else {
                st(BAR_FG, BAR_BG).add_modifier(if i == 0 { Modifier::BOLD } else { Modifier::empty() })
            };
            text(buf, x, 0, d.label, style, full);
        }
        let t = " 10:42 ";
        text(buf, self.w - t.chars().count() as i32, 0, t, st(BAR_FG, BAR_BG).add_modifier(Modifier::BOLD), full);
    }

    fn draw_taskbar(&self, buf: &mut Buffer, full: R) {
        let y = self.h - 1;
        fill(buf, R::new(0, y, self.w, 1), full, ' ', st(TASK_FG, TASK_BG));
        let focus_id = self.focused().map(|i| self.wins[i].id);
        for (id, r) in self.taskbar_entries() {
            let Some(i) = self.index_of(id) else { continue };
            let focused = Some(id) == focus_id;
            let style = if focused {
                st(rgb(8, 18, 28), ACC).add_modifier(Modifier::BOLD)
            } else {
                st(TASK_FG, rgb(46, 52, 72))
            };
            fill(buf, r, full, ' ', style);
            text(buf, r.x + 1, y, self.wins[i].title(), style, full);
        }
    }

    fn draw_dropdown(&self, buf: &mut Buffer, m: usize, sel: usize, full: R) {
        let r = dropdown_rect(m);
        shade(buf, R::new(r.x + r.w, r.y + 1, 2, r.h), full);
        shade(buf, R::new(r.x + 2, r.y + r.h, r.w, 1), full);
        let base = st(BAR_FG, rgb(214, 218, 226));
        fill(buf, r, full, ' ', base);
        // border
        for x in r.x..r.x + r.w {
            put(buf, x, r.y, '─', base);
            put(buf, x, r.y + r.h - 1, '─', base);
        }
        for y in r.y..r.y + r.h {
            put(buf, r.x, y, '│', base);
            put(buf, r.x + r.w - 1, y, '│', base);
        }
        put(buf, r.x, r.y, '┌', base);
        put(buf, r.x + r.w - 1, r.y, '┐', base);
        put(buf, r.x, r.y + r.h - 1, '└', base);
        put(buf, r.x + r.w - 1, r.y + r.h - 1, '┘', base);
        for (i, (label, sc, _)) in MENUS[m].items.iter().enumerate() {
            let y = r.y + 1 + i as i32;
            let style = if i == sel { st(rgb(255, 255, 255), BAR_SEL) } else { base };
            fill(buf, R::new(r.x + 1, y, r.w - 2, 1), full, ' ', style);
            text(buf, r.x + 2, y, label, style, full);
            if !sc.is_empty() {
                let sx = r.x + r.w - 2 - sc.chars().count() as i32;
                let s2 = if i == sel { style } else { st(rgb(90, 98, 115), rgb(214, 218, 226)) };
                text(buf, sx, y, sc, s2, full);
            }
        }
    }

    fn draw_about(&self, buf: &mut Buffer, full: R) {
        let r = self.about_rect();
        shade(buf, R::new(r.x + r.w, r.y + 1, 2, r.h), full);
        shade(buf, R::new(r.x + 2, r.y + r.h, r.w, 1), full);
        let base = st(rgb(230, 234, 242), rgb(30, 54, 96));
        fill(buf, r, full, ' ', base);
        let line = st(rgb(150, 200, 255), rgb(30, 54, 96));
        for x in r.x..r.x + r.w {
            put(buf, x, r.y, '═', line);
            put(buf, x, r.y + r.h - 1, '═', line);
        }
        for y in r.y..r.y + r.h {
            put(buf, r.x, y, '║', line);
            put(buf, r.x + r.w - 1, y, '║', line);
        }
        put(buf, r.x, r.y, '╔', line);
        put(buf, r.x + r.w - 1, r.y, '╗', line);
        put(buf, r.x, r.y + r.h - 1, '╚', line);
        put(buf, r.x + r.w - 1, r.y + r.h - 1, '╝', line);
        let title = " About ";
        text(buf, r.x + (r.w - 7) / 2, r.y, title, base.add_modifier(Modifier::BOLD), full);
        let lines = [
            ("Desktop Windows", true),
            ("", false),
            ("A text-mode desktop in Rust + ratatui", false),
            ("Version 1.0", false),
        ];
        for (i, (l, bold)) in lines.iter().enumerate() {
            let w = l.chars().count() as i32;
            let s = if *bold { base.add_modifier(Modifier::BOLD) } else { base };
            text(buf, r.x + (r.w - w) / 2, r.y + 2 + i as i32, l, s, full);
        }
        let ok = R::new(r.x + r.w / 2 - 4, r.y + r.h - 3, 8, 1);
        fill(buf, ok, full, ' ', st(rgb(8, 18, 28), ACC));
        text(buf, ok.x + 1, ok.y, "[ OK ]", st(rgb(8, 18, 28), ACC).add_modifier(Modifier::BOLD), full);
    }

    fn draw_window(&mut self, buf: &mut Buffer, i: usize, desk: R) {
        let win = self.wins[i].clone();
        let focused = i == self.wins.len() - 1;
        let r = win.rect();
        // shadow
        shade(buf, R::new(r.x + r.w, r.y + 1, 2, r.h), desk);
        shade(buf, R::new(r.x + 2, r.y + r.h, r.w, 1), desk);

        let bg = adj(WIN_BG, focused);
        fill(buf, r, desk, ' ', st(adj(WIN_FG, focused), bg));

        let (tl, tr, bl, br, hz, vt) = if focused {
            ('╔', '╗', '╚', '╝', '═', '║')
        } else {
            ('┌', '┐', '└', '┘', '─', '│')
        };
        let tstyle = if focused {
            st(rgb(8, 18, 28), ACC)
        } else {
            st(rgb(140, 148, 166), rgb(42, 48, 64))
        };
        let bstyle = if focused { st(ACC, bg) } else { st(rgb(82, 90, 108), bg) };

        // title bar
        for x in r.x..r.x + r.w {
            putc(buf, x, r.y, hz, tstyle, desk);
        }
        putc(buf, r.x, r.y, tl, tstyle, desk);
        putc(buf, r.x + r.w - 1, r.y, tr, tstyle, desk);
        if r.w >= 12 {
            text(buf, r.x + 1, r.y, "[", tstyle, desk);
            text(buf, r.x + 2, r.y, "×", tstyle.fg(if focused { rgb(150, 20, 30) } else { rgb(140, 148, 166) }).add_modifier(Modifier::BOLD), desk);
            text(buf, r.x + 3, r.y, "]", tstyle, desk);
            let mx = r.x + r.w - 4;
            text(buf, mx, r.y, "[", tstyle, desk);
            text(buf, mx + 1, r.y, "↑", tstyle.fg(if focused { rgb(14, 100, 60) } else { rgb(140, 148, 166) }).add_modifier(Modifier::BOLD), desk);
            text(buf, mx + 2, r.y, "]", tstyle, desk);
            let avail = (r.w - 10).max(0) as usize;
            let label = format!(" {} ", trunc(win.title(), avail.saturating_sub(2)));
            let lw = label.chars().count() as i32;
            let tx = r.x + (r.w - lw) / 2;
            let ts = if focused { tstyle.add_modifier(Modifier::BOLD) } else { tstyle };
            text(buf, tx, r.y, &label, ts, desk);
        }
        // sides and bottom
        for y in r.y + 1..r.y + r.h - 1 {
            putc(buf, r.x, y, vt, bstyle, desk);
            putc(buf, r.x + r.w - 1, y, vt, bstyle, desk);
        }
        for x in r.x..r.x + r.w {
            putc(buf, x, r.y + r.h - 1, hz, bstyle, desk);
        }
        putc(buf, r.x, r.y + r.h - 1, bl, bstyle, desk);
        putc(buf, r.x + r.w - 1, r.y + r.h - 1, br, bstyle, desk);
        // resize handle
        putc(
            buf,
            r.x + r.w - 1,
            r.y + r.h - 1,
            '▟',
            st(if focused { rgb(240, 200, 90) } else { rgb(110, 100, 70) }, bg),
            desk,
        );

        let inner = win.inner();
        let clip = inner.intersect(&desk);
        if inner.w <= 0 || inner.h <= 0 {
            return;
        }
        let bottom_label = match win.kind {
            Kind::Notes => Some(format!(" Ln {}, Col {} ", self.notes.cy + 1, self.notes.cx + 1)),
            Kind::Files => {
                let d = self.files.items.iter().filter(|f| f.is_dir()).count();
                Some(format!(" {} dirs, {} files ", d, self.files.items.len() - d))
            }
            Kind::Calc => None,
        };
        if let Some(l) = bottom_label {
            if r.w >= 22 {
                let l = trunc(&l, (r.w - 8) as usize);
                text(buf, r.x + 2, r.y + r.h - 1, &l, bstyle, desk);
            }
        }
        match win.kind {
            Kind::Notes => self.draw_notes(buf, inner, clip, focused),
            Kind::Calc => self.draw_calc(buf, inner, clip, focused),
            Kind::Files => self.draw_files(buf, inner, clip, focused),
        }
    }

    fn draw_notes(&mut self, buf: &mut Buffer, inner: R, clip: R, focused: bool) {
        let n = &mut self.notes;
        n.clamp();
        let ih = inner.h as usize;
        let tw = (inner.w - 2).max(1) as usize;
        n.view_h = ih;
        if n.cy < n.sy {
            n.sy = n.cy;
        }
        if n.cy >= n.sy + ih {
            n.sy = n.cy + 1 - ih;
        }
        if n.cx < n.sx {
            n.sx = n.cx;
        }
        if n.cx >= n.sx + tw {
            n.sx = n.cx + 1 - tw;
        }
        let bg = adj(WIN_BG, focused);
        let fg = adj(WIN_FG, focused);
        for row in 0..ih {
            let li = n.sy + row;
            let y = inner.y + row as i32;
            if li >= n.lines.len() {
                break;
            }
            let is_cur = focused && li == n.cy;
            let rb = if is_cur { rgb(32, 40, 62) } else { bg };
            fill(buf, R::new(inner.x, y, inner.w, 1), clip, ' ', st(fg, rb));
            let line = &n.lines[li];
            let is_heading = !line.is_empty() && !line.starts_with(&['-']) ;
            let ls = if is_heading {
                st(adj(rgb(240, 200, 100), focused), rb).add_modifier(Modifier::BOLD)
            } else {
                st(fg, rb)
            };
            for (ci, ch) in line.iter().enumerate().skip(n.sx).take(tw) {
                let sty = if !is_heading && *ch == '-' && ci == 0 { st(adj(ACC, focused), rb) } else { ls };
                putc(buf, inner.x + 1 + (ci - n.sx) as i32, y, *ch, sty, clip);
            }
        }
        if focused {
            let cx = inner.x + 1 + (n.cx - n.sx) as i32;
            let cy = inner.y + (n.cy - n.sy) as i32;
            let ch = n.lines[n.cy].get(n.cx).copied().unwrap_or(' ');
            putc(buf, cx, cy, ch, st(rgb(20, 24, 34), rgb(235, 238, 245)), clip);
        }
    }

    fn draw_calc(&self, buf: &mut Buffer, inner: R, clip: R, focused: bool) {
        let lay = calc_layout(inner.w, inner.h);
        let abs = |r: R| R::new(inner.x + r.x, inner.y + r.y, r.w, r.h);
        // expression line
        if let Some(ey) = lay.expr_y {
            let e = self.calc.expr();
            let w = e.chars().count() as i32;
            text(buf, inner.x + inner.w - 1 - w, inner.y + ey, &e, st(adj(rgb(150, 158, 178), focused), adj(WIN_BG, focused)), clip);
        }
        // display
        let d = abs(lay.disp);
        let dbg = adj(rgb(8, 12, 20), focused);
        fill(buf, d, clip, ' ', st(WIN_FG, dbg));
        let val = &self.calc.cur;
        let vs = trunc(val, (d.w - 2).max(1) as usize);
        let vw = vs.chars().count() as i32;
        let fgc = if self.calc.error { rgb(255, 110, 110) } else { rgb(140, 250, 170) };
        let vy = d.y + d.h / 2;
        text(buf, d.x + d.w - 1 - vw, vy, &vs, st(adj(fgc, focused), dbg).add_modifier(Modifier::BOLD), clip);
        // buttons
        for b in &lay.btns {
            let r = abs(b.r);
            let (fg, bg) = match b.style {
                0 => (rgb(235, 238, 246), rgb(58, 68, 94)),
                1 => (rgb(30, 20, 6), rgb(222, 160, 70)),
                2 => (rgb(8, 30, 18), rgb(96, 200, 140)),
                _ => (rgb(255, 255, 255), rgb(190, 70, 84)),
            };
            let s = st(adj(fg, focused), adj(bg, focused));
            fill(buf, r, clip, ' ', s);
            let lw = b.label.chars().count() as i32;
            text(buf, r.x + (r.w - lw) / 2, r.y + (r.h - 1) / 2, b.label, s.add_modifier(Modifier::BOLD), clip);
        }
    }

    fn draw_files(&mut self, buf: &mut Buffer, inner: R, clip: R, focused: bool) {
        let f = &mut self.files;
        let rows = (inner.h - 1).max(1) as usize;
        f.view_rows = rows;
        if f.sel < f.scroll {
            f.scroll = f.sel;
        }
        if f.sel >= f.scroll + rows {
            f.scroll = f.sel + 1 - rows;
        }
        let iw = inner.w;
        let bg = adj(WIN_BG, focused);
        let fg = adj(WIN_FG, focused);
        let show_mod = iw >= 42;
        let show_size = iw >= 28;
        let mod_w = if show_mod { 17 } else { 0 };
        let size_w = if show_size { 10 } else { 0 };
        let name_w = (iw - 2 - mod_w - size_w).max(1) as usize;
        // header
        let hs = st(adj(ACC, focused), adj(rgb(34, 42, 64), focused)).add_modifier(Modifier::BOLD);
        fill(buf, R::new(inner.x, inner.y, iw, 1), clip, ' ', hs);
        text(buf, inner.x + 3, inner.y, "Name", hs, clip);
        if show_size {
            let sx = inner.x + 1 + name_w as i32 + size_w - 4;
            text(buf, sx, inner.y, "Size", hs, clip);
        }
        if show_mod {
            text(buf, inner.x + 1 + name_w as i32 + size_w + 1, inner.y, "Modified", hs, clip);
        }
        for row in 0..rows {
            let idx = f.scroll + row;
            let y = inner.y + 1 + row as i32;
            if idx >= f.items.len() {
                break;
            }
            let it = &f.items[idx];
            let selected = idx == f.sel;
            let (rfg, rbg) = if selected {
                if focused {
                    (rgb(255, 255, 255), rgb(36, 110, 160))
                } else {
                    (rgb(200, 205, 215), rgb(44, 52, 72))
                }
            } else {
                (fg, bg)
            };
            let base = st(rfg, rbg);
            fill(buf, R::new(inner.x, y, iw, 1), clip, ' ', base);
            let (mk, mkc) = if it.is_dir() { ("▸", adj(rgb(240, 200, 90), focused)) } else { (" ", rfg) };
            let mkc = if selected { rfg } else { mkc };
            text(buf, inner.x + 1, y, mk, st(mkc, rbg), clip);
            let ns = if it.is_dir() {
                st(if selected { rfg } else { adj(rgb(240, 200, 90), focused) }, rbg).add_modifier(Modifier::BOLD)
            } else {
                base
            };
            text(buf, inner.x + 3, y, &trunc(&it.name, name_w.saturating_sub(2)), ns, clip);
            if show_size {
                let s = if it.is_dir() { "<DIR>".to_string() } else { human(it.size) };
                let sw = s.chars().count() as i32;
                let sx = inner.x + 1 + name_w as i32 + size_w - sw;
                let ss = if selected { base } else { st(adj(rgb(150, 160, 180), focused), rbg) };
                text(buf, sx, y, &s, ss, clip);
            }
            if show_mod {
                let ms = if selected { base } else { st(adj(rgb(130, 140, 162), focused), rbg) };
                text(buf, inner.x + 1 + name_w as i32 + size_w + 1, y, &it.modified, ms, clip);
            }
        }
    }
}

// ---------------------------------------------------------------- main

fn run(terminal: &mut ratatui::DefaultTerminal) -> io::Result<()> {
    let (cw, ch) = crossterm::terminal::size().unwrap_or((120, 36));
    let mut app = App::new(cw as i32, ch as i32);
    loop {
        let _ = catch_unwind(AssertUnwindSafe(|| terminal.draw(|f| app.draw(f)).map(|_| ())));
        if app.quit {
            return Ok(());
        }
        let ev = event::read()?;
        let _ = catch_unwind(AssertUnwindSafe(|| app.on_event(ev)));
        while !app.quit && event::poll(Duration::from_millis(0))? {
            let ev = event::read()?;
            let _ = catch_unwind(AssertUnwindSafe(|| app.on_event(ev)));
        }
        if app.quit {
            return Ok(());
        }
    }
}

fn main() -> io::Result<()> {
    let mut terminal = ratatui::init();
    std::panic::set_hook(Box::new(|_| {}));
    let _ = execute!(stdout(), EnableMouseCapture);
    let res = run(&mut terminal);
    let _ = execute!(stdout(), DisableMouseCapture);
    ratatui::restore();
    res
}
