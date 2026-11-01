use ratatui::{
    Frame,
    buffer::Buffer,
    layout::Position,
    style::{Color, Modifier, Style},
};

use crate::app::{App, CLOCK, Kind, MENUS, Win, menu_spans};
use crate::calc::{self, Calc};
use crate::data::{FileList, human_size};
use crate::notes::Notes;

const DESK_BG: Color = Color::Rgb(0, 40, 104);
const DESK_PAT: Color = Color::Rgb(0, 68, 152);
const SHADOW: Color = Color::Rgb(0, 14, 40);
const MENU_BG: Color = Color::Rgb(206, 206, 206);
const TEAL: Color = Color::Rgb(0, 118, 122);
const WHITE: Color = Color::Rgb(255, 255, 255);
const BLACK: Color = Color::Rgb(0, 0, 0);
const TASK_BG: Color = Color::Rgb(26, 30, 44);
const TASK_ITEM_BG: Color = Color::Rgb(56, 60, 76);
const TASK_FG: Color = Color::Rgb(196, 202, 216);
const BODY_FOCUS: Color = Color::Rgb(192, 192, 192);
const BODY_DIM: Color = Color::Rgb(144, 144, 152);
const DIM_TEXT: Color = Color::Rgb(70, 70, 80);
const DIM_FRAME: Color = Color::Rgb(116, 116, 124);
const TITLE_DIM_BG: Color = Color::Rgb(96, 100, 112);
const TITLE_DIM_FG: Color = Color::Rgb(192, 194, 202);
const HEADER_BG: Color = Color::Rgb(168, 168, 178);
const SEL_DIM_BG: Color = Color::Rgb(150, 150, 160);
const DIR_FG: Color = Color::Rgb(0, 40, 120);
const LCD_BG: Color = Color::Rgb(18, 26, 22);
const LCD_FG: Color = Color::Rgb(120, 255, 160);
const LCD_DIM: Color = Color::Rgb(78, 116, 90);

type Clip = (i32, i32, i32, i32);
type Rect4 = (i32, i32, i32, i32);

/// Draws into the frame buffer, clipping every write to the current clip rectangle.
/// Coordinates are signed so windows partly off screen are handled safely.
struct Canvas<'a> {
    buf: &'a mut Buffer,
    clip: Clip,
}

impl<'a> Canvas<'a> {
    fn put(&mut self, x: i32, y: i32, ch: char, style: Style) {
        let (x0, y0, x1, y1) = self.clip;
        if x < x0 || y < y0 || x >= x1 || y >= y1 {
            return;
        }
        // Control characters (such as tabs in notes) would disturb the terminal; show a blank.
        let ch = if ch.is_control() { ' ' } else { ch };
        if let Some(cell) = self.buf.cell_mut(Position::new(x as u16, y as u16)) {
            cell.reset();
            cell.set_char(ch);
            cell.set_style(style);
        }
    }

    fn fill(&mut self, x: i32, y: i32, w: i32, h: i32, ch: char, style: Style) {
        for dy in 0..h.max(0) {
            for dx in 0..w.max(0) {
                self.put(x + dx, y + dy, ch, style);
            }
        }
    }

    fn text(&mut self, x: i32, y: i32, s: &str, style: Style) {
        for (i, ch) in s.chars().enumerate() {
            self.put(x + i as i32, y, ch, style);
        }
    }

    fn centered(&mut self, x: i32, w: i32, y: i32, s: &str, style: Style) {
        let n = s.chars().count() as i32;
        self.text(x + (w - n) / 2, y, s, style);
    }

    fn right_aligned(&mut self, x: i32, w: i32, y: i32, s: &str, style: Style) {
        let n = s.chars().count();
        let skip = n.saturating_sub(w.max(0) as usize);
        let shown: String = s.chars().skip(skip).collect();
        let start = x + (w - shown.chars().count() as i32).max(0);
        self.text(start, y, &shown, style);
    }

    /// Intersects the clip with a rectangle; returns the previous clip to restore.
    fn push_clip(&mut self, x: i32, y: i32, w: i32, h: i32) -> Clip {
        let old = self.clip;
        self.clip = (old.0.max(x), old.1.max(y), old.2.min(x + w), old.3.min(y + h));
        old
    }
}

