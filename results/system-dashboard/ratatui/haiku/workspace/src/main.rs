mod app;
mod data;
mod ui;

use std::{io, path::Path, time::Instant};

use crossterm::event::{self, Event, KeyEventKind};
use ratatui::DefaultTerminal;

use app::{Action, App};
use data::Metrics;

fn main() -> io::Result<()> {
    let metrics = match data::load(Path::new("data/metrics.json")) {
        Ok(metrics) => metrics,
        Err(err) => {
            eprintln!("app: {err}");
            std::process::exit(1);
        }
    };
    // ratatui::run sets up the terminal and restores it on exit, including on panic.
    ratatui::run(|terminal| run_app(terminal, metrics))
}

fn run_app(terminal: &mut DefaultTerminal, metrics: Metrics) -> io::Result<()> {
    let mut app = App::new(metrics, Instant::now());
    loop {
        app.update(Instant::now());
        terminal.draw(|frame| ui::render(frame, &mut app))?;

        let timeout = app.next_timeout(Instant::now());
        if event::poll(timeout)? {
            if let Event::Key(key) = event::read()? {
                if key.kind == KeyEventKind::Press
                    && app.handle_key(key, Instant::now()) == Action::Quit
                {
                    break;
                }
            }
        }
    }
    Ok(())
}
