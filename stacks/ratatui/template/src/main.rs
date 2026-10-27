use std::io;

use crossterm::event::{self, Event, KeyCode, KeyEventKind};
use ratatui::{
    DefaultTerminal, Frame,
    layout::Alignment,
    style::{Color, Style, Stylize},
    widgets::{Block, Paragraph},
};

fn main() -> io::Result<()> {
    // ratatui::run sets up the terminal (raw mode + alternate screen) and restores it on exit.
    ratatui::run(app)
}

fn app(terminal: &mut DefaultTerminal) -> io::Result<()> {
    loop {
        terminal.draw(render)?;
        if let Event::Key(key) = event::read()? {
            if key.kind == KeyEventKind::Press && key.code == KeyCode::Char('q') {
                return Ok(());
            }
        }
    }
}

fn render(frame: &mut Frame) {
    let block = Block::bordered()
        .title(" hello ")
        .border_style(Style::new().fg(Color::Cyan));
    let text = Paragraph::new("Hello, ratatui! Press q to quit.".bold())
        .alignment(Alignment::Center)
        .block(block);
    frame.render_widget(text, frame.area());
}
