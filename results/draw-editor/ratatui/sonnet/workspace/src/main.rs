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
    widgets::Widget,
};

// ---------------------------------------------------------------- model

const COLORS: [(Color, &str); 6] = [
    (Color::Rgb(240, 240, 240), "white"),
    (Color::Rgb(255, 95, 95), "red"),
    (Color::Rgb(255, 215, 95), "yellow"),
    (Color::Rgb(95, 215, 95), "green"),
    (Color::Rgb(95, 215, 255), "cyan"),
    (Color::Rgb(215, 120, 255), "magenta"),
];

#[derive(Clone, Copy, PartialEq, Eq)]
enum Tool {
    Select,
    Box,
    Arrow,
    Text,
    Pen,
}

impl Tool {
    const ALL: [Tool; 5] = [Tool::Select, Tool::Box, Tool::Arrow, Tool::Text, Tool::Pen];
    fn name(self) -> &'static str {
        match self {
            Tool::Select => "Select",
            Tool::Box => "Box",
            Tool::Arrow => "Arrow",
            Tool::Text => "Text",
            Tool::Pen => "Pen",
        }
    }
    fn key(self) -> char {
        match self {
            Tool::Select => 'v',
            Tool::Box => 'b',
            Tool::Arrow => 'a',
            Tool::Text => 't',
            Tool::Pen => 'p',
        }
    }
}

#[derive(Clone)]
enum Kind {
    Box(i32, i32, i32, i32),
    Arrow(i32, i32, i32, i32),
    Text(i32, i32, String),
    Pen(Vec<(i32, i32)>),
}

#[derive(Clone)]
struct Obj {
    id: u64,
    color: usize,
    kind: Kind,
}

impl Obj {
    fn type_name(&self) -> &'static str {
        match self.kind {
            Kind::Box(..) => "Box",
            Kind::Arrow(..) => "Arrow",
            Kind::Text(..) => "Text",
            Kind::Pen(..) => "Pen",
        }
    }

    /// Inclusive bounds (x0, y0, x1, y1).
    fn bounds(&self) -> (i32, i32, i32, i32) {
        match &self.kind {
            Kind::Box(a, b, c, d) | Kind::Arrow(a, b, c, d) => {
                (*a.min(c), *b.min(d), *a.max(c), *b.max(d))
            }
            Kind::Text(x, y, s) => (*x, *y, *x + (s.chars().count() as i32 - 1).max(0), *y),
            Kind::Pen(cells) => {
                let mut r = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
                for &(x, y) in cells {
                    r = (r.0.min(x), r.1.min(y), r.2.max(x), r.3.max(y));
                }
                if cells.is_empty() { (0, 0, 0, 0) } else { r }
            }
        }
    }

    fn shift(&mut self, dx: i32, dy: i32) {
        match &mut self.kind {
            Kind::Box(a, b, c, d) | Kind::Arrow(a, b, c, d) => {
                *a += dx;
                *c += dx;
                *b += dy;
                *d += dy;
            }
            Kind::Text(x, y, _) => {
                *x += dx;
                *y += dy;
            }
            Kind::Pen(cells) => {
                for c in cells.iter_mut() {
                    c.0 += dx;
                    c.1 += dy;
                }
            }
        }
    }

    fn cells(&self) -> Vec<(i32, i32, char)> {
        let mut out = Vec::new();
        match &self.kind {
            Kind::Box(..) => {
                let (x0, y0, x1, y1) = self.bounds();
                for y in y0..=y1 {
                    for x in x0..=x1 {
                        let top = y == y0;
                        let bot = y == y1;
                        let left = x == x0;
                        let right = x == x1;
                        if !(top || bot || left || right) {
                            continue;
                        }
                        let ch = if top && left {
                            '┌'
                        } else if top && right {
                            '┐'
                        } else if bot && left {
                            '└'
                        } else if bot && right {
                            '┘'
                        } else if top || bot {
                            '─'
                        } else {
                            '│'
                        };
                        out.push((x, y, ch));
                    }
                }
            }
            Kind::Arrow(x0, y0, x1, y1) => {
                let (x0, y0, x1, y1) = (*x0, *y0, *x1, *y1);
                let dx = (x1 - x0).signum();
                let dy = (y1 - y0).signum();
                if dy == 0 {
                    let mut x = x0;
                    while x != x1 {
                        out.push((x, y0, '─'));
                        x += dx;
                    }
                    out.push((x1, y1, if dx < 0 { '◀' } else { '▶' }));
                } else if dx == 0 {
                    let mut y = y0;
                    while y != y1 {
                        out.push((x0, y, '│'));
                        y += dy;
                    }
                    out.push((x1, y1, if dy < 0 { '▲' } else { '▼' }));
                } else {
                    let mut x = x0;
                    while x != x1 {
                        out.push((x, y0, '─'));
                        x += dx;
                    }
                    let corner = match (dx > 0, dy > 0) {
                        (true, true) => '┐',
                        (true, false) => '┘',
                        (false, true) => '┌',
                        (false, false) => '└',
                    };
                    out.push((x1, y0, corner));
                    let mut y = y0 + dy;
                    while y != y1 {
                        out.push((x1, y, '│'));
                        y += dy;
                    }
                    out.push((x1, y1, if dy < 0 { '▲' } else { '▼' }));
                }
            }
            Kind::Text(x, y, s) => {
                for (i, ch) in s.chars().enumerate() {
                    if ch != ' ' {
                        out.push((*x + i as i32, *y, ch));
                    }
                }
            }
            Kind::Pen(cells) => {
                for &(x, y) in cells {
                    out.push((x, y, '█'));
                }
            }
        }
        out
    }

    fn hit(&self, x: i32, y: i32) -> bool {
        let (x0, y0, x1, y1) = self.bounds();
        if x < x0 || x > x1 || y < y0 || y > y1 {
            return false;
        }
        self.cells().iter().any(|&(cx, cy, _)| cx == x && cy == y)
    }
}

