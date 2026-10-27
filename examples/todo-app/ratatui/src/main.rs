use std::{fs, io};

use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyEventKind};
use ratatui::{
    DefaultTerminal, Frame,
    layout::{Constraint, Flex, Layout, Rect},
    style::{Color, Modifier, Style, Stylize},
    text::{Line, Span},
    widgets::{Block, BorderType, Clear, List, ListItem, ListState, Padding, Paragraph, Tabs, Wrap},
};
use serde::Deserialize;

#[derive(Deserialize, Clone)]
struct Todo {
    #[allow(dead_code)]
    id: u32,
    title: String,
    done: bool,
    priority: String,
    tags: Vec<String>,
}

#[derive(Clone, Copy, PartialEq)]
enum Filter {
    All,
    Active,
    Done,
}

enum Mode {
    Normal,
    Adding(String),
    ConfirmDelete(usize),
    Help,
}

struct App {
    todos: Vec<Todo>,
    filter: Filter,
    list: ListState,
    mode: Mode,
    quit: bool,
}

const ACCENT: Color = Color::Rgb(122, 162, 247);
const MUTED: Color = Color::Rgb(110, 118, 140);

impl App {
    fn visible(&self) -> Vec<usize> {
        (0..self.todos.len())
            .filter(|&i| match self.filter {
                Filter::All => true,
                Filter::Active => !self.todos[i].done,
                Filter::Done => self.todos[i].done,
            })
            .collect()
    }

    fn clamp_selection(&mut self) {
        let n = self.visible().len();
        let sel = match (n, self.list.selected()) {
            (0, _) => None,
            (n, Some(i)) => Some(i.min(n - 1)),
            (_, None) => Some(0),
        };
        self.list.select(sel);
    }

    fn selected_todo(&self) -> Option<usize> {
        self.list.selected().and_then(|i| self.visible().get(i).copied())
    }

    fn on_key(&mut self, key: KeyEvent) {
        match &mut self.mode {
            Mode::Adding(text) => match key.code {
                KeyCode::Enter => {
                    let title = text.trim().to_string();
                    if !title.is_empty() {
                        let id = self.todos.iter().map(|t| t.id).max().unwrap_or(0) + 1;
                        self.todos.push(Todo { id, title, done: false, priority: "medium".into(), tags: vec![] });
                        if self.filter != Filter::Done {
                            self.list.select(Some(self.visible().len() - 1));
                        }
                    }
                    self.mode = Mode::Normal;
                }
                KeyCode::Esc => self.mode = Mode::Normal,
                KeyCode::Backspace => {
                    text.pop();
                }
                KeyCode::Char(c) => text.push(c),
                _ => {}
            },
            Mode::ConfirmDelete(idx) => {
                if key.code == KeyCode::Char('y') {
                    self.todos.remove(*idx);
                }
                self.mode = Mode::Normal;
                self.clamp_selection();
            }
            Mode::Help => {
                if matches!(key.code, KeyCode::Char('?') | KeyCode::Esc) {
                    self.mode = Mode::Normal;
                }
            }
            Mode::Normal => match key.code {
                KeyCode::Char('q') => self.quit = true,
                KeyCode::Char('j') | KeyCode::Down => {
                    let n = self.visible().len();
                    if let Some(i) = self.list.selected() {
                        self.list.select(Some((i + 1).min(n.saturating_sub(1))));
                    }
                }
                KeyCode::Char('k') | KeyCode::Up => {
                    if let Some(i) = self.list.selected() {
                        self.list.select(Some(i.saturating_sub(1)));
                    }
                }
                KeyCode::Char(' ') => {
                    if let Some(i) = self.selected_todo() {
                        self.todos[i].done = !self.todos[i].done;
                        self.clamp_selection();
                    }
                }
                KeyCode::Char('a') => self.mode = Mode::Adding(String::new()),
                KeyCode::Char('d') => {
                    if let Some(i) = self.selected_todo() {
                        self.mode = Mode::ConfirmDelete(i);
                    }
                }
                KeyCode::Char('1') => self.set_filter(Filter::All),
                KeyCode::Char('2') => self.set_filter(Filter::Active),
                KeyCode::Char('3') => self.set_filter(Filter::Done),
                KeyCode::Char('?') => self.mode = Mode::Help,
                _ => {}
            },
        }
    }

