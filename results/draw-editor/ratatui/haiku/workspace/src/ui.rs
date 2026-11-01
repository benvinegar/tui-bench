//! Rendering: toolbar (row 0), canvas (middle rows), status bar (last row), help overlay.

use ratatui::{
    Frame,
    buffer::{Buffer, Cell},
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Clear, Paragraph},
};

use crate::app::{App, Drag};
use crate::model::{PALETTE, Pos, Tool, arrow_cells, box_cells, text_cells};

const BAR_BG: Color = Color::Indexed(236);
const BAR_FG: Color = Color::Indexed(250);
const ACCENT: Color = Color::Cyan;
const SELECT_BG: Color = Color::Indexed(24);
const HELP_BG: Color = Color::Indexed(235);

/// What a toolbar cell does when clicked.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Tool(Tool),
    Color(usize),
}

#[derive(Clone, Copy)]
enum Item {
    Brand,
    Tool(Tool),
    Gap,
    Heading,
    Num(usize),
    Swatch(usize),
}

impl Item {
    fn text(self, color: usize) -> String {
        match self {
            Item::Brand => " DRAW ".into(),
            Item::Tool(t) => format!(" {} ({}) ", t.name(), t.key()),
            Item::Gap => "   ".into(),
            Item::Heading => " Color ".into(),
            Item::Num(i) if i == color => format!("[{}]", i + 1),
            Item::Num(i) => format!(" {} ", i + 1),
            Item::Swatch(_) => "██ ".into(),
        }
    }

    fn action(self) -> Option<Action> {
        match self {
            Item::Tool(t) => Some(Action::Tool(t)),
            Item::Num(i) | Item::Swatch(i) => Some(Action::Color(i)),
            Item::Brand | Item::Gap | Item::Heading => None,
        }
    }
}

fn toolbar_items() -> Vec<Item> {
    let mut items = vec![Item::Brand];
    items.extend(Tool::ALL.iter().map(|&t| Item::Tool(t)));
    items.push(Item::Gap);
    items.push(Item::Heading);
    for i in 0..PALETTE.len() {
        items.push(Item::Num(i));
        items.push(Item::Swatch(i));
    }
    items
}

/// The toolbar action under column `x`, if any.
pub fn action_at(x: i32) -> Option<Action> {
    if x < 0 {
        return None;
    }
    let mut start = 0;
    for item in toolbar_items() {
        let width = item.text(0).chars().count() as i32;
        if x >= start && x < start + width {
            return item.action();
        }
        start += width;
    }
    None
}

pub fn render(frame: &mut Frame, app: &App) {
    let area = frame.area();
    if area.height >= 1 {
        render_toolbar(frame, app, Rect::new(0, 0, area.width, 1));
    }
    if area.height >= 2 {
        render_status(frame, app, Rect::new(0, area.height - 1, area.width, 1));
    }
    let canvas = Rect::new(0, 1.min(area.height), area.width, area.height.saturating_sub(2));
    render_canvas(frame, app, canvas);
    if app.help {
        render_help(frame, area);
    }
}

fn render_toolbar(frame: &mut Frame, app: &App, area: Rect) {
    let bar = Style::new().fg(BAR_FG).bg(BAR_BG);
    let spans: Vec<Span> = toolbar_items()
        .into_iter()
        .map(|item| {
            let style = match item {
                Item::Brand => Style::new()
                    .fg(ACCENT)
                    .bg(BAR_BG)
                    .add_modifier(Modifier::BOLD),
                Item::Tool(t) if t == app.tool => Style::new()
                    .fg(Color::Black)
                    .bg(ACCENT)
                    .add_modifier(Modifier::BOLD),
                Item::Num(i) if i == app.color => Style::new()
                    .fg(Color::White)
                    .bg(BAR_BG)
                    .add_modifier(Modifier::BOLD | Modifier::UNDERLINED),
                Item::Swatch(i) => Style::new().fg(PALETTE[i].1).bg(BAR_BG),
                _ => bar,
            };
            Span::styled(item.text(app.color), style)
        })
        .collect();
    frame.render_widget(Paragraph::new(Line::from(spans)).style(bar), area);
}

