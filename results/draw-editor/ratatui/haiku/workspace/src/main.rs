mod app;
mod model;
mod ui;

use std::io;

use crossterm::{
    event::{DisableMouseCapture, EnableMouseCapture},
    execute,
};

fn main() -> io::Result<()> {
    // Mouse capture is a terminal mode that ratatui does not restore on its own,
    // so turn it off on panic too (ratatui's hook restores the screen itself).
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = execute!(io::stdout(), DisableMouseCapture);
        default_hook(info);
    }));

    execute!(io::stdout(), EnableMouseCapture)?;
    // ratatui::run sets up the terminal (raw mode + alternate screen) and restores it on exit.
    let result = ratatui::run(|terminal| app::App::new().run(terminal));
    let _ = execute!(io::stdout(), DisableMouseCapture);
    result
}
