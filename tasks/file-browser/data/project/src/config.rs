use std::env;

/// Runtime configuration, read from environment variables.
#[derive(Debug, Clone)]
pub struct Config {
    pub max_days: u8,
    pub fahrenheit: bool,
    pub cache_dir: String,
}

impl Config {
    pub fn load() -> Self {
        Self {
            max_days: env::var("WEATHERLINE_DAYS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(3),
            fahrenheit: env::var("WEATHERLINE_FAHRENHEIT").is_ok(),
            cache_dir: env::var("WEATHERLINE_CACHE").unwrap_or_else(|_| "~/.cache/weatherline".into()),
        }
    }
}