fn line_cells(a: (i32, i32), b: (i32, i32)) -> Vec<(i32, i32)> {
    // Bresenham
    let (mut x, mut y) = a;
    let dx = (b.0 - a.0).abs();
    let dy = -(b.1 - a.1).abs();
    let sx = if a.0 < b.0 { 1 } else { -1 };
    let sy = if a.1 < b.1 { 1 } else { -1 };
    let mut err = dx + dy;
    let mut out = vec![];
    loop {
        out.push((x, y));
        if (x, y) == b {
            break;
        }
        let e2 = 2 * err;
        if e2 >= dy {
            err += dy;
            x += sx;
        }
        if e2 <= dx {
            err += dx;
            y += sy;
        }
    }
    out
}

enum Drag {
    None,
    Shape(i32, i32),
    Pen,
    Move { start: (i32, i32), base: Vec<Obj>, idx: Vec<usize> },
}

struct App {
    objects: Vec<Obj>,
    hist: Vec<Vec<Obj>>,
    hpos: usize,
    next_id: u64,
    tool: Tool,
    color: usize,
    selected: Option<u64>,
    draft: Option<Obj>,
    editing: Option<Obj>,
    drag: Drag,
    mouse: Option<(i32, i32)>,
    help: bool,
    quit: bool,
    size: (u16, u16),
}

#[derive(Clone, Copy)]
enum Act {
    Tool(Tool),
    Color(usize),
    Help,
}

impl App {
    fn new() -> Self {
        App {
            objects: vec![],
            hist: vec![vec![]],
            hpos: 0,
            next_id: 1,
            tool: Tool::Select,
            color: 0,
            selected: None,
            draft: None,
            editing: None,
            drag: Drag::None,
            mouse: None,
            help: false,
            quit: false,
            size: (110, 34),
        }
    }

    fn new_obj(&mut self, kind: Kind) -> Obj {
        let id = self.next_id;
        self.next_id += 1;
        Obj { id, color: self.color, kind }
    }

    fn commit(&mut self) {
        self.hist.truncate(self.hpos + 1);
        self.hist.push(self.objects.clone());
        self.hpos += 1;
    }

    fn undo(&mut self) {
        self.finish_text();
        if self.hpos > 0 {
            self.hpos -= 1;
            self.objects = self.hist[self.hpos].clone();
            self.fix_selection();
        }
    }

