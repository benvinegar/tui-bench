//! Application state, the event loop, and mouse/keyboard handling.

use std::collections::BTreeMap;
use std::io;

use crossterm::event::{
    self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEvent,
    MouseEventKind,
};
use ratatui::DefaultTerminal;

use crate::model::{
    Cells, Kind, Object, Pos, Tool, arrow_cells, box_cells, line_points, text_cells,
};
use crate::ui::{self, Action};

/// Maximum number of undo steps kept.
const UNDO_LIMIT: usize = 500;

/// Glyph used by the pen tool.
const PEN_GLYPH: char = '█';

/// A gesture in progress. Its preview is drawn until the button is released.
#[derive(Debug)]
pub enum Drag {
    Box { start: Pos, cur: Pos },
    Arrow { start: Pos, cur: Pos },
    Pen { last: Pos, cells: BTreeMap<Pos, char> },
    /// Moves the selected object (and any text inside a moved box). `pre` is
    /// the document before the drag, used as the undo entry on release.
    Move {
        pre: Vec<Object>,
        members: Vec<u64>,
        press: Pos,
        offset: Pos,
    },
}

/// A text object being typed. It is not part of the document until finished.
#[derive(Debug)]
pub struct TextEdit {
    pub origin: Pos,
    pub text: String,
}

pub struct App {
    pub objects: Vec<Object>,
    next_id: u64,
    pub tool: Tool,
    /// Index into [`crate::model::PALETTE`] used for new objects.
    pub color: usize,
    pub selected: Option<u64>,
    undo: Vec<Vec<Object>>,
    redo: Vec<Vec<Object>>,
    pub drag: Option<Drag>,
    pub text: Option<TextEdit>,
    pub help: bool,
    /// Last mouse position that landed on the canvas.
    pub mouse: Option<Pos>,
    /// Terminal size (columns, rows), refreshed before every frame.
    pub screen: (u16, u16),
    quit: bool,
}

impl App {
    pub fn new() -> Self {
        App {
            objects: Vec::new(),
            next_id: 1,
            tool: Tool::Select,
            color: 0,
            selected: None,
            undo: Vec::new(),
            redo: Vec::new(),
            drag: None,
            text: None,
            help: false,
            mouse: None,
            screen: (80, 24),
            quit: false,
        }
    }

    pub fn run(&mut self, terminal: &mut DefaultTerminal) -> io::Result<()> {
        while !self.quit {
            let size = terminal.size()?;
            self.screen = (size.width, size.height);
            terminal.draw(|frame| ui::render(frame, self))?;
            match event::read()? {
                Event::Key(key) if key.kind != KeyEventKind::Release => self.on_key(key),
                Event::Mouse(mouse) => self.on_mouse(mouse),
                _ => {}
            }
        }
        Ok(())
    }

    /// Canvas rows, inclusive. The toolbar is row 0 and the status bar is the last row.
    pub fn canvas_rows(&self) -> (i32, i32) {
        (1, i32::from(self.screen.1) - 2)
    }

    pub fn in_canvas(&self, p: Pos) -> bool {
        let (lo, hi) = self.canvas_rows();
        p.0 >= 0 && p.0 < i32::from(self.screen.0) && p.1 >= lo && p.1 <= hi
    }

    fn clamp_to_canvas(&self, p: Pos) -> Pos {
        let (lo, hi) = self.canvas_rows();
        let max_x = (i32::from(self.screen.0) - 1).max(0);
        (p.0.clamp(0, max_x), p.1.clamp(lo, hi.max(lo)))
    }

    pub fn selection(&self) -> Option<&Object> {
        let id = self.selected?;
        self.objects.iter().find(|o| o.id == id)
    }

    fn hit(&self, p: Pos) -> Option<u64> {
        self.objects.iter().rev().find(|o| o.hit(p)).map(|o| o.id)
    }