pub fn draw(frame: &mut Frame, app: &mut App) {
    let area = frame.area();
    let cols = area.width as i32;
    let rows = area.height as i32;
    if cols != app.cols || rows != app.rows {
        app.on_resize(cols, rows);
    }
    let mut c = Canvas { buf: frame.buffer_mut(), clip: (0, 0, cols, rows) };
    if cols < 12 || rows < 5 {
        c.text(0, 0, "Terminal too small", Style::new().fg(WHITE).bg(BLACK));
        return;
    }
    c.fill(0, 1, cols, rows - 2, '░', Style::new().fg(DESK_PAT).bg(DESK_BG));
    let top = app.wins.len().checked_sub(1);
    for i in 0..app.wins.len() {
        let win = app.wins[i].clone();
        draw_window(&mut c, app, &win, Some(i) == top);
    }
    draw_taskbar(&mut c, app);
    draw_menubar(&mut c, app);
    draw_dropdown(&mut c, app);
    draw_about(&mut c, app);
}

fn shadow(c: &mut Canvas, x: i32, y: i32, w: i32, h: i32) {
    c.fill(x + w, y + 1, 2, h, ' ', Style::new().bg(SHADOW));
    c.fill(x + 2, y + h, w, 1, ' ', Style::new().bg(SHADOW));
}

/// Draws a single or double line box border over the edges of a rectangle.
fn frame_box(c: &mut Canvas, x: i32, y: i32, w: i32, h: i32, double: bool, st: Style) {
    let (tl, tr, bl, br, hz, vt) = if double {
        ('╔', '╗', '╚', '╝', '═', '║')
    } else {
        ('┌', '┐', '└', '┘', '─', '│')
    };
    c.put(x, y, tl, st);
    c.put(x + w - 1, y, tr, st);
    c.put(x, y + h - 1, bl, st);
    c.put(x + w - 1, y + h - 1, br, st);
    c.fill(x + 1, y, w - 2, 1, hz, st);
    c.fill(x + 1, y + h - 1, w - 2, 1, hz, st);
    c.fill(x, y + 1, 1, h - 2, vt, st);
    c.fill(x + w - 1, y + 1, 1, h - 2, vt, st);
}

fn draw_window(c: &mut Canvas, app: &mut App, win: &Win, focused: bool) {
    let (x, y, w, h) = (win.x, win.y, win.w, win.h);
    if w < 3 || h < 3 {
        return;
    }
    shadow(c, x, y, w, h);

    let body = if focused {
        Style::new().fg(BLACK).bg(BODY_FOCUS)
    } else {
        Style::new().fg(DIM_TEXT).bg(BODY_DIM)
    };
    let frame_st = if focused {
        Style::new().fg(BLACK).bg(BODY_FOCUS)
    } else {
        Style::new().fg(DIM_FRAME).bg(BODY_DIM)
    };
    let title_st = if focused {
        Style::new().fg(WHITE).bg(TEAL).bold()
    } else {
        Style::new().fg(TITLE_DIM_FG).bg(TITLE_DIM_BG)
    };

    c.fill(x, y, w, h, ' ', body);
    frame_box(c, x, y, w, h, focused, frame_st);

    // Title bar: the top border row.
    c.fill(x, y, w, 1, ' ', title_st);
    c.put(x, y, if focused { '╔' } else { '┌' }, title_st);
    c.put(x + w - 1, y, if focused { '╗' } else { '┐' }, title_st);
    let avail = (w - 8).max(0);
    let title = format!(" {} ", win.title());
    let tlen = title.chars().count() as i32;
    if tlen <= avail {
        c.text(x + 4 + (avail - tlen) / 2, y, &title, title_st);
    } else {
        let short: String = title.chars().take(avail.max(0) as usize).collect();
        c.text(x + 4, y, &short, title_st);
    }
    c.text(x + 1, y, "[×]", title_st.bold());
    c.text(x + w - 4, y, "[↑]", title_st.bold());

    // Bottom-right resize handle.
    let handle = match (win.zoomed(), focused) {
        (true, true) => '╝',
        (true, false) => '┘',
        (false, _) => '◢',
    };
    c.put(x + w - 1, y + h - 1, handle, frame_st);

    // Content.
    let (ix, iy, iw, ih) = (x + 1, y + 1, w - 2, h - 2);
    if iw > 0 && ih > 0 {
        let old = c.push_clip(ix, iy, iw, ih);
        match win.kind {
            Kind::Notes => draw_notes(c, &mut app.notes, (ix, iy, iw, ih), focused, body),
            Kind::Calc => draw_calc(c, &app.calc, (ix, iy, iw, ih)),
            Kind::Files => draw_files(c, &mut app.files, (ix, iy, iw, ih), focused, body),
        }
        c.clip = old;
    }
}