    fn redo(&mut self) {
        self.finish_text();
        if self.hpos + 1 < self.hist.len() {
            self.hpos += 1;
            self.objects = self.hist[self.hpos].clone();
            self.fix_selection();
        }
    }

    fn fix_selection(&mut self) {
        if let Some(id) = self.selected {
            if !self.objects.iter().any(|o| o.id == id) {
                self.selected = None;
            }
        }
    }

    fn finish_text(&mut self) {
        if let Some(o) = self.editing.take() {
            if let Kind::Text(_, _, s) = &o.kind {
                if !s.is_empty() {
                    self.objects.push(o);
                    self.commit();
                }
            }
        }
    }

    fn set_tool(&mut self, t: Tool) {
        self.finish_text();
        self.draft = None;
        self.drag = Drag::None;
        if t != Tool::Select {
            self.selected = None;
        }
        self.tool = t;
    }

    fn set_color(&mut self, c: usize) {
        self.color = c;
        if let Some(id) = self.selected {
            if let Some(o) = self.objects.iter_mut().find(|o| o.id == id) {
                if o.color != c {
                    o.color = c;
                    self.commit();
                }
            }
        }
    }

    fn delete_selected(&mut self) {
        if let Some(id) = self.selected.take() {
            let before = self.objects.len();
            self.objects.retain(|o| o.id != id);
            if self.objects.len() != before {
                self.commit();
            }
        }
    }

    fn canvas_clamp(&self, x: i32, y: i32) -> (i32, i32) {
        let w = self.size.0 as i32;
        let h = self.size.1 as i32;
        (x.clamp(0, (w - 1).max(0)), y.clamp(1, (h - 2).max(1)))
    }

    // ------------------------------------------------------------ input

    fn key(&mut self, k: KeyEvent) {
        if k.kind == KeyEventKind::Release {
            return;
        }
        let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
        let alt = k.modifiers.contains(KeyModifiers::ALT);
        if ctrl {
            match k.code {
                KeyCode::Char('q') | KeyCode::Char('Q') => self.quit = true,
                KeyCode::Char('z') | KeyCode::Char('Z') => self.undo(),
                KeyCode::Char('y') | KeyCode::Char('Y') => self.redo(),
                _ => {}
            }
            return;
        }
        if let Some(ed) = self.editing.as_mut() {
            match k.code {
                KeyCode::Enter | KeyCode::Esc => self.finish_text(),
                KeyCode::Backspace => {
                    if let Kind::Text(_, _, s) = &mut ed.kind {
                        s.pop();
                    }
                }
                KeyCode::Char(c) if !alt => {
                    if let Kind::Text(_, _, s) = &mut ed.kind {
                        s.push(c);
                    }
                }
                _ => {}
            }
            return;
        }
        match k.code {
            KeyCode::Esc => {
                if self.help {
                    self.help = false;
                } else {
                    self.selected = None;
                }
            }
            KeyCode::Delete | KeyCode::Backspace => self.delete_selected(),
            KeyCode::Char(c) if !alt => match c {
                '?' => self.help = !self.help,
                'v' => self.set_tool(Tool::Select),
                'b' => self.set_tool(Tool::Box),
                'a' => self.set_tool(Tool::Arrow),
                't' => self.set_tool(Tool::Text),
                'p' => self.set_tool(Tool::Pen),
                '1'..='6' => self.set_color(c as usize - '1' as usize),
                _ => {}
            },
            _ => {}
        }
    }