    /// The selected object, plus any text objects lying inside it if it is a box.
    fn move_members(&self, id: u64) -> Vec<u64> {
        let mut members = vec![id];
        let Some(obj) = self.objects.iter().find(|o| o.id == id) else {
            return members;
        };
        if obj.kind == Kind::Box {
            let (lo, hi) = obj.bounds();
            for other in &self.objects {
                if other.kind != Kind::Text || other.id == id {
                    continue;
                }
                let (a, b) = other.bounds();
                if a.0 >= lo.0 && b.0 <= hi.0 && a.1 >= lo.1 && b.1 <= hi.1 {
                    members.push(other.id);
                }
            }
        }
        members
    }

    // ----- keyboard -------------------------------------------------------

    pub fn on_key(&mut self, key: KeyEvent) {
        self.end_drag();
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        let alt = key.modifiers.contains(KeyModifiers::ALT);

        if ctrl {
            match key.code {
                KeyCode::Char('q') | KeyCode::Char('c') => self.quit = true,
                KeyCode::Char('z') => self.undo(),
                KeyCode::Char('y') => self.redo(),
                _ => {}
            }
            return;
        }

        if self.help {
            if matches!(key.code, KeyCode::Char('?') | KeyCode::Esc) {
                self.help = false;
            }
            return;
        }

        if self.text.is_some() {
            match key.code {
                KeyCode::Char(c) if !alt => {
                    if let Some(t) = self.text.as_mut() {
                        t.text.push(c);
                    }
                }
                KeyCode::Backspace => {
                    if let Some(t) = self.text.as_mut() {
                        t.text.pop();
                    }
                }
                KeyCode::Enter | KeyCode::Esc => self.finish_text(),
                _ => {}
            }
            return;
        }

        match key.code {
            KeyCode::Esc => self.selected = None,
            KeyCode::Backspace | KeyCode::Delete => self.delete_selected(),
            KeyCode::Char('?') => self.help = true,
            KeyCode::Char(c @ '1'..='6') if !alt => {
                self.set_color(c as usize - '1' as usize);
            }
            KeyCode::Char(c) if !alt => {
                if let Some(tool) = Tool::from_key(c.to_ascii_lowercase()) {
                    self.tool = tool;
                }
            }
            _ => {}
        }
    }

    // ----- mouse ----------------------------------------------------------

    pub fn on_mouse(&mut self, ev: MouseEvent) {
        let p = (i32::from(ev.column), i32::from(ev.row));
        if self.in_canvas(p) {
            self.mouse = Some(p);
        }
        if self.help {
            return;
        }
        match ev.kind {
            MouseEventKind::Down(MouseButton::Left) => self.press(p),
            MouseEventKind::Drag(MouseButton::Left) => self.drag_to(p),
            MouseEventKind::Up(MouseButton::Left) => self.end_drag(),
            _ => {}
        }
    }

    fn press(&mut self, p: Pos) {
        self.end_drag();
        self.finish_text();

        if p.1 == 0 {
            match ui::action_at(p.0) {
                Some(Action::Tool(tool)) => self.tool = tool,
                Some(Action::Color(i)) => self.set_color(i),
                None => {}
            }
            return;
        }
        if !self.in_canvas(p) {
            return;
        }

        match self.tool {
            Tool::Select => match self.hit(p) {
                Some(id) => {
                    self.selected = Some(id);
                    self.drag = Some(Drag::Move {
                        pre: self.objects.clone(),
                        members: self.move_members(id),
                        press: p,
                        offset: (0, 0),
                    });
                }
                None => self.selected = None,
            },
            Tool::Box => self.drag = Some(Drag::Box { start: p, cur: p }),
            Tool::Arrow => self.drag = Some(Drag::Arrow { start: p, cur: p }),
            Tool::Text => {
                self.text = Some(TextEdit {
                    origin: p,
                    text: String::new(),
                })
            }
            Tool::Pen => {
                let mut cells = BTreeMap::new();
                cells.insert(p, PEN_GLYPH);
                self.drag = Some(Drag::Pen { last: p, cells });
            }
        }
    }