fn draw_notes(c: &mut Canvas, notes: &mut Notes, (x, y, w, h): Rect4, focused: bool, body: Style) {
    notes.ensure_visible(w as usize, h as usize);
    for ry in 0..h {
        let li = notes.scroll_y + ry as usize;
        let Some(line) = notes.lines.get(li) else { break };
        for rx in 0..w {
            let ci = notes.scroll_x + rx as usize;
            let ch = line.get(ci).copied().unwrap_or(' ');
            let mut st = body;
            if focused && li == notes.row && ci == notes.col {
                st = st.add_modifier(Modifier::REVERSED);
            }
            c.put(x + rx, y + ry, ch, st);
        }
    }
}

fn calc_colors(label: &str) -> (Color, Color, Color) {
    match label {
        "C" => (WHITE, Color::Rgb(222, 92, 92), Color::Rgb(150, 52, 52)),
        "=" => (WHITE, Color::Rgb(0, 148, 138), Color::Rgb(0, 94, 90)),
        "÷" | "×" | "−" | "+" => (BLACK, Color::Rgb(255, 168, 70), Color::Rgb(186, 110, 40)),
        _ => (BLACK, Color::Rgb(228, 228, 234), Color::Rgb(158, 158, 166)),
    }
}

fn draw_calc(c: &mut Canvas, calc: &Calc, (x, y, w, h): Rect4) {
    let lay = calc::layout(w, h);
    c.fill(x, y, w, lay.display_h, ' ', Style::new().bg(LCD_BG));
    if lay.display_h >= 2 {
        let expr = calc.expression();
        c.right_aligned(x, w, y, &expr, Style::new().fg(LCD_DIM).bg(LCD_BG));
    }
    let lcd = Style::new().fg(LCD_FG).bg(LCD_BG).bold();
    c.right_aligned(x, w, y + lay.display_h - 1, calc.entry(), lcd);
    for b in &lay.buttons {
        let (fg, face, shade) = calc_colors(b.label);
        let top = Style::new().fg(fg).bg(face).bold();
        c.fill(x + b.x, y + b.y, b.w, b.h, ' ', top);
        if b.h >= 2 {
            c.fill(x + b.x, y + b.y + b.h - 1, b.w, 1, ' ', Style::new().bg(shade));
        }
        let lw = b.label.chars().count() as i32;
        c.text(x + b.x + (b.w - lw) / 2, y + b.y, b.label, top);
    }
}

/// Formats one row of the Files list into exactly `w` characters.
fn file_row(name: &str, is_dir: bool, size: &str, date: &str, w: usize) -> String {
    let show_date = w >= 40;
    let size_w = 9usize;
    let date_w = 16usize;
    let tail = size_w + if show_date { 2 + date_w } else { 0 };
    let name_w = w.saturating_sub(2 + 1 + tail);
    let mut s = String::new();
    s.push_str(if is_dir { "▸ " } else { "  " });
    s.push_str(&pad(name, name_w));
    s.push(' ');
    s.push_str(&format!("{:>w$}", size, w = size_w));
    if show_date {
        s.push_str("  ");
        s.push_str(&pad(date, date_w));
    }
    pad(&s, w)
}

fn pad(s: &str, n: usize) -> String {
    let mut out: String = s.chars().take(n).collect();
    let len = out.chars().count();
    for _ in len..n {
        out.push(' ');
    }
    out
}