    fn mouse(&mut self, m: MouseEvent) {
        let (w, h) = (self.size.0 as i32, self.size.1 as i32);
        let (x, y) = (m.column as i32, m.row as i32);
        let on_canvas = y >= 1 && y <= h - 2 && x < w;
        if on_canvas {
            self.mouse = Some((x, y));
        }
        match m.kind {
            MouseEventKind::Down(MouseButton::Left) => {
                if y == 0 {
                    if let Some(a) = toolbar_hit(self, x) {
                        match a {
                            Act::Tool(t) => self.set_tool(t),
                            Act::Color(c) => self.set_color(c),
                            Act::Help => self.help = !self.help,
                        }
                    }
                    return;
                }
                if !on_canvas {
                    return;
                }
                self.finish_text();
                match self.tool {
                    Tool::Select => {
                        let hit = self.objects.iter().rposition(|o| o.hit(x, y));
                        match hit {
                            Some(i) => {
                                self.selected = Some(self.objects[i].id);
                                let mut idx = vec![i];
                                if let Kind::Box(..) = self.objects[i].kind {
                                    let (bx0, by0, bx1, by1) = self.objects[i].bounds();
                                    for (j, o) in self.objects.iter().enumerate() {
                                        if let Kind::Text(..) = o.kind {
                                            let (a, b, c, d) = o.bounds();
                                            if a >= bx0 && c <= bx1 && b >= by0 && d <= by1 {
                                                idx.push(j);
                                            }
                                        }
                                    }
                                }
                                self.drag = Drag::Move {
                                    start: (x, y),
                                    base: self.objects.clone(),
                                    idx,
                                };
                            }
                            None => {
                                self.selected = None;
                                self.drag = Drag::None;
                            }
                        }
                    }
                    Tool::Box => {
                        let o = self.new_obj(Kind::Box(x, y, x, y));
                        self.draft = Some(o);
                        self.drag = Drag::Shape(x, y);
                    }
                    Tool::Arrow => {
                        let o = self.new_obj(Kind::Arrow(x, y, x, y));
                        self.draft = Some(o);
                        self.drag = Drag::Shape(x, y);
                    }
                    Tool::Pen => {
                        let o = self.new_obj(Kind::Pen(vec![(x, y)]));
                        self.draft = Some(o);
                        self.drag = Drag::Pen;
                    }
                    Tool::Text => {
                        self.selected = None;
                        let o = self.new_obj(Kind::Text(x, y, String::new()));
                        self.editing = Some(o);
                    }
                }
            }
            MouseEventKind::Drag(MouseButton::Left) => {
                let (x, y) = self.canvas_clamp(x, y);
                match &mut self.drag {
                    Drag::Shape(sx, sy) => {
                        let (sx, sy) = (*sx, *sy);
                        if let Some(d) = self.draft.as_mut() {
                            match &mut d.kind {
                                Kind::Box(_, _, c, e) | Kind::Arrow(_, _, c, e) => {
                                    let _ = (sx, sy);
                                    *c = x;
                                    *e = y;
                                }
                                _ => {}
                            }
                        }
                    }
                    Drag::Pen => {
                        if let Some(d) = self.draft.as_mut() {
                            if let Kind::Pen(cells) = &mut d.kind {
                                let last = *cells.last().unwrap();
                                for c in line_cells(last, (x, y)) {
                                    if !cells.contains(&c) {
                                        cells.push(c);
                                    }
                                }
                            }
                        }
                    }
                    Drag::Move { start, base, idx } => {
                        let mut dx = x - start.0;
                        let mut dy = y - start.1;
                        let mut objs = base.clone();
                        let mut minx = i32::MAX;
                        let mut miny = i32::MAX;
                        for &i in idx.iter() {
                            let b = objs[i].bounds();
                            minx = minx.min(b.0);
                            miny = miny.min(b.1);
                        }
                        dx = dx.max(-minx);
                        dy = dy.max(1 - miny);
                        for &i in idx.iter() {
                            objs[i].shift(dx, dy);
                        }
                        self.objects = objs;
                    }
                    Drag::None => {}
                }
            }
            MouseEventKind::Up(MouseButton::Left) => {
                let drag = std::mem::replace(&mut self.drag, Drag::None);
                match drag {
                    Drag::Shape(..) | Drag::Pen => {
                        if let Some(d) = self.draft.take() {
                            self.objects.push(d);
                            self.commit();
                        }
                    }
                    Drag::Move { base, .. } => {
                        let changed = base.len() != self.objects.len()
                            || base
                                .iter()
                                .zip(self.objects.iter())
                                .any(|(a, b)| a.bounds() != b.bounds());
                        if changed {
                            self.commit();
                        }
                    }
                    Drag::None => {}
                }
            }
            _ => {}
        }
    }
}

// ---------------------------------------------------------------- toolbar

const TB_BG: Color = Color::Rgb(34, 36, 52);
const SEL_BG: Color = Color::Rgb(70, 110, 220);