    fn drag_to(&mut self, p: Pos) {
        let q = self.clamp_to_canvas(p);
        match &mut self.drag {
            Some(Drag::Box { cur, .. }) | Some(Drag::Arrow { cur, .. }) => *cur = q,
            Some(Drag::Pen { last, cells }) => {
                for pt in line_points(*last, q) {
                    cells.insert(pt, PEN_GLYPH);
                }
                *last = q;
            }
            Some(Drag::Move {
                pre,
                members,
                press,
                offset,
            }) => {
                let off = (q.0 - press.0, q.1 - press.1);
                *offset = off;
                self.objects = pre
                    .iter()
                    .map(|o| {
                        if members.contains(&o.id) {
                            o.translated(off.0, off.1)
                        } else {
                            o.clone()
                        }
                    })
                    .collect();
            }
            None => {}
        }
    }

    /// Completes the current drag, turning shape previews into objects.
    pub fn end_drag(&mut self) {
        let Some(drag) = self.drag.take() else {
            return;
        };
        match drag {
            Drag::Box { start, cur } => self.add_object(Kind::Box, box_cells(start, cur)),
            Drag::Arrow { start, cur } => self.add_object(Kind::Arrow, arrow_cells(start, cur)),
            Drag::Pen { cells, .. } => self.add_object(Kind::Pen, cells.into_iter().collect()),
            Drag::Move {
                pre, offset: (0, 0), ..
            } => drop(pre),
            Drag::Move { pre, .. } => self.record(pre),
        }
    }

    // ----- editing --------------------------------------------------------

    /// Ends text typing, keeping the text unless it is empty.
    pub fn finish_text(&mut self) {
        if let Some(t) = self.text.take() {
            let text = t.text.trim_end();
            if !text.is_empty() {
                self.add_object(Kind::Text, text_cells(t.origin, text));
            }
        }
    }

    fn add_object(&mut self, kind: Kind, cells: Cells) {
        if cells.is_empty() {
            return;
        }
        self.record(self.objects.clone());
        let id = self.next_id;
        self.next_id += 1;
        self.objects.push(Object {
            id,
            kind,
            color: self.color,
            cells,
        });
    }

    /// Pushes `before` as an undo step and clears the redo history.
    fn record(&mut self, before: Vec<Object>) {
        self.undo.push(before);
        if self.undo.len() > UNDO_LIMIT {
            self.undo.remove(0);
        }
        self.redo.clear();
    }

    fn set_color(&mut self, idx: usize) {
        self.color = idx;
        let Some(id) = self.selected else {
            return;
        };
        if let Some(pos) = self.objects.iter().position(|o| o.id == id)
            && self.objects[pos].color != idx
        {
            self.record(self.objects.clone());
            self.objects[pos].color = idx;
        }
    }

    fn delete_selected(&mut self) {
        let Some(id) = self.selected.take() else {
            return;
        };
        if self.objects.iter().any(|o| o.id == id) {
            self.record(self.objects.clone());
            self.objects.retain(|o| o.id != id);
        }
    }

    fn undo(&mut self) {
        self.finish_text();
        if let Some(prev) = self.undo.pop() {
            let current = std::mem::replace(&mut self.objects, prev);
            self.redo.push(current);
            self.fix_selection();
        }
    }

    fn redo(&mut self) {
        self.finish_text();
        if let Some(next) = self.redo.pop() {
            let current = std::mem::replace(&mut self.objects, next);
            self.undo.push(current);
            self.fix_selection();
        }
    }

    fn fix_selection(&mut self) {
        if let Some(id) = self.selected
            && !self.objects.iter().any(|o| o.id == id)
        {
            self.selected = None;
        }
    }
}
