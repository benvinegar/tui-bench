use std::io;

use crossterm::{
    event::{
        self, DisableMouseCapture, EnableMouseCapture, Event, KeyCode, KeyEvent, KeyEventKind,
        KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
    },
    execute,
};
use ratatui::{
    DefaultTerminal, Frame,
    buffer::Buffer,
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, BorderType, Clear, Paragraph, Widget},
};

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

const BG_CANVAS: Color = Color::Rgb(17, 19, 26);
const BG_BAR: Color = Color::Rgb(32, 35, 46);
const BG_BAR_ALT: Color = Color::Rgb(44, 48, 62);
const FG_BAR: Color = Color::Rgb(190, 196, 214);
const FG_DIM: Color = Color::Rgb(110, 116, 138);
const FG_FAINT: Color = Color::Rgb(62, 67, 84);
const ACCENT: Color = Color::Rgb(122, 162, 255);
const ACCENT_DARK: Color = Color::Rgb(10, 14, 28);
const SEL_BG: Color = Color::Rgb(46, 58, 92);
const HANDLE: Color = Color::Rgb(255, 184, 76);

const COLORS: [Color; 6] = [
    Color::Rgb(232, 234, 240),
    Color::Rgb(255, 99, 99),
    Color::Rgb(250, 208, 84),
    Color::Rgb(118, 220, 128),
    Color::Rgb(86, 212, 232),
    Color::Rgb(222, 122, 236),
];
const COLOR_NAMES: [&str; 6] = ["white", "red", "yellow", "green", "cyan", "magenta"];

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Tool {
    Select,
    Box,
    Arrow,
    Text,
    Pen,
}

const TOOLS: [Tool; 5] = [Tool::Select, Tool::Box, Tool::Arrow, Tool::Text, Tool::Pen];

impl Tool {
    fn key(self) -> char {
        match self {
            Tool::Select => 'v',
            Tool::Box => 'b',
            Tool::Arrow => 'a',
            Tool::Text => 't',
            Tool::Pen => 'p',
        }
    }
    fn name(self) -> &'static str {
        match self {
            Tool::Select => "Select",
            Tool::Box => "Box",
            Tool::Arrow => "Arrow",
            Tool::Text => "Text",
            Tool::Pen => "Pen",
        }
    }
    fn hint(self) -> &'static str {
        match self {
            Tool::Select => "click an object to select · drag to move",
            Tool::Box => "drag corner to corner to draw a box",
            Tool::Arrow => "drag from start to end to draw an arrow",
            Tool::Text => "click a cell to place text",
            Tool::Pen => "drag to paint freehand",
        }
    }
}

#[derive(Clone, Debug)]
enum Kind {
    Rect { x0: i32, y0: i32, x1: i32, y1: i32 },
    Arrow { sx: i32, sy: i32, ex: i32, ey: i32 },
    Text { x: i32, y: i32, s: String },
    Pen { cells: Vec<(i32, i32)> },
}

#[derive(Clone, Debug)]
struct Obj {
    id: u64,
    color: usize,
    kind: Kind,
}