fn toolbar_items(app: &App) -> Vec<(String, Style, Option<Act>)> {
    let base = Style::new().bg(TB_BG).fg(Color::Rgb(190, 195, 215));
    let mut v: Vec<(String, Style, Option<Act>)> = vec![];
    v.push((" ".into(), base, None));
    for t in Tool::ALL {
        let active = app.tool == t;
        let (kst, nst) = if active {
            (
                Style::new().bg(SEL_BG).fg(Color::Rgb(255, 235, 130)).add_modifier(Modifier::BOLD),
                Style::new().bg(SEL_BG).fg(Color::White).add_modifier(Modifier::BOLD),
            )
        } else {
            (base.fg(Color::Rgb(255, 215, 95)), base)
        };
        v.push((format!(" {}", t.key()), kst, Some(Act::Tool(t))));
        v.push((format!(" {} ", t.name()), nst, Some(Act::Tool(t))));
        v.push((" ".into(), base, None));
    }
    v.push((" │ ".into(), base.fg(Color::Rgb(90, 95, 120)), None));
    for (i, (c, _)) in COLORS.iter().enumerate() {
        let active = app.color == i;
        if active {
            let st = Style::new().bg(Color::Rgb(70, 74, 100)).fg(Color::White).add_modifier(Modifier::BOLD);
            v.push((format!("[{}", i + 1), st, Some(Act::Color(i))));
            v.push(("■".into(), st.fg(*c), Some(Act::Color(i))));
            v.push(("]".into(), st, Some(Act::Color(i))));
        } else {
            v.push((format!(" {}", i + 1), base, Some(Act::Color(i))));
            v.push(("■".into(), base.fg(*c), Some(Act::Color(i))));
            v.push((" ".into(), base, Some(Act::Color(i))));
        }
    }
    v.push((" │ ".into(), base.fg(Color::Rgb(90, 95, 120)), None));
    v.push((
        "? help  ^q quit".into(),
        base.fg(Color::Rgb(130, 136, 165)),
        Some(Act::Help),
    ));
    v
}

fn toolbar_hit(app: &App, x: i32) -> Option<Act> {
    let mut cx = 0i32;
    for (s, _, act) in toolbar_items(app) {
        let w = s.chars().count() as i32;
        if x >= cx && x < cx + w {
            return act;
        }
        cx += w;
    }
    None
}

// ---------------------------------------------------------------- render

fn put(buf: &mut Buffer, area: Rect, x: i32, y: i32, ch: char, style: Style) {
    if x < 0 || y < 0 || x >= area.width as i32 || y >= area.height as i32 {
        return;
    }
    if let Some(c) = buf.cell_mut((area.x + x as u16, area.y + y as u16)) {
        c.set_char(ch);
        c.set_style(style);
    }
}

fn draw_obj(buf: &mut Buffer, area: Rect, o: &Obj) {
    let st = Style::new().fg(COLORS[o.color].0);
    let maxy = area.height as i32 - 2;
    for (x, y, ch) in o.cells() {
        if y >= 1 && y <= maxy {
            put(buf, area, x, y, ch, st);
        }
    }
}

struct Ui<'a>(&'a App);

