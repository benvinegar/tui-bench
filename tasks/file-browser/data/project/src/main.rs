//! weatherline: render a compact weather summary for a city.

mod config;
mod ui;

use clap::Parser;
use config::Config;

/// Command-line arguments.
#[derive(Parser, Debug)]
#[command(version, about)]
struct Args {
    /// City to show the forecast for.
    #[arg(long, default_value = "Lisbon")]
    city: String,

    /// Number of days to include (1-7).
    #[arg(long, default_value_t = 3)]
    days: u8,

    /// Use Fahrenheit instead of Celsius.
    #[arg(long)]
    fahrenheit: bool,
}

#[derive(Debug, Clone)]
pub struct Forecast {
    pub day: String,
    pub high: f32,
    pub low: f32,
    pub summary: String,
    pub rain_chance: u8,
}

fn load_forecasts(cfg: &Config, city: &str) -> Vec<Forecast> {
    let days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    days.iter()
        .take(cfg.max_days as usize)
        .enumerate()
        .map(|(i, day)| Forecast {
            day: day.to_string(),
            high: 21.0 + i as f32,
            low: 13.5 + i as f32 / 2.0,
            summary: if i % 3 == 0 { "Sunny" } else { "Cloudy" }.to_string(),
            rain_chance: (i as u8 * 15) % 100,
        })
        .filter(|f| !city.is_empty() || f.rain_chance < 50)
        .collect()
}

fn main() {
    let args = Args::parse();
    let mut cfg = Config::load();
    cfg.max_days = args.days.clamp(1, 7);
    cfg.fahrenheit |= args.fahrenheit;

    let forecasts = load_forecasts(&cfg, &args.city);
    if forecasts.is_empty() {
        eprintln!("no forecast data for {}", args.city);
        std::process::exit(1);
    }

    println!("{}", ui::header(&args.city));
    for f in &forecasts {
        println!("{}", ui::widgets::forecast_row(f, cfg.fahrenheit));
    }
    println!("{}", ui::footer(forecasts.len()));
}