    fn set_filter(&mut self, f: Filter) {
        self.filter = f;
        self.list.select(Some(0));
        self.clamp_selection();
    }
}

fn main() -> io::Result<()> {
    let todos: Vec<Todo> = serde_json::from_str(&fs::read_to_string("data/todos.json")?)?;
    let mut app = App { todos, filter: Filter::All, list: ListState::default().with_selected(Some(0)), mode: Mode::Normal, quit: false };
    ratatui::run(|terminal: &mut DefaultTerminal| {
        while !app.quit {
            terminal.draw(|f| render(f, &mut app))?;
            if let Event::Key(key) = event::read()? {
                if key.kind == KeyEventKind::Press {
                    app.on_key(key);
                }
            }
        }
        Ok(())
    })
}

fn priority_span(p: &str) -> Span<'static> {
    match p {
        "high" => Span::styled(" ▲ high ", Style::new().fg(Color::Rgb(247, 118, 142))),
        "medium" => Span::styled(" ● med  ", Style::new().fg(Color::Rgb(224, 175, 104))),
        _ => Span::styled(" ▼ low  ", Style::new().fg(Color::Rgb(115, 218, 202))),
    }
}

fn render(frame: &mut Frame, app: &mut App) {
    let [header, tabs, body, footer] =
        Layout::vertical([Constraint::Length(1), Constraint::Length(2), Constraint::Min(3), Constraint::Length(1)]).areas(frame.area());

    let active = app.todos.iter().filter(|t| !t.done).count();
    let done = app.todos.len() - active;
    frame.render_widget(
        Line::from(vec![
            " ✓ Todos ".bold().fg(Color::Black).bg(ACCENT),
            "  ".into(),
            Span::styled(format!("{active} active"), Style::new().fg(Color::White)),
            Span::styled("  ·  ", Style::new().fg(MUTED)),
            Span::styled(format!("{done} done"), Style::new().fg(MUTED)),
        ]),
        header,
    );

    let tab_idx = match app.filter {
        Filter::All => 0,
        Filter::Active => 1,
        Filter::Done => 2,
    };
    frame.render_widget(
        Tabs::new(vec!["1 All", "2 Active", "3 Done"])
            .select(tab_idx)
            .style(Style::new().fg(MUTED))
            .highlight_style(Style::new().fg(ACCENT).bold().underlined())
            .padding(" ", " ")
            .divider("│"),
        tabs.inner(ratatui::layout::Margin { horizontal: 0, vertical: 0 }).offset(ratatui::layout::Offset { x: 0, y: 1 }).intersection(tabs),
    );

    let block = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(Style::new().fg(MUTED))
        .padding(Padding::horizontal(1));
    let visible = app.visible();
    if visible.is_empty() {
        let msg = match app.filter {
            Filter::Done => "Nothing completed yet — press space on a todo to finish it.",
            Filter::Active => "All done! 🎉 Press a to add something new.",
            Filter::All => "No todos. Press a to add one.",
        };
        frame.render_widget(Paragraph::new(msg).fg(MUTED).centered().wrap(Wrap { trim: true }).block(block.padding(Padding::top(body.height.saturating_sub(3) / 2))), body);
    } else {
        let width = body.width.saturating_sub(4) as usize;
        let items: Vec<ListItem> = visible
            .iter()
            .map(|&i| {
                let t = &app.todos[i];
                let check = if t.done { Span::styled(" ✔ ", Style::new().fg(Color::Rgb(158, 206, 106))) } else { Span::styled(" ○ ", Style::new().fg(MUTED)) };
                let title_style = if t.done { Style::new().fg(MUTED).add_modifier(Modifier::CROSSED_OUT) } else { Style::new().fg(Color::White) };
                let tags: String = t.tags.iter().map(|g| format!("#{g} ")).collect();
                let used = 3 + 8 + tags.chars().count();
                let title_w = width.saturating_sub(used).max(4);
                let mut title: String = t.title.chars().take(title_w).collect();
                if t.title.chars().count() > title_w {
                    title.pop();
                    title.push('…');
                }
                let pad = " ".repeat(title_w.saturating_sub(title.chars().count()));
                ListItem::new(Line::from(vec![
                    check,
                    Span::styled(title, title_style),
                    pad.into(),
                    priority_span(&t.priority),
                    Span::styled(tags, Style::new().fg(Color::Rgb(187, 154, 247))),
                ]))
            })
            .collect();
        let list = List::new(items).block(block).highlight_style(Style::new().bg(Color::Rgb(41, 46, 66)).bold()).highlight_symbol("");
        frame.render_stateful_widget(list, body, &mut app.list);
    }

    let hints: Vec<Span> = [("j/k", "move"), ("space", "toggle"), ("a", "add"), ("d", "delete"), ("1-3", "filter"), ("?", "help"), ("q", "quit")]
        .iter()
        .flat_map(|(k, v)| [Span::styled(format!(" {k} "), Style::new().fg(ACCENT).bold()), Span::styled(format!("{v}  "), Style::new().fg(MUTED))])
        .collect();
    frame.render_widget(Line::from(hints), footer);

    match &app.mode {
        Mode::Adding(text) => {
            let area = popup(frame.area(), 56, 5);
            frame.render_widget(Clear, area);
            let block = Block::bordered().border_type(BorderType::Rounded).title(" New todo ").title_bottom(Line::from(" enter add · esc cancel ").right_aligned()).border_style(Style::new().fg(ACCENT)).padding(Padding::horizontal(1));
            let inner = block.inner(area);
            frame.render_widget(block, area);
            frame.render_widget(Paragraph::new(Line::from(vec![Span::styled("› ", Style::new().fg(ACCENT)), text.clone().into()])), inner.offset(ratatui::layout::Offset { x: 0, y: 1 }).intersection(inner));
            frame.set_cursor_position((inner.x + 2 + text.chars().count() as u16, inner.y + 1));
        }
        Mode::ConfirmDelete(i) => {
            let area = popup(frame.area(), 50, 6);
            frame.render_widget(Clear, area);
            let block = Block::bordered().border_type(BorderType::Rounded).title(" Delete todo? ").border_style(Style::new().fg(Color::Rgb(247, 118, 142))).padding(Padding::horizontal(1));
            frame.render_widget(
                Paragraph::new(vec![
                    Line::from(Span::styled(format!("“{}”", app.todos[*i].title), Style::new().bold())),
                    Line::default(),
                    Line::from(vec![Span::styled(" y ", Style::new().fg(Color::Black).bg(Color::Rgb(247, 118, 142))), " delete   ".into(), Span::styled("any other key", Style::new().fg(MUTED)), " cancel".into()]),
                ])
                .wrap(Wrap { trim: true })
                .block(block),
                area,
            );
        }
        Mode::Help => {
            let area = popup(frame.area(), 44, 13);
            frame.render_widget(Clear, area);
            let rows = [("j / ↓", "move down"), ("k / ↑", "move up"), ("space", "toggle done"), ("a", "add a todo"), ("d", "delete (asks first)"), ("1 2 3", "all / active / done"), ("?", "toggle this help"), ("q", "quit")];
            let lines: Vec<Line> = rows.iter().map(|(k, v)| Line::from(vec![Span::styled(format!("{k:>8}  "), Style::new().fg(ACCENT).bold()), (*v).into()])).collect();
            frame.render_widget(Paragraph::new(lines).block(Block::bordered().border_type(BorderType::Rounded).title(" Keys ").title_bottom(Line::from(" ? or esc to close ").right_aligned()).border_style(Style::new().fg(ACCENT)).padding(Padding::uniform(1))), area);
        }
        Mode::Normal => {}
    }
}

fn popup(area: Rect, w: u16, h: u16) -> Rect {
    let [v] = Layout::vertical([Constraint::Length(h)]).flex(Flex::Center).areas(area);
    let [r] = Layout::horizontal([Constraint::Length(w.min(area.width))]).flex(Flex::Center).areas(v);
    r
}