impl Widget for Ui<'_> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        let app = self.0;
        let w = area.width as i32;
        let h = area.height as i32;
        if h < 1 || w < 1 {
            return;
        }
        let maxy = h - 2;

        for o in &app.objects {
            draw_obj(buf, area, o);
        }
        if let Some(d) = &app.draft {
            draw_obj(buf, area, d);
        }

        // selection
        let mut sel_desc: Option<String> = None;
        if let Some(id) = app.selected {
            if let Some(o) = app.objects.iter().find(|o| o.id == id) {
                let (x0, y0, x1, y1) = o.bounds();
                sel_desc = Some(format!(
                    "{} {}×{} at {},{}",
                    o.type_name(),
                    x1 - x0 + 1,
                    y1 - y0 + 1,
                    x0,
                    y0
                ));
                let hl = Color::Rgb(120, 170, 255);
                // outline on empty cells just outside bounds
                let empty = |buf: &Buffer, x: i32, y: i32| -> bool {
                    if x < 0 || x >= w || y < 1 || y > maxy {
                        return false;
                    }
                    buf.cell((area.x + x as u16, area.y + y as u16))
                        .map(|c| c.symbol() == " ")
                        .unwrap_or(false)
                };
                let (ox0, oy0, ox1, oy1) = (x0 - 1, y0 - 1, x1 + 1, y1 + 1);
                for x in ox0..=ox1 {
                    for &y in &[oy0, oy1] {
                        if empty(buf, x, y) {
                            let corner = x == ox0 || x == ox1;
                            put(buf, area, x, y, if corner { '▪' } else { '┄' }, Style::new().fg(hl));
                        }
                    }
                }
                for y in oy0 + 1..oy1 {
                    for &x in &[ox0, ox1] {
                        if empty(buf, x, y) {
                            put(buf, area, x, y, '┆', Style::new().fg(hl));
                        }
                    }
                }
                for (x, y, _) in o.cells() {
                    if x >= 0 && x < w && y >= 1 && y <= maxy {
                        if let Some(c) = buf.cell_mut((area.x + x as u16, area.y + y as u16)) {
                            c.set_bg(Color::Rgb(60, 70, 120));
                            c.modifier.insert(Modifier::BOLD);
                        }
                    }
                }
            }
        }

        // text being edited
        if let Some(o) = &app.editing {
            draw_obj(buf, area, o);
            if let Kind::Text(x, y, s) = &o.kind {
                let cx = *x + s.chars().count() as i32;
                if *y >= 1 && *y <= maxy {
                    put(buf, area, cx, *y, '█', Style::new().fg(COLORS[o.color].0));
                }
            }
        }

        // toolbar
        let tb = Style::new().bg(TB_BG);
        for x in 0..w {
            put(buf, area, x, 0, ' ', tb);
        }
        let mut cx = 0;
        for (s, st, _) in toolbar_items(app) {
            for ch in s.chars() {
                put(buf, area, cx, 0, ch, st);
                cx += 1;
            }
        }

        // status bar
        if h >= 2 {
            let sy = h - 1;
            let sb = Style::new().bg(Color::Rgb(28, 30, 44)).fg(Color::Rgb(190, 195, 215));
            for x in 0..w {
                put(buf, area, x, sy, ' ', sb);
            }
            let mut segs: Vec<(String, Style)> = vec![];
            segs.push((
                format!(" {} ", app.tool.name().to_uppercase()),
                Style::new().bg(SEL_BG).fg(Color::White).add_modifier(Modifier::BOLD),
            ));
            let pos = match app.mouse {
                Some((x, y)) => format!("  x {} y {}  ", x, y),
                None => "  x - y -  ".to_string(),
            };
            segs.push((pos, sb));
            segs.push(("│".into(), sb.fg(Color::Rgb(90, 95, 120))));
            let n = app.objects.len();
            segs.push((
                format!("  {} object{}  ", n, if n == 1 { "" } else { "s" }),
                sb,
            ));
            if let Some(d) = sel_desc {
                segs.push(("│".into(), sb.fg(Color::Rgb(90, 95, 120))));
                segs.push((
                    format!("  {}  ", d),
                    sb.fg(Color::Rgb(255, 215, 95)).add_modifier(Modifier::BOLD),
                ));
            }
            let mut cx = 0;
            for (s, st) in &segs {
                for ch in s.chars() {
                    put(buf, area, cx, sy, ch, *st);
                    cx += 1;
                }
            }
            let right = format!("color: {}  ", COLORS[app.color].1);
            let rx = w - right.chars().count() as i32;
            if rx > cx {
                for (i, ch) in right.chars().enumerate() {
                    put(buf, area, rx + i as i32, sy, ch, sb.fg(COLORS[app.color].0));
                }
            }
        }

        if app.help {
            render_help(buf, area);
        }
    }
}