impl Kind {
    fn type_name(&self) -> &'static str {
        match self {
            Kind::Rect { .. } => "Box",
            Kind::Arrow { .. } => "Arrow",
            Kind::Text { .. } => "Text",
            Kind::Pen { .. } => "Pen",
        }
    }

    fn cells(&self) -> Vec<(i32, i32, char)> {
        let mut out = Vec::new();
        match self {
            Kind::Rect { x0, y0, x1, y1 } => {
                let (x0, y0, x1, y1) = (*x0, *y0, *x1, *y1);
                if x0 == x1 && y0 == y1 {
                    out.push((x0, y0, '□'));
                } else if y0 == y1 {
                    for x in x0..=x1 {
                        let c = if x == x0 {
                            '╶'
                        } else if x == x1 {
                            '╴'
                        } else {
                            '─'
                        };
                        out.push((x, y0, c));
                    }
                } else if x0 == x1 {
                    for y in y0..=y1 {
                        let c = if y == y0 {
                            '╷'
                        } else if y == y1 {
                            '╵'
                        } else {
                            '│'
                        };
                        out.push((x0, y, c));
                    }
                } else {
                    for x in x0..=x1 {
                        let (t, b) = if x == x0 {
                            ('┌', '└')
                        } else if x == x1 {
                            ('┐', '┘')
                        } else {
                            ('─', '─')
                        };
                        out.push((x, y0, t));
                        out.push((x, y1, b));
                    }
                    for y in (y0 + 1)..y1 {
                        out.push((x0, y, '│'));
                        out.push((x1, y, '│'));
                    }
                }
            }
            Kind::Arrow { sx, sy, ex, ey } => {
                let (sx, sy, ex, ey) = (*sx, *sy, *ex, *ey);
                if sx == ex && sy == ey {
                    out.push((ex, ey, '▶'));
                } else if sy == ey {
                    let dir = (ex - sx).signum();
                    let mut x = sx;
                    while x != ex {
                        out.push((x, sy, '─'));
                        x += dir;
                    }
                    out.push((ex, ey, if dir > 0 { '▶' } else { '◀' }));
                } else if sx == ex {
                    let dir = (ey - sy).signum();
                    let mut y = sy;
                    while y != ey {
                        out.push((sx, y, '│'));
                        y += dir;
                    }
                    out.push((ex, ey, if dir > 0 { '▼' } else { '▲' }));
                } else {
                    let dx = (ex - sx).signum();
                    let dy = (ey - sy).signum();
                    let mut x = sx;
                    while x != ex {
                        out.push((x, sy, '─'));
                        x += dx;
                    }
                    let corner = match (dx > 0, dy > 0) {
                        (true, true) => '┐',
                        (true, false) => '┘',
                        (false, true) => '┌',
                        (false, false) => '└',
                    };
                    out.push((ex, sy, corner));
                    let mut y = sy + dy;
                    while y != ey {
                        out.push((ex, y, '│'));
                        y += dy;
                    }
                    out.push((ex, ey, if dy > 0 { '▼' } else { '▲' }));
                }
            }
            Kind::Text { x, y, s } => {
                for (i, c) in s.chars().enumerate() {
                    out.push((x + i as i32, *y, c));
                }
            }
            Kind::Pen { cells } => {
                for &(x, y) in cells {
                    out.push((x, y, '█'));
                }
            }
        }
        out
    }

    fn bounds(&self) -> (i32, i32, i32, i32) {
        match self {
            Kind::Rect { x0, y0, x1, y1 } => (*x0, *y0, *x1, *y1),
            Kind::Arrow { sx, sy, ex, ey } => {
                (*sx.min(ex), *sy.min(ey), *sx.max(ex), *sy.max(ey))
            }
            Kind::Text { x, y, s } => {
                let n = s.chars().count().max(1) as i32;
                (*x, *y, x + n - 1, *y)
            }
            Kind::Pen { cells } => {
                let mut b = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
                for &(x, y) in cells {
                    b.0 = b.0.min(x);
                    b.1 = b.1.min(y);
                    b.2 = b.2.max(x);
                    b.3 = b.3.max(y);
                }
                if cells.is_empty() { (0, 0, 0, 0) } else { b }
            }
        }
    }

    fn translate(&mut self, dx: i32, dy: i32) {
        match self {
            Kind::Rect { x0, y0, x1, y1 } => {
                *x0 += dx;
                *x1 += dx;
                *y0 += dy;
                *y1 += dy;
            }
            Kind::Arrow { sx, sy, ex, ey } => {
                *sx += dx;
                *ex += dx;
                *sy += dy;
                *ey += dy;
            }
            Kind::Text { x, y, .. } => {
                *x += dx;
                *y += dy;
            }
            Kind::Pen { cells } => {
                for c in cells.iter_mut() {
                    c.0 += dx;
                    c.1 += dy;
                }
            }
        }
    }

    fn hit(&self, px: i32, py: i32) -> bool {
        let (a, b, c, d) = self.bounds();
        if px < a || px > c || py < b || py > d {
            return false;
        }
        self.cells().iter().any(|&(x, y, _)| x == px && y == py)
    }
}

fn describe(kind: &Kind) -> String {
    let (a, b, c, d) = kind.bounds();
    format!(
        "{} {}×{} at {},{}",
        kind.type_name(),
        c - a + 1,
        d - b + 1,
        a,
        b
    )
}

enum Drag {
    Shape { tool: Tool, sx: i32, sy: i32, cx: i32, cy: i32 },
    Pen { cells: Vec<(i32, i32)>, lx: i32, ly: i32 },
    Move {
        sx: i32,
        sy: i32,
        snapshot: Vec<Obj>,
        ids: Vec<u64>,
        anchor: u64,
        moved: bool,
    },
}

struct TextEdit {
    x: i32,
    y: i32,
    s: String,
}

struct App {
    objects: Vec<Obj>,
    next_id: u64,
    tool: Tool,
    color: usize,
    selected: Option<u64>,
    drag: Option<Drag>,
    editing: Option<TextEdit>,
    undo: Vec<Vec<Obj>>,
    redo: Vec<Vec<Obj>>,
    mouse: Option<(i32, i32)>,
    help: bool,
    width: u16,
    height: u16,
    flash: Option<String>,
    quit: bool,
}

// ---------------------------------------------------------------------------
// Toolbar layout (shared by rendering and click hit-testing)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq)]
enum Hit {
    Tool(Tool),
    Color(usize),
    Help,
}

#[derive(Clone, Copy)]
struct ToolbarStyle {
    title: bool,
    tool_names: bool,
    color_label: bool,
    help: bool,
}

const TOOLBAR_TIERS: [ToolbarStyle; 5] = [
    ToolbarStyle { title: true, tool_names: true, color_label: true, help: true },
    ToolbarStyle { title: false, tool_names: true, color_label: true, help: true },
    ToolbarStyle { title: false, tool_names: true, color_label: false, help: true },
    ToolbarStyle { title: false, tool_names: true, color_label: false, help: false },
    ToolbarStyle { title: false, tool_names: false, color_label: false, help: false },
];

enum Seg {
    Title,
    Gap(u16),
    Sep,
    Tool(Tool, bool),
    ColorLabel,
    Color(usize),
    Help,
}