fn draw_files(c: &mut Canvas, list: &mut FileList, (x, y, w, h): Rect4, focused: bool, body: Style) {
    let view = (h - 1).max(0) as usize;
    list.ensure_visible(view);
    let hdr = Style::new().fg(BLACK).bg(HEADER_BG).bold();
    c.fill(x, y, w, 1, ' ', hdr);
    c.text(x, y, &file_row("Name", false, "Size", "Modified", w as usize), hdr);
    if list.entries.is_empty() {
        c.text(x + 2, y + 1, "(empty folder)", body);
        return;
    }
    for i in 0..view {
        let idx = list.scroll + i;
        let Some(e) = list.entries.get(idx) else { break };
        let row = y + 1 + i as i32;
        let mut st = body;
        if e.is_dir() {
            st = st.fg(DIR_FG).bold();
        }
        if idx == list.sel {
            st = if focused {
                Style::new().fg(WHITE).bg(TEAL).bold()
            } else {
                Style::new().fg(BLACK).bg(SEL_DIM_BG)
            };
        }
        c.fill(x, row, w, 1, ' ', st);
        let size = if e.is_dir() { "<DIR>".to_string() } else { human_size(e.size) };
        c.text(x, row, &file_row(&e.name, e.is_dir(), &size, &e.modified, w as usize), st);
    }
}

fn draw_taskbar(c: &mut Canvas, app: &App) {
    let row = app.rows - 1;
    c.fill(0, row, app.cols, 1, ' ', Style::new().bg(TASK_BG));
    for (idx, x0, x1) in app.taskbar_items() {
        let st = if idx + 1 == app.wins.len() {
            Style::new().fg(WHITE).bg(TEAL).bold()
        } else {
            Style::new().fg(TASK_FG).bg(TASK_ITEM_BG)
        };
        c.fill(x0, row, x1 - x0, 1, ' ', st);
        c.text(x0 + 1, row, app.wins[idx].title(), st);
    }
}

fn draw_menubar(c: &mut Canvas, app: &App) {
    let base = Style::new().fg(BLACK).bg(MENU_BG);
    c.fill(0, 0, app.cols, 1, ' ', base);
    for (i, (x0, x1)) in menu_spans().into_iter().enumerate() {
        let open = app.menu.map(|m| m.menu) == Some(i);
        let st = if open { Style::new().fg(WHITE).bg(TEAL).bold() } else { base };
        c.fill(x0, 0, x1 - x0, 1, ' ', st);
        c.text(x0 + 1, 0, MENUS[i].title, st);
    }
    let clock = format!(" {} ", CLOCK);
    c.text(app.cols - clock.chars().count() as i32, 0, &clock, base);
}

fn draw_dropdown(c: &mut Canvas, app: &App) {
    let Some(om) = app.menu else { return };
    let (x, y, w, h) = app.dropdown_rect(om.menu);
    shadow(c, x, y, w, h);
    let base = Style::new().fg(BLACK).bg(MENU_BG);
    c.fill(x, y, w, h, ' ', base);
    frame_box(c, x, y, w, h, false, base);
    for (i, (label, shortcut, _)) in MENUS[om.menu].items.iter().enumerate() {
        let row = y + 1 + i as i32;
        let st = if i == om.item { Style::new().fg(WHITE).bg(TEAL).bold() } else { base };
        c.fill(x + 1, row, w - 2, 1, ' ', st);
        c.text(x + 2, row, label, st);
        let sw = shortcut.chars().count() as i32;
        c.text(x + w - 2 - sw, row, shortcut, st);
    }
}

fn draw_about(c: &mut Canvas, app: &App) {
    if !app.about {
        return;
    }
    let (x, y, w, h) = app.about_rect();
    shadow(c, x, y, w, h);
    let base = Style::new().fg(BLACK).bg(MENU_BG);
    c.fill(x, y, w, h, ' ', base);
    frame_box(c, x, y, w, h, true, base);
    c.text(x + (w - 7) / 2, y, " About ", base.bold());
    c.centered(x, w, y + 1, "Desktop 1.0", base.bold());
    c.centered(x, w, y + 2, "A text-mode window desktop", base);
    c.centered(x, w, y + 4, "F10 opens the menus", base);
    c.text(x + (w - 6) / 2, y + 6, "[ OK ]", Style::new().fg(WHITE).bg(TEAL).bold());
}
