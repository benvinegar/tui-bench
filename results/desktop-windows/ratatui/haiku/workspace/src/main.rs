mod app;
mod calc;
mod data;
mod notes;
mod ui;

use std::io::{self, stdout};

use crossterm::{
    event::{self, DisableMouseCapture, EnableMouseCapture, Event},
    execute,
};
use ratatui::DefaultTerminal;

use app::App;

fn main() -> io::Result<()> {
    let mut terminal = ratatui::init();
    // Button-motion mouse tracking so drags reach the app.
    let _ = execute!(stdout(), EnableMouseCapture);

    // Make sure the mouse is released even if the app panics.
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = execute!(stdout(), DisableMouseCapture);
        default_hook(info);
    }));

    let size = terminal.size()?;
    let mut app = App::new(size.width as i32, size.height as i32);
    let result = run(&mut terminal, &mut app);

    let _ = execute!(stdout(), DisableMouseCapture);
    ratatui::restore();
    result
}

fn run(terminal: &mut DefaultTerminal, app: &mut App) -> io::Result<()> {
    loop {
        terminal.draw(|frame| ui::draw(frame, app))?;
        if app.quit {
            return Ok(());
        }
        match event::read()? {
            Event::Key(key) => app.on_key(key),
            Event::Mouse(mouse) => app.on_mouse(mouse),
            Event::Resize(cols, rows) => app.on_resize(cols as i32, rows as i32),
            _ => {}
        }
    }
}