impl Seg {
    fn width(&self) -> u16 {
        match self {
            Seg::Title => 11,
            Seg::Gap(n) => *n,
            Seg::Sep => 3,
            Seg::Tool(t, names) => {
                if *names {
                    4 + t.name().chars().count() as u16
                } else {
                    3
                }
            }
            Seg::ColorLabel => 6,
            Seg::Color(_) => 4,
            Seg::Help => 8,
        }
    }
    fn hit(&self) -> Option<Hit> {
        match self {
            Seg::Tool(t, _) => Some(Hit::Tool(*t)),
            Seg::Color(i) => Some(Hit::Color(*i)),
            Seg::Help => Some(Hit::Help),
            _ => None,
        }
    }
}

fn toolbar_segments(width: u16) -> Vec<(u16, Seg)> {
    for (ti, st) in TOOLBAR_TIERS.iter().enumerate() {
        let mut segs: Vec<Seg> = Vec::new();
        if st.title {
            segs.push(Seg::Title);
        }
        segs.push(Seg::Gap(1));
        for (i, t) in TOOLS.iter().enumerate() {
            if i > 0 {
                segs.push(Seg::Gap(if st.tool_names && ti < 2 { 1 } else { 0 }));
            }
            segs.push(Seg::Tool(*t, st.tool_names));
        }
        segs.push(Seg::Sep);
        if st.color_label {
            segs.push(Seg::ColorLabel);
        }
        for i in 0..6 {
            segs.push(Seg::Color(i));
        }
        let left: u16 = segs.iter().map(|s| s.width()).sum();
        let help_w = if st.help { Seg::Help.width() + 1 } else { 0 };
        let total = left + help_w;
        if total <= width || ti == TOOLBAR_TIERS.len() - 1 {
            let mut out = Vec::new();
            let mut x = 0u16;
            for s in segs {
                let w = s.width();
                out.push((x, s));
                x = x.saturating_add(w);
            }
            if st.help {
                let hx = width.saturating_sub(Seg::Help.width() + 1);
                out.push((hx.max(x), Seg::Help));
            }
            return out;
        }
    }
    Vec::new()
}

fn toolbar_hit(width: u16, x: u16) -> Option<Hit> {
    for (sx, seg) in toolbar_segments(width) {
        if x >= sx && x < sx + seg.width() {
            return seg.hit();
        }
    }
    None
}

// ---------------------------------------------------------------------------
// App logic
// ---------------------------------------------------------------------------

impl App {
    fn new(width: u16, height: u16) -> Self {
        App {
            objects: Vec::new(),
            next_id: 1,
            tool: Tool::Select,
            color: 0,
            selected: None,
            drag: None,
            editing: None,
            undo: Vec::new(),
            redo: Vec::new(),
            mouse: None,
            help: false,
            width,
            height,
            flash: None,
            quit: false,
        }
    }

    fn canvas_top(&self) -> i32 {
        1
    }
    fn canvas_bottom(&self) -> i32 {
        self.height as i32 - 2
    }
    fn has_canvas(&self) -> bool {
        self.height >= 3 && self.width >= 1
    }

    fn clamp_canvas(&self, x: i32, y: i32) -> (i32, i32) {
        let maxx = (self.width as i32 - 1).max(0);
        let bot = self.canvas_bottom().max(self.canvas_top());
        (x.clamp(0, maxx), y.clamp(self.canvas_top(), bot))
    }

    fn checkpoint(&mut self) {
        self.undo.push(self.objects.clone());
        if self.undo.len() > 500 {
            self.undo.remove(0);
        }
        self.redo.clear();
    }

    fn add_object(&mut self, kind: Kind) {
        self.checkpoint();
        let id = self.next_id;
        self.next_id += 1;
        self.objects.push(Obj { id, color: self.color, kind });
    }

    fn selected_obj(&self) -> Option<&Obj> {
        self.selected
            .and_then(|id| self.objects.iter().find(|o| o.id == id))
    }

    fn validate_selection(&mut self) {
        if let Some(id) = self.selected {
            if !self.objects.iter().any(|o| o.id == id) {
                self.selected = None;
            }
        }
    }

    fn do_undo(&mut self) {
        self.drag = None;
        if let Some(prev) = self.undo.pop() {
            let cur = std::mem::replace(&mut self.objects, prev);
            self.redo.push(cur);
            self.flash = Some("Undo".into());
        } else {
            self.flash = Some("Nothing to undo".into());
        }
        self.validate_selection();
    }

    fn do_redo(&mut self) {
        self.drag = None;
        if let Some(next) = self.redo.pop() {
            let cur = std::mem::replace(&mut self.objects, next);
            self.undo.push(cur);
            self.flash = Some("Redo".into());
        } else {
            self.flash = Some("Nothing to redo".into());
        }
        self.validate_selection();
    }

    fn commit_text(&mut self) {
        if let Some(ed) = self.editing.take() {
            if !ed.s.is_empty() {
                self.add_object(Kind::Text { x: ed.x, y: ed.y, s: ed.s });
            }
        }
    }

    fn set_tool(&mut self, t: Tool) {
        self.commit_text();
        self.finish_drag();
        self.tool = t;
        if t != Tool::Select {
            self.selected = None;
        }
    }

    fn set_color(&mut self, c: usize) {
        self.color = c;
        if let Some(id) = self.selected {
            if let Some(idx) = self.objects.iter().position(|o| o.id == id) {
                if self.objects[idx].color != c {
                    self.checkpoint();
                    self.objects[idx].color = c;
                }
            }
        }
    }

