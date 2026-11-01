#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Op {
    Add,
    Sub,
    Mul,
    Div,
}

impl Op {
    pub fn symbol(self) -> &'static str {
        match self {
            Op::Add => "+",
            Op::Sub => "−",
            Op::Mul => "×",
            Op::Div => "÷",
        }
    }

    fn apply(self, a: f64, b: f64) -> Option<f64> {
        match self {
            Op::Add => Some(a + b),
            Op::Sub => Some(a - b),
            Op::Mul => Some(a * b),
            Op::Div => {
                if b == 0.0 {
                    None
                } else {
                    Some(a / b)
                }
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Key {
    Digit(char),
    Dot,
    Op(Op),
    Equals,
    Clear,
    Backspace,
}

const MAX_DIGITS: usize = 12;

pub struct Calc {
    entry: String,
    acc: Option<f64>,
    op: Option<Op>,
    /// The next digit starts a new number (set after an operator or `=`).
    fresh: bool,
    error: bool,
}

impl Calc {
    pub fn new() -> Self {
        Calc { entry: "0".to_string(), acc: None, op: None, fresh: false, error: false }
    }

    pub fn entry(&self) -> &str {
        &self.entry
    }

    /// The pending calculation shown above the value, e.g. "12 +".
    pub fn expression(&self) -> String {
        match (self.acc, self.op) {
            (Some(a), Some(op)) => format!("{} {}", format_value(a), op.symbol()),
            _ => String::new(),
        }
    }

    fn reset(&mut self) {
        *self = Calc::new();
    }

    fn current(&self) -> f64 {
        self.entry.trim_end_matches('.').parse::<f64>().unwrap_or(0.0)
    }

    fn digits(&self) -> usize {
        self.entry.chars().filter(|c| c.is_ascii_digit()).count()
    }

    fn fail(&mut self) {
        self.entry = "Error".to_string();
        self.acc = None;
        self.op = None;
        self.fresh = true;
        self.error = true;
    }

    pub fn press(&mut self, key: Key) {
        if self.error {
            match key {
                Key::Clear => {
                    self.reset();
                    return;
                }
                Key::Digit(_) | Key::Dot => self.reset(),
                _ => return,
            }
        }
        match key {
            Key::Clear => self.reset(),
            Key::Digit(d) => {
                if self.fresh {
                    self.entry = d.to_string();
                    self.fresh = false;
                } else if self.entry == "0" {
                    self.entry = d.to_string();
                } else if self.digits() < MAX_DIGITS {
                    self.entry.push(d);
                }
            }
            Key::Dot => {
                if self.fresh {
                    self.entry = "0.".to_string();
                    self.fresh = false;
                } else if !self.entry.contains('.') {
                    self.entry.push('.');
                }
            }
            Key::Op(op) => {
                if self.op.is_some() && self.fresh {
                    // Pressing an operator twice just changes the operator.
                    self.op = Some(op);
                    return;
                }
                let cur = self.current();
                match (self.acc, self.op) {
                    (Some(a), Some(prev)) => match prev.apply(a, cur) {
                        Some(r) => {
                            self.acc = Some(r);
                            self.entry = format_value(r);
                        }
                        None => {
                            self.fail();
                            return;
                        }
                    },
                    _ => self.acc = Some(cur),
                }
                self.op = Some(op);
                self.fresh = true;
            }
            Key::Equals => {
                if let (Some(a), Some(op)) = (self.acc, self.op) {
                    let rhs = if self.fresh { a } else { self.current() };
                    match op.apply(a, rhs) {
                        Some(r) => {
                            self.entry = format_value(r);
                            self.acc = None;
                            self.op = None;
                            self.fresh = true;
                        }
                        None => self.fail(),
                    }
                }
            }
            Key::Backspace => {
                if !self.fresh {
                    self.entry.pop();
                    if self.entry.is_empty() {
                        self.entry = "0".to_string();
                    }
                }
            }
        }
    }
}

pub fn format_value(v: f64) -> String {
    if !v.is_finite() {
        return "Error".to_string();
    }
    if v == v.trunc() && v.abs() < 1e12 {
        return format!("{}", v as i64);
    }
    let s = format!("{:.9}", v);
    let s = s.trim_end_matches('0').trim_end_matches('.').to_string();
    if s.len() > 13 { format!("{:.6e}", v) } else { s }
}

/// A keypad button in content coordinates (relative to the window's content area).
pub struct Button {
    pub label: &'static str,
    pub key: Key,
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

pub struct Layout {
    pub display_h: i32,
    pub buttons: Vec<Button>,
}

const GRID: [[&str; 4]; 4] = [
    ["7", "8", "9", "÷"],
    ["4", "5", "6", "×"],
    ["1", "2", "3", "−"],
    ["0", ".", "=", "+"],
];

fn key_for(label: &str) -> Key {
    match label {
        "÷" => Key::Op(Op::Div),
        "×" => Key::Op(Op::Mul),
        "−" => Key::Op(Op::Sub),
        "+" => Key::Op(Op::Add),
        "=" => Key::Equals,
        "." => Key::Dot,
        "C" => Key::Clear,
        d => Key::Digit(d.chars().next().unwrap_or('0')),
    }
}

/// Lays out the display and keypad for a content area of `w` x `h` cells.
/// Designed for 26 x 15 and scaled down for smaller windows.
pub fn layout(w: i32, h: i32) -> Layout {
    let w = w.max(0);
    let h = h.max(0);
    let display_h = (h / 5).clamp(1, 3);
    let gap = if h >= 14 { 1 } else { 0 };
    let keys_h = (h - display_h - 2 * gap).max(0);
    let th = (keys_h / 5).max(1);
    let tile_w = ((w - 3) / 4).max(1);
    let grid_w = 4 * tile_w + 3;
    let ox = ((w - grid_w) / 2).max(0);
    let mut buttons = Vec::new();
    for (r, row) in GRID.iter().enumerate() {
        for (c, &label) in row.iter().enumerate() {
            buttons.push(Button {
                label,
                key: key_for(label),
                x: ox + c as i32 * (tile_w + 1),
                y: display_h + gap + r as i32 * th,
                w: tile_w,
                h: th,
            });
        }
    }
    buttons.push(Button {
        label: "C",
        key: Key::Clear,
        x: ox,
        y: display_h + gap + 4 * th + gap,
        w: grid_w,
        h: th,
    });
    Layout { display_h, buttons }
}
