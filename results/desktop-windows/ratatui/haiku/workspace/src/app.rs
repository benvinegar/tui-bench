use std::time::Instant;

use crossterm::event::{
    KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
};

use crate::calc::{self, Calc, Key as CalcKey, Op};
use crate::data::{self, FileList};
use crate::notes::Notes;

pub const MIN_W: i32 = 20;
pub const MIN_H: i32 = 7;
const DOUBLE_CLICK_MS: u128 = 500;
pub const CLOCK: &str = "10:42";

/// Clamps `v` into `[lo, hi]`; returns `lo` when the range is empty (never panics).
pub fn clamp_i(v: i32, lo: i32, hi: i32) -> i32 {
    if hi < lo { lo } else { v.max(lo).min(hi) }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Notes,
    Calc,
    Files,
}

/// Geometry as (x, y, w, h) in screen cells.
pub type Geo = (i32, i32, i32, i32);

#[derive(Clone, Debug)]
pub struct Win {
    pub id: u32,
    pub kind: Kind,
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    /// Geometry to return to when un-maximizing; `Some` while maximized.
    pub restore: Option<Geo>,
}

impl Win {
    pub fn title(&self) -> &'static str {
        match self.kind {
            Kind::Notes => "Notes",
            Kind::Calc => "Calculator",
            Kind::Files => "Files",
        }
    }

    pub fn zoomed(&self) -> bool {
        self.restore.is_some()
    }

    fn contains(&self, col: i32, row: i32) -> bool {
        col >= self.x && col < self.x + self.w && row >= self.y && row < self.y + self.h
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Region {
    Close,
    Max,
    Title,
    Resize,
    Content(i32, i32),
    Border,
}

fn region_of(w: &Win, col: i32, row: i32) -> Region {
    let rx = col - w.x;
    let ry = row - w.y;
    if ry == 0 {
        if (1..=3).contains(&rx) {
            Region::Close
        } else if rx >= w.w - 4 && rx <= w.w - 2 {
            Region::Max
        } else if rx == 0 || rx == w.w - 1 {
            Region::Border
        } else {
            Region::Title
        }
    } else if ry == w.h - 1 {
        if rx == w.w - 1 { Region::Resize } else { Region::Border }
    } else if rx == 0 || rx == w.w - 1 {
        Region::Border
    } else {
        Region::Content(rx - 1, ry - 1)
    }
}

/// Keeps a window on the desktop, shrinking it only if it cannot fit the screen.
fn fit(w: &mut Win, cols: i32, rows: i32) {
    let desk_h = rows - 2;
    if desk_h < 1 {
        return;
    }
    w.w = clamp_i(w.w, 1, cols.max(1));
    w.h = clamp_i(w.h, 1, desk_h);
    w.x = clamp_i(w.x, 0, cols - w.w);
    w.y = clamp_i(w.y, 1, rows - 1 - w.h);
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Zoom,
    Close,
    Quit,
    Tile,
    Cascade,
    Next,
    About,
}

pub struct MenuDef {
    pub title: &'static str,
    pub items: &'static [(&'static str, &'static str, Action)],
}

pub const MENUS: &[MenuDef] = &[
    MenuDef {
        title: "≡",
        items: &[("Zoom", "F5", Action::Zoom), ("Close", "ctrl+w", Action::Close)],
    },
    MenuDef { title: "File", items: &[("Quit", "ctrl+q", Action::Quit)] },
    MenuDef {
        title: "Window",
        items: &[
            ("Tile", "", Action::Tile),
            ("Cascade", "", Action::Cascade),
            ("Next", "F6", Action::Next),
            ("Zoom", "F5", Action::Zoom),
            ("Close", "ctrl+w", Action::Close),
        ],
    },
    MenuDef { title: "Help", items: &[("About", "", Action::About)] },
];

/// x-span (start, end exclusive) of each menu title in the menu bar.
pub fn menu_spans() -> Vec<(i32, i32)> {
    let mut x = 0;
    let mut out = Vec::new();
    for m in MENUS {
        let w = m.title.chars().count() as i32 + 2;
        out.push((x, x + w));
        x += w;
    }
    out
}

#[derive(Clone, Copy, Debug)]
pub struct OpenMenu {
    pub menu: usize,
    pub item: usize,
}

#[derive(Clone, Copy, Debug)]
enum Drag {
    Move { id: u32, dx: i32, dy: i32 },
    Resize { id: u32 },
}

pub struct App {
    pub cols: i32,
    pub rows: i32,
    /// Bottom of the stack first; the last window is the focused one.
    pub wins: Vec<Win>,
    pub notes: Notes,
    pub calc: Calc,
    pub files: FileList,
    pub menu: Option<OpenMenu>,
    pub about: bool,
    pub quit: bool,
    drag: Option<Drag>,
    last_title_click: Option<(Instant, i32)>,
}

impl App {
    pub fn new(cols: i32, rows: i32) -> App {
        let mut app = App {
            cols,
            rows,
            wins: vec![
                Win { id: 1, kind: Kind::Notes, x: 4, y: 3, w: 44, h: 16, restore: None },
                Win { id: 2, kind: Kind::Calc, x: 72, y: 4, w: 28, h: 17, restore: None },
                Win { id: 3, kind: Kind::Files, x: 8, y: 14, w: 56, h: 14, restore: None },
            ],
            notes: Notes::new(data::load_notes()),
            calc: Calc::new(),
            files: FileList::new(data::load_files()),
            menu: None,
            about: false,
            quit: false,
            drag: None,
            last_title_click: None,
        };
        app.on_resize(cols, rows);
        app
    }

    pub fn focused(&self) -> Option<usize> {
        self.wins.len().checked_sub(1)
    }

    fn raise(&mut self, idx: usize) -> usize {
        let w = self.wins.remove(idx);
        self.wins.push(w);
        self.wins.len() - 1
    }

    fn top_window_at(&self, col: i32, row: i32) -> Option<usize> {
        (0..self.wins.len()).rev().find(|&i| self.wins[i].contains(col, row))
    }

    /// (stack index, x start, x end) of each taskbar entry that fits on screen.
    pub fn taskbar_items(&self) -> Vec<(usize, i32, i32)> {
        let mut out = Vec::new();
        let mut x = 1;
        for (i, w) in self.wins.iter().enumerate() {
            let label_w = w.title().chars().count() as i32 + 2;
            if x + label_w > self.cols {
                break;
            }
            out.push((i, x, x + label_w));
            x += label_w + 1;
        }
        out
    }

    pub fn dropdown_rect(&self, menu: usize) -> Geo {
        let def = &MENUS[menu];
        let (x0, _) = menu_spans()[menu];
        let inner = def
            .items
            .iter()
            .map(|(l, s, _)| (l.chars().count() + s.chars().count() + 4) as i32)
            .max()
            .unwrap_or(8);
        let w = inner + 2;
        let h = def.items.len() as i32 + 2;
        (clamp_i(x0, 0, self.cols - w), 1, w, h)
    }

    pub fn about_rect(&self) -> Geo {
        let (w, h) = (38, 9);
        let x = ((self.cols - w) / 2).max(0);
        let y = ((self.rows - h) / 2).max(0);
        (x, y, w, h)
    }

    pub fn on_resize(&mut self, cols: i32, rows: i32) {
        self.cols = cols.max(1);
        self.rows = rows.max(1);
        let (cols, rows) = (self.cols, self.rows);
        let desk_h = (rows - 2).max(1);
        for w in &mut self.wins {
            if w.zoomed() {
                w.x = 0;
                w.y = 1;
                w.w = cols;
                w.h = desk_h;
            } else {
                fit(w, cols, rows);
            }
        }
        self.drag = None;
    }

    // ----- window operations -------------------------------------------------

    fn toggle_zoom(&mut self, i: usize) {
        let (cols, rows) = (self.cols, self.rows);
        let desk_h = (rows - 2).max(1);
        let w = &mut self.wins[i];
        if let Some((x, y, ww, hh)) = w.restore.take() {
            w.x = x;
            w.y = y;
            w.w = ww;
            w.h = hh;
            fit(w, cols, rows);
        } else {
            w.restore = Some((w.x, w.y, w.w, w.h));
            w.x = 0;
            w.y = 1;
            w.w = cols.max(1);
            w.h = desk_h;
        }
    }

    fn zoom_focused(&mut self) {
        if let Some(i) = self.focused() {
            self.toggle_zoom(i);
        }
    }

    fn close_focused(&mut self) {
        self.wins.pop();
    }

    /// Moves the bottom window to the top, so F6 cycles through the stack.
    fn cycle(&mut self) {
        if self.wins.len() > 1 {
            self.wins.rotate_left(1);
        }
    }

    fn tile(&mut self) {
        let n = self.wins.len() as i32;
        if n == 0 {
            return;
        }
        let (cols, rows) = (self.cols, self.rows);
        let dw = cols.max(1);
        let dh = (rows - 2).max(1);
        let mut c = 1;
        while c * c < n {
            c += 1;
        }
        let r = (n + c - 1) / c;
        let cw = (dw / c).max(1);
        let ch = (dh / r).max(1);
        for (i, w) in self.wins.iter_mut().enumerate() {
            let i = i as i32;
            let (gx, gy) = (i % c, i / c);
            w.restore = None;
            w.x = gx * cw;
            w.y = 1 + gy * ch;
            w.w = if gx == c - 1 { dw - gx * cw } else { cw };
            w.h = if gy == r - 1 { dh - gy * ch } else { ch };
            fit(w, cols, rows);
        }
    }

    fn cascade(&mut self) {
        let n = self.wins.len() as i32;
        if n == 0 {
            return;
        }
        let (cols, rows) = (self.cols, self.rows);
        let dw = cols.max(1);
        let dh = (rows - 2).max(1);
        let w_new = clamp_i(dw * 2 / 3, MIN_W.min(dw), dw);
        let h_new = clamp_i(dh * 2 / 3, MIN_H.min(dh), dh);
        for (i, w) in self.wins.iter_mut().enumerate() {
            let i = i as i32;
            w.restore = None;
            w.w = w_new;
            w.h = h_new;
            w.x = 2 * i;
            w.y = 1 + i;
            fit(w, cols, rows);
        }
    }

    fn exec(&mut self, action: Action) {
        match action {
            Action::Zoom => self.zoom_focused(),
            Action::Close => self.close_focused(),
            Action::Quit => self.quit = true,
            Action::Tile => self.tile(),
            Action::Cascade => self.cascade(),
            Action::Next => self.cycle(),
            Action::About => self.about = true,
        }
    }

    // ----- keyboard ----------------------------------------------------------

    pub fn on_key(&mut self, key: KeyEvent) {
        if key.kind == KeyEventKind::Release {
            return;
        }
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        if ctrl && key.code == KeyCode::Char('q') {
            self.quit = true;
            return;
        }
        if self.about {
            if matches!(key.code, KeyCode::Enter | KeyCode::Esc) {
                self.about = false;
            }
            return;
        }
        if self.menu.is_some() {
            self.menu_key(key);
            return;
        }
        match key.code {
            KeyCode::F(10) => self.menu = Some(OpenMenu { menu: 0, item: 0 }),
            KeyCode::F(5) => self.zoom_focused(),
            KeyCode::F(6) => self.cycle(),
            KeyCode::Char('w') if ctrl => self.close_focused(),
            _ => self.route_key(key),
        }
    }

    fn route_key(&mut self, key: KeyEvent) {
        let Some(i) = self.focused() else { return };
        match self.wins[i].kind {
            Kind::Notes => self.notes_key(key),
            Kind::Calc => self.calc_key(key),
            Kind::Files => self.files_key(key),
        }
    }

    fn notes_key(&mut self, key: KeyEvent) {
        let plain = !key.modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT);
        let n = &mut self.notes;
        match key.code {
            KeyCode::Char(ch) if plain => n.insert(ch),
            KeyCode::Enter => n.newline(),
            KeyCode::Backspace => n.backspace(),
            KeyCode::Delete => n.delete(),
            KeyCode::Left => n.left(),
            KeyCode::Right => n.right(),
            KeyCode::Up => n.up(),
            KeyCode::Down => n.down(),
            KeyCode::Home => n.home(),
            KeyCode::End => n.end(),
            _ => {}
        }
    }

    fn calc_key(&mut self, key: KeyEvent) {
        let plain = !key.modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT);
        let k = match key.code {
            KeyCode::Char(ch) if plain => match ch {
                '0'..='9' => CalcKey::Digit(ch),
                '.' => CalcKey::Dot,
                '+' => CalcKey::Op(Op::Add),
                '-' => CalcKey::Op(Op::Sub),
                '*' => CalcKey::Op(Op::Mul),
                '/' => CalcKey::Op(Op::Div),
                '=' => CalcKey::Equals,
                'c' | 'C' => CalcKey::Clear,
                _ => return,
            },
            KeyCode::Enter => CalcKey::Equals,
            KeyCode::Backspace => CalcKey::Backspace,
            _ => return,
        };
        self.calc.press(k);
    }

    fn files_key(&mut self, key: KeyEvent) {
        let page = self.files.view_h.max(1) as i64;
        match key.code {
            KeyCode::Up => self.files.move_by(-1),
            KeyCode::Down => self.files.move_by(1),
            KeyCode::PageUp => self.files.move_by(-page),
            KeyCode::PageDown => self.files.move_by(page),
            KeyCode::Home => self.files.select(0),
            KeyCode::End => self.files.select(usize::MAX),
            _ => {}
        }
    }

    fn menu_key(&mut self, key: KeyEvent) {
        let Some(mut m) = self.menu else { return };
        let n = MENUS.len();
        match key.code {
            KeyCode::Esc | KeyCode::F(10) => self.menu = None,
            KeyCode::Left => self.menu = Some(OpenMenu { menu: (m.menu + n - 1) % n, item: 0 }),
            KeyCode::Right => self.menu = Some(OpenMenu { menu: (m.menu + 1) % n, item: 0 }),
            KeyCode::Up | KeyCode::Down => {
                let len = MENUS[m.menu].items.len();
                m.item = if key.code == KeyCode::Up {
                    (m.item + len - 1) % len
                } else {
                    (m.item + 1) % len
                };
                self.menu = Some(m);
            }
            KeyCode::Enter => {
                let action = MENUS[m.menu].items[m.item].2;
                self.menu = None;
                self.exec(action);
            }
            _ => {}
        }
    }

    // ----- mouse -------------------------------------------------------------

    pub fn on_mouse(&mut self, ev: MouseEvent) {
        let col = ev.column as i32;
        let row = ev.row as i32;
        match ev.kind {
            MouseEventKind::Down(MouseButton::Left) => self.mouse_down(col, row),
            MouseEventKind::Drag(MouseButton::Left) => self.mouse_drag(col, row),
            MouseEventKind::Up(_) => self.drag = None,
            _ => {}
        }
    }

    fn menu_at(&self, col: i32) -> Option<usize> {
        menu_spans().iter().position(|&(x0, x1)| col >= x0 && col < x1)
    }

    fn menu_mouse(&mut self, col: i32, row: i32) {
        let Some(open) = self.menu else { return };
        if row == 0 {
            self.menu = match self.menu_at(col) {
                Some(m) if m != open.menu => Some(OpenMenu { menu: m, item: 0 }),
                _ => None,
            };
            return;
        }
        let (x, y, w, h) = self.dropdown_rect(open.menu);
        if col >= x && col < x + w && row >= y && row < y + h {
            let item = row - y - 1;
            if item >= 0 && (item as usize) < MENUS[open.menu].items.len() {
                let action = MENUS[open.menu].items[item as usize].2;
                self.menu = None;
                self.exec(action);
            }
            return;
        }
        self.menu = None;
    }

    fn mouse_down(&mut self, col: i32, row: i32) {
        if self.about {
            let (x, y, w, _) = self.about_rect();
            let bx = x + (w - 6) / 2;
            if row == y + 6 && col >= bx && col < bx + 6 {
                self.about = false;
            }
            return;
        }
        if self.menu.is_some() {
            self.menu_mouse(col, row);
            return;
        }
        if row == 0 {
            if let Some(m) = self.menu_at(col) {
                self.menu = Some(OpenMenu { menu: m, item: 0 });
            }
            return;
        }
        if row == self.rows - 1 {
            if let Some(&(idx, _, _)) =
                self.taskbar_items().iter().find(|(_, x0, x1)| col >= *x0 && col < *x1)
            {
                self.raise(idx);
            }
            return;
        }
        let Some(idx) = self.top_window_at(col, row) else { return };
        let win = self.wins[idx].clone();
        match region_of(&win, col, row) {
            Region::Close => {
                self.wins.remove(idx);
            }
            Region::Max => {
                let i = self.raise(idx);
                self.toggle_zoom(i);
            }
            Region::Title => {
                let now = Instant::now();
                let double = matches!(
                    self.last_title_click,
                    Some((t, r)) if r == row && now.duration_since(t).as_millis() <= DOUBLE_CLICK_MS
                );
                let i = self.raise(idx);
                if double {
                    self.last_title_click = None;
                    self.toggle_zoom(i);
                } else {
                    self.last_title_click = Some((now, row));
                    if !win.zoomed() {
                        self.drag = Some(Drag::Move { id: win.id, dx: col - win.x, dy: row - win.y });
                    }
                }
            }
            Region::Resize => {
                self.raise(idx);
                if !win.zoomed() {
                    self.drag = Some(Drag::Resize { id: win.id });
                }
            }
            Region::Content(rx, ry) => {
                let i = self.raise(idx);
                self.content_click(i, rx, ry, win.w - 2, win.h - 2);
            }
            Region::Border => {
                self.raise(idx);
            }
        }
    }

    fn content_click(&mut self, i: usize, rx: i32, ry: i32, cw: i32, ch: i32) {
        match self.wins[i].kind {
            Kind::Notes => self.notes.click(rx, ry),
            Kind::Calc => {
                let lay = calc::layout(cw, ch);
                if let Some(b) = lay
                    .buttons
                    .iter()
                    .find(|b| rx >= b.x && rx < b.x + b.w && ry >= b.y && ry < b.y + b.h)
                {
                    self.calc.press(b.key);
                }
            }
            Kind::Files => {
                if ry >= 1 {
                    self.files.click_row((ry - 1) as usize);
                }
            }
        }
    }

    fn mouse_drag(&mut self, col: i32, row: i32) {
        let Some(d) = self.drag else { return };
        let (cols, rows) = (self.cols, self.rows);
        match d {
            Drag::Move { id, dx, dy } => {
                if let Some(w) = self.wins.iter_mut().find(|w| w.id == id) {
                    // Keep at least 8 columns of the frame and the title row on the desktop.
                    w.x = clamp_i(col - dx, -(w.w - 8), cols - 8);
                    w.y = clamp_i(row - dy, 1, rows - 2);
                }
            }
            Drag::Resize { id } => {
                if let Some(w) = self.wins.iter_mut().find(|w| w.id == id) {
                    let max_w = (cols - w.x).max(1);
                    let max_h = (rows - 1 - w.y).max(1);
                    w.w = clamp_i(col - w.x + 1, MIN_W.min(max_w), max_w);
                    w.h = clamp_i(row - w.y + 1, MIN_H.min(max_h), max_h);
                }
            }
        }
    }
}
