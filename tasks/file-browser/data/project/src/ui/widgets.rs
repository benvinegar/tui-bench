use crate::Forecast;

fn to_unit(celsius: f32, fahrenheit: bool) -> f32 {
    if fahrenheit { celsius * 9.0 / 5.0 + 32.0 } else { celsius }
}

fn icon(summary: &str) -> &'static str {
    match summary {
        "Sunny" => "☀",
        "Cloudy" => "☁",
        "Rain" => "☂",
        _ => "?",
    }
}

pub fn forecast_row(f: &Forecast, fahrenheit: bool) -> String {
    let unit = if fahrenheit { "°F" } else { "°C" };
    format!(
        "{:<4} {} {:>5.1}{unit} / {:>5.1}{unit}  rain {:>3}%  {}",
        f.day,
        icon(&f.summary),
        to_unit(f.high, fahrenheit),
        to_unit(f.low, fahrenheit),
        f.rain_chance,
        f.summary,
    )
}