    fn delete_selected(&mut self) {
        if let Some(id) = self.selected {
            if let Some(idx) = self.objects.iter().position(|o| o.id == id) {
                self.checkpoint();
                self.objects.remove(idx);
                self.flash = Some("Deleted".into());
            }
            self.selected = None;
        }
    }

    fn hit_test(&self, x: i32, y: i32) -> Option<u64> {
        self.objects
            .iter()
            .rev()
            .find(|o| o.kind.hit(x, y))
            .map(|o| o.id)
    }

    fn handle_key(&mut self, key: KeyEvent) {
        if key.kind == KeyEventKind::Release {
            return;
        }
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        let alt = key.modifiers.contains(KeyModifiers::ALT);
        self.flash = None;

        if ctrl {
            if let KeyCode::Char(c) = key.code {
                match c.to_ascii_lowercase() {
                    'q' => {
                        self.quit = true;
                        return;
                    }
                    'z' => {
                        self.commit_text();
                        if key.modifiers.contains(KeyModifiers::SHIFT) {
                            self.do_redo();
                        } else {
                            self.do_undo();
                        }
                        return;
                    }
                    'y' => {
                        self.commit_text();
                        self.do_redo();
                        return;
                    }
                    _ => return,
                }
            }
        }

        // Text editing captures everything else.
        if let Some(ed) = self.editing.as_mut() {
            match key.code {
                KeyCode::Char(c) if !alt => ed.s.push(c),
                KeyCode::Backspace => {
                    ed.s.pop();
                }
                KeyCode::Enter | KeyCode::Esc => self.commit_text(),
                _ => {}
            }
            return;
        }

        if self.help {
            match key.code {
                KeyCode::Char('?') | KeyCode::Esc | KeyCode::Enter | KeyCode::Char('q') => {
                    self.help = false
                }
                _ => {}
            }
            return;
        }

        match key.code {
            KeyCode::Char('?') => self.help = true,
            KeyCode::Char(c) if !alt => match c {
                'v' => self.set_tool(Tool::Select),
                'b' => self.set_tool(Tool::Box),
                'a' => self.set_tool(Tool::Arrow),
                't' => self.set_tool(Tool::Text),
                'p' => self.set_tool(Tool::Pen),
                '1'..='6' => self.set_color(c as usize - '1' as usize),
                _ => {}
            },
            KeyCode::Esc => {
                if let Some(Drag::Move { snapshot, .. }) = self.drag.take() {
                    self.objects = snapshot;
                }
                self.drag = None;
                self.selected = None;
            }
            KeyCode::Delete | KeyCode::Backspace => self.delete_selected(),
            _ => {}
        }
    }

    fn handle_mouse(&mut self, m: MouseEvent) {
        let (mx, my) = (m.column as i32, m.row as i32);
        let in_canvas = self.has_canvas() && my >= self.canvas_top() && my <= self.canvas_bottom();
        if in_canvas {
            self.mouse = Some((mx, my));
        }

        match m.kind {
            MouseEventKind::Down(MouseButton::Left) => {
                self.flash = None;
                if self.help {
                    self.help = false;
                    return;
                }
                // A press while a drag is still open means we missed the release.
                self.finish_drag();
                if my == 0 {
                    self.commit_text();
                    match toolbar_hit(self.width, m.column) {
                        Some(Hit::Tool(t)) => self.set_tool(t),
                        Some(Hit::Color(c)) => self.set_color(c),
                        Some(Hit::Help) => self.help = true,
                        None => {}
                    }
                    return;
                }
                if !in_canvas {
                    return;
                }
                self.press(mx, my);
            }
            MouseEventKind::Drag(MouseButton::Left) => {
                if self.drag.is_some() {
                    let (cx, cy) = self.clamp_canvas(mx, my);
                    if self.has_canvas() {
                        self.mouse = Some((cx, cy));
                    }
                    self.drag_to(cx, cy);
                }
            }
            MouseEventKind::Up(_) => {
                if self.drag.is_some() {
                    let (cx, cy) = self.clamp_canvas(mx, my);
                    self.drag_to(cx, cy);
                    self.finish_drag();
                }
            }
            _ => {}
        }
    }

    fn press(&mut self, x: i32, y: i32) {
        match self.tool {
            Tool::Select => {
                if let Some(id) = self.hit_test(x, y) {
                    self.selected = Some(id);
                    let mut ids = vec![id];
                    let obj = self.objects.iter().find(|o| o.id == id).unwrap();
                    if let Kind::Rect { x0, y0, x1, y1 } = obj.kind {
                        for o in &self.objects {
                            if o.id == id {
                                continue;
                            }
                            if let Kind::Text { .. } = o.kind {
                                let (a, b, c, d) = o.kind.bounds();
                                if a >= x0 && c <= x1 && b >= y0 && d <= y1 {
                                    ids.push(o.id);
                                }
                            }
                        }
                    }
                    self.drag = Some(Drag::Move {
                        sx: x,
                        sy: y,
                        snapshot: self.objects.clone(),
                        ids,
                        anchor: id,
                        moved: false,
                    });
                } else {
                    self.selected = None;
                }
            }
            Tool::Box | Tool::Arrow => {
                self.drag = Some(Drag::Shape { tool: self.tool, sx: x, sy: y, cx: x, cy: y });
            }
            Tool::Pen => {
                self.drag = Some(Drag::Pen { cells: vec![(x, y)], lx: x, ly: y });
            }
            Tool::Text => {
                self.commit_text();
                self.editing = Some(TextEdit { x, y, s: String::new() });
            }
        }
    }