fn render_status(frame: &mut Frame, app: &App, area: Rect) {
    let bar = Style::new().fg(BAR_FG).bg(BAR_BG);
    let pos = match app.mouse {
        Some((x, y)) => format!("x {x} y {y}"),
        None => "x - y -".to_string(),
    };
    let count = app.objects.len();
    let plural = if count == 1 { "" } else { "s" };
    let mut spans = vec![
        Span::styled(
            format!(" Tool: {} ", app.tool.name()),
            Style::new()
                .fg(Color::Black)
                .bg(ACCENT)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(format!(" {pos} │ {count} object{plural}"), bar),
    ];
    if let Some(obj) = app.selection() {
        spans.push(Span::styled(
            format!(" │ {}", obj.describe()),
            Style::new()
                .fg(Color::Yellow)
                .bg(BAR_BG)
                .add_modifier(Modifier::BOLD),
        ));
    }
    if app.text.is_some() {
        spans.push(Span::styled(" │ typing, enter or esc to finish", bar));
    }
    let right = " ? help │ ctrl+q quit ";
    let used: usize = spans.iter().map(|s| s.content.chars().count()).sum();
    let pad = (area.width as usize).saturating_sub(used + right.chars().count());
    spans.push(Span::styled(" ".repeat(pad), bar));
    spans.push(Span::styled(right, bar));
    frame.render_widget(Paragraph::new(Line::from(spans)).style(bar), area);
}

/// The buffer cell at canvas position `p`, if it lies inside `area`.
fn cell_at(buf: &mut Buffer, area: Rect, p: Pos) -> Option<&mut Cell> {
    let inside = p.0 >= i32::from(area.left())
        && p.0 < i32::from(area.right())
        && p.1 >= i32::from(area.top())
        && p.1 < i32::from(area.bottom());
    if !inside {
        return None;
    }
    buf.cell_mut((p.0 as u16, p.1 as u16))
}

fn put(buf: &mut Buffer, area: Rect, p: Pos, ch: char, style: Style) {
    if let Some(cell) = cell_at(buf, area, p) {
        cell.set_char(ch).set_style(style);
    }
}

fn render_canvas(frame: &mut Frame, app: &App, area: Rect) {
    if area.width == 0 || area.height == 0 {
        return;
    }
    let buf = frame.buffer_mut();

    for obj in &app.objects {
        let style = Style::new().fg(PALETTE[obj.color].1);
        for &(p, ch) in &obj.cells {
            if ch != ' ' {
                put(buf, area, p, ch, style);
            }
        }
    }

    if let Some(obj) = app.selection() {
        let (lo, hi) = obj.bounds();
        for y in lo.1..=hi.1 {
            for x in lo.0..=hi.0 {
                if let Some(cell) = cell_at(buf, area, (x, y)) {
                    cell.set_style(Style::new().bg(SELECT_BG));
                }
            }
        }
        for &(p, ch) in &obj.cells {
            if ch != ' '
                && let Some(cell) = cell_at(buf, area, p)
            {
                cell.set_style(Style::new().add_modifier(Modifier::BOLD));
            }
        }
    }

    let color = PALETTE[app.color].1;
    let preview = Style::new().fg(color);
    match &app.drag {
        Some(Drag::Box { start, cur }) => {
            for (p, ch) in box_cells(*start, *cur) {
                put(buf, area, p, ch, preview);
            }
        }
        Some(Drag::Arrow { start, cur }) => {
            for (p, ch) in arrow_cells(*start, *cur) {
                put(buf, area, p, ch, preview);
            }
        }
        Some(Drag::Pen { cells, .. }) => {
            for (&p, &ch) in cells {
                put(buf, area, p, ch, preview);
            }
        }
        Some(Drag::Move { .. }) | None => {}
    }

    if let Some(t) = &app.text {
        for (p, ch) in text_cells(t.origin, &t.text) {
            if ch != ' ' {
                put(buf, area, p, ch, preview);
            }
        }
        let len = t.text.chars().count() as i32;
        let cursor = (t.origin.0 + len, t.origin.1);
        if let Some(cell) = cell_at(buf, area, cursor) {
            cell.set_char(' ')
                .set_style(Style::new().bg(Color::White).fg(Color::Black));
        }
    }
}

fn help_lines() -> Vec<Line<'static>> {
    let head = |s: &'static str| {
        Line::from(Span::styled(
            s,
            Style::new().fg(ACCENT).add_modifier(Modifier::BOLD),
        ))
    };
    let key = |k: &'static str, v: &'static str| {
        Line::from(vec![
            Span::styled(format!("  {k:<9}"), Style::new().fg(Color::Yellow)),
            Span::raw(v),
        ])
    };
    vec![
        head("Tools"),
        key("v", "Select: click an object, drag to move it"),
        key("b", "Box: drag from one corner to the opposite one"),
        key("a", "Arrow: drag start to end (elbow when diagonal)"),
        key("t", "Text: click a cell, type, enter or esc to finish"),
        key("p", "Pen: drag to paint blocks"),
        Line::raw(""),
        head("Other keys"),
        key("1-6", "Color: white red yellow green cyan magenta"),
        key("delete", "Delete the selected object"),
        key("esc", "Clear the selection"),
        key("ctrl+z", "Undo (draw, move, recolor, delete)"),
        key("ctrl+y", "Redo"),
        key("?", "Toggle this help"),
        key("ctrl+q", "Quit"),
    ]
}

fn render_help(frame: &mut Frame, area: Rect) {
    let lines = help_lines();
    let width = 66.min(area.width);
    let height = (lines.len() as u16 + 2).min(area.height);
    let rect = Rect::new(
        area.x + (area.width - width) / 2,
        area.y + (area.height - height) / 2,
        width,
        height,
    );
    let bg = Style::new().bg(HELP_BG);
    frame.render_widget(Clear, rect);
    frame.render_widget(
        Paragraph::new(lines).style(bg).block(
            Block::bordered()
                .title(" Help (? or esc to close) ")
                .border_style(Style::new().fg(ACCENT))
                .style(bg),
        ),
        rect,
    );
}
