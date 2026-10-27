pub mod widgets;

pub fn header(city: &str) -> String {
    format!("── Weather for {city} ──")
}

pub fn footer(days: usize) -> String {
    format!("{days} day(s) shown · data cached locally")
}