    fn drag_to(&mut self, x: i32, y: i32) {
        let w = self.width as i32;
        let top = self.canvas_top();
        let bot = self.canvas_bottom();
        let Some(drag) = self.drag.as_mut() else { return };
        match drag {
            Drag::Shape { cx, cy, .. } => {
                *cx = x;
                *cy = y;
            }
            Drag::Pen { cells, lx, ly } => {
                // Bresenham between the last and current position so fast
                // strokes stay continuous.
                let (mut x0, mut y0) = (*lx, *ly);
                let (x1, y1) = (x, y);
                let dx = (x1 - x0).abs();
                let dy = -(y1 - y0).abs();
                let sx = if x0 < x1 { 1 } else { -1 };
                let sy = if y0 < y1 { 1 } else { -1 };
                let mut err = dx + dy;
                loop {
                    if !cells.contains(&(x0, y0)) {
                        cells.push((x0, y0));
                    }
                    if x0 == x1 && y0 == y1 {
                        break;
                    }
                    let e2 = 2 * err;
                    if e2 >= dy {
                        err += dy;
                        x0 += sx;
                    }
                    if e2 <= dx {
                        err += dx;
                        y0 += sy;
                    }
                }
                *lx = x;
                *ly = y;
            }
            Drag::Move { sx, sy, snapshot, ids, anchor, moved } => {
                let mut dx = x - *sx;
                let mut dy = y - *sy;
                // Keep the dragged object on the visible canvas.
                if let Some(a) = snapshot.iter().find(|o| o.id == *anchor) {
                    let (bx0, by0, bx1, by1) = a.kind.bounds();
                    if bx1 - bx0 < w {
                        dx = dx.clamp(-bx0, w - 1 - bx1);
                    }
                    if by1 - by0 <= bot - top {
                        dy = dy.clamp(top - by0, bot - by1);
                    }
                }
                let mut objs = snapshot.clone();
                for o in objs.iter_mut() {
                    if ids.contains(&o.id) {
                        o.kind.translate(dx, dy);
                    }
                }
                *moved = dx != 0 || dy != 0;
                self.objects = objs;
            }
        }
    }

    fn finish_drag(&mut self) {
        let Some(drag) = self.drag.take() else { return };
        match drag {
            Drag::Shape { tool, sx, sy, cx, cy } => {
                if sx == cx && sy == cy {
                    return;
                }
                let kind = if tool == Tool::Box {
                    Kind::Rect { x0: sx.min(cx), y0: sy.min(cy), x1: sx.max(cx), y1: sy.max(cy) }
                } else {
                    Kind::Arrow { sx, sy, ex: cx, ey: cy }
                };
                self.add_object(kind);
            }
            Drag::Pen { cells, .. } => {
                self.add_object(Kind::Pen { cells });
            }
            Drag::Move { snapshot, moved, .. } => {
                if moved {
                    self.undo.push(snapshot);
                    self.redo.clear();
                }
            }
        }
    }

