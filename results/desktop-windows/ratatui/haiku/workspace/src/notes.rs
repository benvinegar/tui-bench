/// A small multi-line text editor with a cursor and scroll offsets.
/// Invariant: `lines` is never empty and `col <= lines[row].len()`.
pub struct Notes {
    pub lines: Vec<Vec<char>>,
    pub row: usize,
    pub col: usize,
    pub scroll_y: usize,
    pub scroll_x: usize,
}

impl Notes {
    pub fn new(lines: Vec<Vec<char>>) -> Self {
        let lines = if lines.is_empty() { vec![Vec::new()] } else { lines };
        Notes { lines, row: 0, col: 0, scroll_y: 0, scroll_x: 0 }
    }

    fn line_len(&self) -> usize {
        self.lines[self.row].len()
    }

    pub fn insert(&mut self, ch: char) {
        self.lines[self.row].insert(self.col, ch);
        self.col += 1;
    }

    pub fn newline(&mut self) {
        let rest = self.lines[self.row].split_off(self.col);
        self.row += 1;
        self.lines.insert(self.row, rest);
        self.col = 0;
    }

    pub fn backspace(&mut self) {
        if self.col > 0 {
            self.col -= 1;
            self.lines[self.row].remove(self.col);
        } else if self.row > 0 {
            let line = self.lines.remove(self.row);
            self.row -= 1;
            self.col = self.line_len();
            self.lines[self.row].extend(line);
        }
    }

    pub fn delete(&mut self) {
        if self.col < self.line_len() {
            self.lines[self.row].remove(self.col);
        } else if self.row + 1 < self.lines.len() {
            let next = self.lines.remove(self.row + 1);
            self.lines[self.row].extend(next);
        }
    }

    pub fn left(&mut self) {
        if self.col > 0 {
            self.col -= 1;
        } else if self.row > 0 {
            self.row -= 1;
            self.col = self.line_len();
        }
    }

    pub fn right(&mut self) {
        if self.col < self.line_len() {
            self.col += 1;
        } else if self.row + 1 < self.lines.len() {
            self.row += 1;
            self.col = 0;
        }
    }

    pub fn up(&mut self) {
        if self.row > 0 {
            self.row -= 1;
            self.col = self.col.min(self.line_len());
        }
    }

    pub fn down(&mut self) {
        if self.row + 1 < self.lines.len() {
            self.row += 1;
            self.col = self.col.min(self.line_len());
        }
    }

    pub fn home(&mut self) {
        self.col = 0;
    }

    pub fn end(&mut self) {
        self.col = self.line_len();
    }

    /// Moves the cursor to a position given relative to the visible text area.
    pub fn click(&mut self, rx: i32, ry: i32) {
        let max_row = self.lines.len() as i32 - 1;
        let row = (self.scroll_y as i32 + ry).clamp(0, max_row.max(0));
        self.row = row as usize;
        let col = (self.scroll_x as i32 + rx).max(0) as usize;
        self.col = col.min(self.line_len());
    }

    /// Adjusts the scroll offsets so the cursor is inside a `w` x `h` view.
    pub fn ensure_visible(&mut self, w: usize, h: usize) {
        if w == 0 || h == 0 {
            return;
        }
        if self.row < self.scroll_y {
            self.scroll_y = self.row;
        }
        if self.row >= self.scroll_y + h {
            self.scroll_y = self.row + 1 - h;
        }
        if self.col < self.scroll_x {
            self.scroll_x = self.col;
        }
        if self.col >= self.scroll_x + w {
            self.scroll_x = self.col + 1 - w;
        }
    }
}