fn render_help(buf: &mut Buffer, area: Rect) {
    let lines: Vec<(&str, &str)> = vec![
        ("", "TOOLS"),
        ("v", "Select  click an object; drag to move it"),
        ("b", "Box     drag corner to corner"),
        ("a", "Arrow   drag; elbow when not straight"),
        ("t", "Text    click, type, enter/esc to finish"),
        ("p", "Pen     drag to paint blocks"),
        ("", ""),
        ("", "KEYS"),
        ("1-6", "Color: white red yellow green cyan magenta"),
        ("", "        (also recolors the selection)"),
        ("del", "Delete selected (backspace too)"),
        ("esc", "Clear selection / finish text"),
        ("^z ^y", "Undo / redo"),
        ("?", "Toggle this help"),
        ("^q", "Quit"),
    ];
    let w = 56u16.min(area.width);
    let h = (lines.len() as u16 + 4).min(area.height);
    if w < 10 || h < 5 {
        return;
    }
    let x0 = (area.width - w) / 2;
    let y0 = (area.height - h) / 2;
    let bg = Color::Rgb(26, 28, 42);
    let border = Style::new().bg(bg).fg(Color::Rgb(120, 170, 255));
    let normal = Style::new().bg(bg).fg(Color::Rgb(205, 210, 225));
    for y in 0..h {
        for x in 0..w {
            let (ch, st) = match (y, x) {
                (0, 0) => ('╭', border),
                (0, xx) if xx == w - 1 => ('╮', border),
                (yy, 0) if yy == h - 1 => ('╰', border),
                (yy, xx) if yy == h - 1 && xx == w - 1 => ('╯', border),
                (0, _) => ('─', border),
                (yy, _) if yy == h - 1 => ('─', border),
                (_, 0) => ('│', border),
                (_, xx) if xx == w - 1 => ('│', border),
                _ => (' ', normal),
            };
            if let Some(c) = buf.cell_mut((area.x + x0 + x, area.y + y0 + y)) {
                c.set_char(ch);
                c.set_style(st);
            }
        }
    }
    let title = " Help ";
    for (i, ch) in title.chars().enumerate() {
        if let Some(c) = buf.cell_mut((area.x + x0 + 3 + i as u16, area.y + y0)) {
            c.set_char(ch);
            c.set_style(border.add_modifier(Modifier::BOLD));
        }
    }
    for (i, (k, d)) in lines.iter().enumerate() {
        let y = y0 + 2 + i as u16;
        if y >= y0 + h - 1 {
            break;
        }
        let head = k.is_empty() && !d.is_empty() && !d.starts_with(' ') && d.chars().all(|c| c.is_uppercase());
        let mut x = x0 + 3;
        let ks = Style::new().bg(bg).fg(Color::Rgb(255, 215, 95)).add_modifier(Modifier::BOLD);
        let ds = if head {
            Style::new().bg(bg).fg(Color::Rgb(120, 170, 255)).add_modifier(Modifier::BOLD)
        } else {
            normal
        };
        for ch in format!("{:<6}", k).chars() {
            if x < x0 + w - 1 {
                if let Some(c) = buf.cell_mut((area.x + x, area.y + y)) {
                    c.set_char(ch);
                    c.set_style(ks);
                }
            }
            x += 1;
        }
        if head {
            x = x0 + 3;
        }
        for ch in d.chars() {
            if x < x0 + w - 1 {
                if let Some(c) = buf.cell_mut((area.x + x, area.y + y)) {
                    c.set_char(ch);
                    c.set_style(ds);
                }
            }
            x += 1;
        }
    }
}

fn draw(frame: &mut Frame, app: &App) {
    let area = frame.area();
    frame.render_widget(Ui(app), area);
}

fn run(terminal: &mut DefaultTerminal) -> io::Result<()> {
    let mut app = App::new();
    let sz = terminal.size()?;
    app.size = (sz.width, sz.height);
    loop {
        terminal.draw(|f| {
            app.size = (f.area().width, f.area().height);
            draw(f, &app)
        })?;
        match event::read()? {
            Event::Key(k) => app.key(k),
            Event::Mouse(m) => app.mouse(m),
            Event::Resize(w, h) => app.size = (w, h),
            _ => {}
        }
        if app.quit {
            return Ok(());
        }
    }
}

fn main() -> io::Result<()> {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = execute!(io::stdout(), DisableMouseCapture);
        prev(info);
    }));
    let mut terminal = ratatui::init();
    execute!(io::stdout(), EnableMouseCapture)?;
    let res = run(&mut terminal);
    let _ = execute!(io::stdout(), DisableMouseCapture);
    ratatui::restore();
    res
}
