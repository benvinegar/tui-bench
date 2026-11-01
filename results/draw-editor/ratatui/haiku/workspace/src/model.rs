//! Document model: drawn objects, shape geometry and tool metadata.

use std::collections::BTreeMap;
use std::ops::RangeInclusive;

use ratatui::style::Color;

/// A screen cell, which is also a canvas cell. Signed so that objects moved
/// partly off the visible area keep their shape.
pub type Pos = (i32, i32);

/// The glyphs of an object, each with its position.
pub type Cells = Vec<(Pos, char)>;

/// Colors available for new objects, selected with keys `1`-`6`.
pub const PALETTE: [(&str, Color); 6] = [
    ("white", Color::White),
    ("red", Color::Red),
    ("yellow", Color::Yellow),
    ("green", Color::Green),
    ("cyan", Color::Cyan),
    ("magenta", Color::Magenta),
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tool {
    Select,
    Box,
    Arrow,
    Text,
    Pen,
}

impl Tool {
    pub const ALL: [Tool; 5] = [Tool::Select, Tool::Box, Tool::Arrow, Tool::Text, Tool::Pen];

    pub fn name(self) -> &'static str {
        match self {
            Tool::Select => "Select",
            Tool::Box => "Box",
            Tool::Arrow => "Arrow",
            Tool::Text => "Text",
            Tool::Pen => "Pen",
        }
    }

    pub fn key(self) -> char {
        match self {
            Tool::Select => 'v',
            Tool::Box => 'b',
            Tool::Arrow => 'a',
            Tool::Text => 't',
            Tool::Pen => 'p',
        }
    }

    pub fn from_key(c: char) -> Option<Tool> {
        Tool::ALL.into_iter().find(|t| t.key() == c)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Box,
    Arrow,
    Text,
    Pen,
}

impl Kind {
    pub fn name(self) -> &'static str {
        match self {
            Kind::Box => "Box",
            Kind::Arrow => "Arrow",
            Kind::Text => "Text",
            Kind::Pen => "Pen",
        }
    }
}

/// A drawn object. Its cells are the only thing that is rendered and hit-tested.
#[derive(Clone, Debug)]
pub struct Object {
    pub id: u64,
    pub kind: Kind,
    /// Index into [`PALETTE`].
    pub color: usize,
    pub cells: Cells,
}

impl Object {
    /// Inclusive (min, max) corners of the cells, spaces included.
    pub fn bounds(&self) -> (Pos, Pos) {
        if self.cells.is_empty() {
            return ((0, 0), (0, 0));
        }
        let mut lo = (i32::MAX, i32::MAX);
        let mut hi = (i32::MIN, i32::MIN);
        for &((x, y), _) in &self.cells {
            lo = (lo.0.min(x), lo.1.min(y));
            hi = (hi.0.max(x), hi.1.max(y));
        }
        (lo, hi)
    }

    /// True when a visible (non-space) cell of this object sits at `p`.
    pub fn hit(&self, p: Pos) -> bool {
        self.cells.iter().any(|&(q, ch)| q == p && ch != ' ')
    }

    pub fn translated(&self, dx: i32, dy: i32) -> Object {
        let mut moved = self.clone();
        for (pos, _) in moved.cells.iter_mut() {
            pos.0 += dx;
            pos.1 += dy;
        }
        moved
    }

    /// Status-bar description, e.g. `Box 26×9 at 5,4`.
    pub fn describe(&self) -> String {
        let (lo, hi) = self.bounds();
        format!(
            "{} {}×{} at {},{}",
            self.kind.name(),
            hi.0 - lo.0 + 1,
            hi.1 - lo.1 + 1,
            lo.0,
            lo.1
        )
    }
}

fn span(a: i32, b: i32) -> RangeInclusive<i32> {
    a.min(b)..=a.max(b)
}

/// A rectangle whose opposite corners are `a` and `b`, drawn with box characters.
pub fn box_cells(a: Pos, b: Pos) -> Cells {
    let (x0, x1) = (a.0.min(b.0), a.0.max(b.0));
    let (y0, y1) = (a.1.min(b.1), a.1.max(b.1));
    let mut m: BTreeMap<Pos, char> = BTreeMap::new();
    if x0 == x1 && y0 == y1 {
        m.insert((x0, y0), '□');
    } else if x0 == x1 {
        for y in y0..=y1 {
            m.insert((x0, y), '│');
        }
    } else if y0 == y1 {
        for x in x0..=x1 {
            m.insert((x, y0), '─');
        }
    } else {
        for x in x0..=x1 {
            m.insert((x, y0), '─');
            m.insert((x, y1), '─');
        }
        for y in y0..=y1 {
            m.insert((x0, y), '│');
            m.insert((x1, y), '│');
        }
        m.insert((x0, y0), '┌');
        m.insert((x1, y0), '┐');
        m.insert((x0, y1), '└');
        m.insert((x1, y1), '┘');
    }
    m.into_iter().collect()
}