    fn preview(&self) -> Option<(Kind, usize)> {
        match self.drag.as_ref()? {
            Drag::Shape { tool, sx, sy, cx, cy } => {
                let (sx, sy, cx, cy) = (*sx, *sy, *cx, *cy);
                let k = if *tool == Tool::Box {
                    Kind::Rect { x0: sx.min(cx), y0: sy.min(cy), x1: sx.max(cx), y1: sy.max(cy) }
                } else {
                    Kind::Arrow { sx, sy, ex: cx, ey: cy }
                };
                Some((k, self.color))
            }
            Drag::Pen { cells, .. } => Some((Kind::Pen { cells: cells.clone() }, self.color)),
            Drag::Move { .. } => None,
        }
    }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

fn put(buf: &mut Buffer, area: Rect, x: i32, y: i32, ch: char, style: Style) {
    if x < area.x as i32
        || y < area.y as i32
        || x >= (area.x + area.width) as i32
        || y >= (area.y + area.height) as i32
    {
        return;
    }
    if let Some(cell) = buf.cell_mut((x as u16, y as u16)) {
        cell.set_char(ch);
        cell.set_style(style);
    }
}

fn render(app: &App, frame: &mut Frame) {
    let area = frame.area();
    let buf = frame.buffer_mut();
    if area.width == 0 || area.height == 0 {
        return;
    }

    // Canvas
    if area.height >= 3 {
        let canvas = Rect::new(0, 1, area.width, area.height - 2);
        render_canvas(app, buf, canvas);
    }
    render_toolbar(app, buf, Rect::new(0, 0, area.width, 1));
    if area.height >= 2 {
        render_status(app, buf, Rect::new(0, area.height - 1, area.width, 1));
    }

    if app.help {
        render_help(buf, area);
    }
}

fn render_canvas(app: &App, buf: &mut Buffer, canvas: Rect) {
    buf.set_style(canvas, Style::new().bg(BG_CANVAS));
    for y in canvas.y..canvas.y + canvas.height {
        for x in canvas.x..canvas.x + canvas.width {
            if let Some(c) = buf.cell_mut((x, y)) {
                c.set_char(' ');
            }
        }
    }

    let w = canvas.width as usize;
    let h = (canvas.y + canvas.height) as usize;
    let mut occupied = vec![false; w * h];
    let mut mark = |x: i32, y: i32| {
        if x >= 0 && y >= 0 && (x as usize) < w && (y as usize) < h {
            occupied[y as usize * w + x as usize] = true;
        }
    };

    let empty = app.objects.is_empty() && app.drag.is_none() && app.editing.is_none();
    if empty && canvas.height >= 3 {
        let msgs = [
            "Empty canvas".to_string(),
            "press b, a, t or p to pick a tool, then draw with the mouse · ? for help".to_string(),
        ];
        let mid = canvas.y as i32 + canvas.height as i32 / 2 - 1;
        for (i, m) in msgs.iter().enumerate() {
            let len = m.chars().count() as i32;
            if len > canvas.width as i32 {
                continue;
            }
            let x0 = (canvas.width as i32 - len) / 2;
            let style = if i == 0 {
                Style::new().fg(FG_DIM).bg(BG_CANVAS).add_modifier(Modifier::BOLD)
            } else {
                Style::new().fg(FG_FAINT).bg(BG_CANVAS)
            };
            for (j, ch) in m.chars().enumerate() {
                put(buf, canvas, x0 + j as i32, mid + i as i32 * 2, ch, style);
            }
        }
    }

    let selected = app.selected;
    for o in &app.objects {
        let is_sel = Some(o.id) == selected;
        let mut style = Style::new().fg(COLORS[o.color]).bg(BG_CANVAS);
        if is_sel {
            style = style.bg(SEL_BG).add_modifier(Modifier::BOLD);
        }
        for (x, y, ch) in o.kind.cells() {
            put(buf, canvas, x, y, ch, style);
            mark(x, y);
        }
    }

    // Live preview of the shape being drawn.
    if let Some((k, c)) = app.preview() {
        let style = Style::new().fg(COLORS[c]).bg(BG_CANVAS).add_modifier(Modifier::BOLD);
        for (x, y, ch) in k.cells() {
            put(buf, canvas, x, y, ch, style);
            mark(x, y);
        }
        if let Kind::Rect { .. } | Kind::Arrow { .. } = k {
            // nothing more
        }
    }

    // Text being edited.
    if let Some(ed) = &app.editing {
        let style = Style::new().fg(COLORS[app.color]).bg(BG_BAR_ALT);
        let mut n = 0;
        for (i, ch) in ed.s.chars().enumerate() {
            put(buf, canvas, ed.x + i as i32, ed.y, ch, style);
            mark(ed.x + i as i32, ed.y);
            n = i as i32 + 1;
        }
        put(
            buf,
            canvas,
            ed.x + n,
            ed.y,
            '▏',
            Style::new().fg(HANDLE).bg(BG_BAR_ALT).add_modifier(Modifier::BOLD),
        );
    }

    // Selection frame with corner handles, drawn one cell outside the bounds
    // and only over empty canvas cells.
    if let Some(o) = app.selected_obj() {
        let (a, b, c, d) = o.kind.bounds();
        let (fx0, fy0, fx1, fy1) = (a - 1, b - 1, c + 1, d + 1);
        let line = Style::new().fg(ACCENT).bg(BG_CANVAS);
        let handle = Style::new().fg(HANDLE).bg(BG_CANVAS).add_modifier(Modifier::BOLD);
        let free = |x: i32, y: i32| -> bool {
            x >= 0 && y >= 0 && (x as usize) < w && (y as usize) < h && !occupied[y as usize * w + x as usize]
        };
        for x in fx0..=fx1 {
            for &y in &[fy0, fy1] {
                if free(x, y) {
                    let corner = x == fx0 || x == fx1;
                    let (ch, st) = if corner { ('◆', handle) } else { ('╌', line) };
                    put(buf, canvas, x, y, ch, st);
                }
            }
        }
        for y in (fy0 + 1)..fy1 {
            for &x in &[fx0, fx1] {
                if free(x, y) {
                    put(buf, canvas, x, y, '╎', line);
                }
            }
        }
    }
}

fn render_toolbar(app: &App, buf: &mut Buffer, area: Rect) {
    buf.set_style(area, Style::new().bg(BG_BAR).fg(FG_BAR));
    for x in area.x..area.x + area.width {
        if let Some(c) = buf.cell_mut((x, area.y)) {
            c.set_char(' ');
        }
    }
    let base = Style::new().bg(BG_BAR).fg(FG_BAR);
    for (x, seg) in toolbar_segments(area.width) {
        let spans: Vec<Span> = match seg {
            Seg::Title => vec![
                Span::styled(" ◆ ", Style::new().bg(ACCENT).fg(ACCENT_DARK)),
                Span::styled("termdraw ", Style::new().bg(ACCENT).fg(ACCENT_DARK).add_modifier(Modifier::BOLD)),
            ],
            Seg::Gap(n) => vec![Span::styled(" ".repeat(n as usize), base)],
            Seg::Sep => vec![Span::styled(" │ ", Style::new().bg(BG_BAR).fg(FG_FAINT))],
            Seg::Tool(t, names) => {
                let active = app.tool == t;
                let (key_st, name_st, cap) = if active {
                    (
                        Style::new().bg(ACCENT).fg(ACCENT_DARK).add_modifier(Modifier::BOLD | Modifier::UNDERLINED),
                        Style::new().bg(ACCENT).fg(ACCENT_DARK).add_modifier(Modifier::BOLD),
                        Style::new().bg(BG_BAR).fg(ACCENT),
                    )
                } else {
                    (
                        Style::new().bg(BG_BAR).fg(HANDLE),
                        Style::new().bg(BG_BAR).fg(FG_BAR),
                        base,
                    )
                };
                let (l, r) = if active { ("▐", "▌") } else { (" ", " ") };
                let mut v = vec![Span::styled(l, cap), Span::styled(t.key().to_string(), key_st)];
                if names {
                    v.push(Span::styled(format!(" {}", t.name()), name_st));
                }
                v.push(Span::styled(r, cap));
                v
            }
            Seg::ColorLabel => vec![Span::styled("Color ", Style::new().bg(BG_BAR).fg(FG_DIM))],
            Seg::Color(i) => {
                let active = app.color == i;
                if active {
                    let br = Style::new().bg(BG_BAR_ALT).fg(Color::White).add_modifier(Modifier::BOLD);
                    vec![
                        Span::styled("[", br),
                        Span::styled(format!("{}", i + 1), br),
                        Span::styled("■", Style::new().bg(BG_BAR_ALT).fg(COLORS[i])),
                        Span::styled("]", br),
                    ]
                } else {
                    vec![
                        Span::styled(" ", base),
                        Span::styled(format!("{}", i + 1), Style::new().bg(BG_BAR).fg(FG_DIM)),
                        Span::styled("■", Style::new().bg(BG_BAR).fg(COLORS[i])),
                        Span::styled(" ", base),
                    ]
                }
            }
            Seg::Help => vec![
                Span::styled(" ? ", Style::new().bg(BG_BAR_ALT).fg(HANDLE).add_modifier(Modifier::BOLD)),
                Span::styled("Help ", Style::new().bg(BG_BAR_ALT).fg(FG_BAR)),
            ],
        };
        let width = area.width.saturating_sub(x);
        if width == 0 {
            continue;
        }
        Line::from(spans).render(Rect::new(area.x + x, area.y, width, 1), buf);
    }
}

fn render_status(app: &App, buf: &mut Buffer, area: Rect) {
    buf.set_style(area, Style::new().bg(BG_BAR).fg(FG_BAR));
    for x in area.x..area.x + area.width {
        if let Some(c) = buf.cell_mut((x, area.y)) {
            c.set_char(' ');
        }
    }
    let editing = app.editing.is_some();
    let badge = if editing { "TEXT ✎".to_string() } else { app.tool.name().to_uppercase() };
    let sep = || Span::styled("  │  ", Style::new().bg(BG_BAR).fg(FG_FAINT));
    let label = |s: &str| Span::styled(s.to_string(), Style::new().bg(BG_BAR).fg(FG_DIM));
    let value = |s: String| Span::styled(s, Style::new().bg(BG_BAR).fg(FG_BAR).add_modifier(Modifier::BOLD));

    let mut left: Vec<Span> = vec![
        Span::styled(format!(" {} ", badge), Style::new().bg(ACCENT).fg(ACCENT_DARK).add_modifier(Modifier::BOLD)),
        Span::styled(" ", Style::new().bg(BG_BAR)),
    ];
    match app.mouse {
        Some((x, y)) => {
            left.push(label("x "));
            left.push(value(format!("{:<3}", x)));
            left.push(label(" y "));
            left.push(value(format!("{:<3}", y)));
        }
        None => {
            left.push(label("x "));
            left.push(value("—  ".into()));
            left.push(label(" y "));
            left.push(value("—  ".into()));
        }
    }
    left.push(sep());
    let n = app.objects.len();
    left.push(value(n.to_string()));
    left.push(label(if n == 1 { " object" } else { " objects" }));

    let (info, hint): (Vec<Span>, Option<Span>) = if let Some(ed) = &app.editing {
        (
            vec![label("typing at "), value(format!("{},{}", ed.x, ed.y))],
            Some(label("  enter/esc to finish")),
        )
    } else if let Some(o) = app.selected_obj() {
        (
            vec![
                Span::styled("◆ ", Style::new().bg(BG_BAR).fg(HANDLE)),
                Span::styled(describe(&o.kind), Style::new().bg(BG_BAR).fg(COLORS[o.color]).add_modifier(Modifier::BOLD)),
            ],
            Some(label("  del removes · drag moves")),
        )
    } else if let Some((k, c)) = app.preview() {
        (
            vec![
                label("drawing "),
                Span::styled(describe(&k), Style::new().bg(BG_BAR).fg(COLORS[c]).add_modifier(Modifier::BOLD)),
            ],
            None,
        )
    } else if let Some(f) = &app.flash {
        (vec![Span::styled(f.clone(), Style::new().bg(BG_BAR).fg(HANDLE))], None)
    } else {
        (vec![], Some(label(app.tool.hint())))
    };

    let right: Vec<Span> = vec![
        Span::styled("■ ", Style::new().bg(BG_BAR).fg(COLORS[app.color])),
        Span::styled(COLOR_NAMES[app.color], Style::new().bg(BG_BAR).fg(FG_BAR)),
        Span::styled("  ", Style::new().bg(BG_BAR)),
        Span::styled(" ^Z undo · ^Q quit ", Style::new().bg(BG_BAR_ALT).fg(FG_DIM)),
    ];

    let wid = |v: &Vec<Span>| v.iter().map(|s| s.width()).sum::<usize>();
    let total_w = area.width as usize;
    let right_w = wid(&right);
    let mut spans = left;
    let sep_w = 5;
    let mut info_added = false;
    if !info.is_empty() && wid(&spans) + sep_w + wid(&info) <= total_w {
        spans.push(sep());
        spans.extend(info);
        info_added = true;
    }
    if let Some(h) = hint {
        let h = if info_added {
            h
        } else {
            spans.push(sep());
            Span::styled(h.content.trim_start().to_string(), h.style)
        };
        if wid(&spans) + h.width() + right_w + 3 <= total_w {
            spans.push(h);
        } else if !info_added {
            spans.pop();
        }
    }
    let used = wid(&spans);
    Line::from(spans).render(area, buf);
    if used + right_w + 1 <= total_w {
        let rx = area.x + (total_w - right_w) as u16;
        Line::from(right).render(Rect::new(rx, area.y, right_w as u16, 1), buf);
    } else if used + 9 <= total_w {
        let short = vec![
            Span::styled("■ ", Style::new().bg(BG_BAR).fg(COLORS[app.color])),
            Span::styled(COLOR_NAMES[app.color], Style::new().bg(BG_BAR).fg(FG_BAR)),
            Span::styled(" ", Style::new().bg(BG_BAR)),
        ];
        let sw = wid(&short);
        if used + sw + 1 <= total_w {
            let rx = area.x + (total_w - sw) as u16;
            Line::from(short).render(Rect::new(rx, area.y, sw as u16, 1), buf);
        }
    }
}

fn render_help(buf: &mut Buffer, area: Rect) {
    let key = |k: &str| Span::styled(format!(" {:<10}", k), Style::new().fg(HANDLE).add_modifier(Modifier::BOLD));
    let desc = |d: &str| Span::styled(d.to_string(), Style::new().fg(FG_BAR));
    let head = |h: &str| Line::from(Span::styled(format!(" {}", h), Style::new().fg(ACCENT).add_modifier(Modifier::BOLD)));
    let row = |k: &str, d: &str| Line::from(vec![key(k), desc(d)]);
    let lines: Vec<Line> = vec![
        head("TOOLS"),
        row("v", "Select · click to select, drag to move"),
        row("b", "Box · drag corner to corner"),
        row("a", "Arrow · drag start to end (elbow if diagonal)"),
        row("t", "Text · click, type, enter/esc to finish"),
        row("p", "Pen · drag to paint freehand"),
        Line::from(""),
        head("KEYS"),
        row("1 – 6", "Color: white red yellow green cyan magenta"),
        row("del / ⌫", "Delete selected object"),
        row("esc", "Clear selection"),
        row("ctrl+z", "Undo"),
        row("ctrl+y", "Redo"),
        row("?", "Toggle this help"),
        row("ctrl+q", "Quit"),
        Line::from(""),
        Line::from(Span::styled(
            " Moving a box also moves text inside it.",
            Style::new().fg(FG_DIM),
        )),
    ];
    let want_w: u16 = 60;
    let want_h: u16 = lines.len() as u16 + 2;
    let w = want_w.min(area.width.saturating_sub(2)).max(1);
    let h = want_h.min(area.height.saturating_sub(2)).max(1);
    if area.width < 4 || area.height < 4 {
        return;
    }
    let x = area.x + (area.width - w) / 2;
    let y = area.y + (area.height - h) / 2;
    let rect = Rect::new(x, y, w, h);
    Clear.render(rect, buf);
    let block = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(Style::new().fg(ACCENT).bg(BG_BAR))
        .style(Style::new().bg(BG_BAR))
        .title(Span::styled(" Help ", Style::new().fg(ACCENT_DARK).bg(ACCENT).add_modifier(Modifier::BOLD)))
        .title_bottom(Line::from(Span::styled(" ? or esc to close ", Style::new().fg(FG_DIM))).right_aligned());
    Paragraph::new(lines).block(block).render(rect, buf);
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

fn main() -> io::Result<()> {
    let mut terminal = ratatui::init();
    execute!(io::stdout(), EnableMouseCapture)?;
    let result = run(&mut terminal);
    let _ = execute!(io::stdout(), DisableMouseCapture);
    ratatui::restore();
    result
}

fn run(terminal: &mut DefaultTerminal) -> io::Result<()> {
    let size = terminal.size()?;
    let mut app = App::new(size.width, size.height);
    loop {
        terminal.draw(|f| {
            let a = f.area();
            app.width = a.width;
            app.height = a.height;
            render(&app, f);
        })?;
        match event::read()? {
            Event::Key(k) => app.handle_key(k),
            Event::Mouse(m) => app.handle_mouse(m),
            Event::Resize(w, h) => {
                app.width = w;
                app.height = h;
            }
            _ => {}
        }
        if app.quit {
            return Ok(());
        }
    }
}