/// A straight arrow when horizontal or vertical, otherwise an elbow that runs
/// horizontally first and then vertically. The end cell holds the arrowhead.
pub fn arrow_cells(from: Pos, to: Pos) -> Cells {
    if from == to {
        return Vec::new();
    }
    let (x0, y0) = from;
    let (x1, y1) = to;
    let mut m: BTreeMap<Pos, char> = BTreeMap::new();
    if y0 == y1 {
        for x in span(x0, x1) {
            m.insert((x, y0), '─');
        }
        m.insert(to, if x1 > x0 { '▶' } else { '◀' });
    } else if x0 == x1 {
        for y in span(y0, y1) {
            m.insert((x0, y), '│');
        }
        m.insert(to, if y1 > y0 { '▼' } else { '▲' });
    } else {
        let dx = (x1 - x0).signum();
        let dy = (y1 - y0).signum();
        for x in span(x0, x1) {
            m.insert((x, y0), '─');
        }
        for y in span(y0, y1) {
            m.insert((x1, y), '│');
        }
        let corner = match (dx > 0, dy > 0) {
            (true, true) => '┐',
            (true, false) => '┘',
            (false, true) => '┌',
            (false, false) => '└',
        };
        m.insert((x1, y0), corner);
        m.insert(to, if dy > 0 { '▼' } else { '▲' });
    }
    m.into_iter().collect()
}

/// Every cell on the Bresenham line from `a` to `b`, both ends included.
pub fn line_points(a: Pos, b: Pos) -> Vec<Pos> {
    let (mut x, mut y) = a;
    let dx = (b.0 - a.0).abs();
    let sx = if a.0 < b.0 { 1 } else { -1 };
    let dy = -(b.1 - a.1).abs();
    let sy = if a.1 < b.1 { 1 } else { -1 };
    let mut err = dx + dy;
    let mut out = Vec::new();
    loop {
        out.push((x, y));
        if x == b.0 && y == b.1 {
            break;
        }
        let e2 = 2 * err;
        if e2 >= dy {
            err += dy;
            x += sx;
        }
        if e2 <= dx {
            err += dx;
            y += sy;
        }
    }
    out
}

/// One cell per character, starting at `origin`. Spaces are kept so that the
/// object's bounds match what was typed, but they are never drawn or hit.
pub fn text_cells(origin: Pos, text: &str) -> Cells {
    text.chars()
        .enumerate()
        .map(|(i, ch)| ((origin.0 + i as i32, origin.1), ch))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(cells: &Cells, p: Pos) -> Option<char> {
        cells.iter().find(|(q, _)| *q == p).map(|(_, c)| *c)
    }

    #[test]
    fn box_has_corners_and_perimeter_only() {
        let c = box_cells((2, 3), (5, 6));
        assert_eq!(at(&c, (2, 3)), Some('┌'));
        assert_eq!(at(&c, (5, 3)), Some('┐'));
        assert_eq!(at(&c, (2, 6)), Some('└'));
        assert_eq!(at(&c, (5, 6)), Some('┘'));
        assert_eq!(c.len(), 2 * 4 + 2 * 2);
        assert_eq!(at(&c, (3, 4)), None);
    }

    #[test]
    fn box_drawn_from_bottom_right_is_the_same() {
        assert_eq!(box_cells((5, 6), (2, 3)), box_cells((2, 3), (5, 6)));
    }

    #[test]
    fn elbow_goes_horizontal_then_vertical() {
        let c = arrow_cells((0, 0), (4, 3));
        assert_eq!(at(&c, (2, 0)), Some('─'));
        assert_eq!(at(&c, (4, 0)), Some('┐'));
        assert_eq!(at(&c, (4, 2)), Some('│'));
        assert_eq!(at(&c, (4, 3)), Some('▼'));
    }

    #[test]
    fn elbow_up_left() {
        let c = arrow_cells((5, 5), (2, 2));
        assert_eq!(at(&c, (2, 5)), Some('└'));
        assert_eq!(at(&c, (2, 2)), Some('▲'));
    }

    #[test]
    fn straight_arrows() {
        assert_eq!(at(&arrow_cells((1, 1), (6, 1)), (6, 1)), Some('▶'));
        assert_eq!(at(&arrow_cells((6, 1), (1, 1)), (1, 1)), Some('◀'));
        assert_eq!(at(&arrow_cells((3, 1), (3, 4)), (3, 4)), Some('▼'));
        assert!(arrow_cells((3, 1), (3, 1)).is_empty());
    }

    #[test]
    fn line_points_cover_both_ends() {
        let p = line_points((0, 0), (3, 1));
        assert_eq!(p.first(), Some(&(0, 0)));
        assert_eq!(p.last(), Some(&(3, 1)));
        assert!(p.len() >= 4);
    }
}
