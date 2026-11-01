use serde::Deserialize;

#[derive(Deserialize, Clone, Debug)]
pub struct Entry {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub modified: String,
}

impl Entry {
    pub fn is_dir(&self) -> bool {
        self.kind == "dir"
    }
}

/// Loads `data/files.json`, folders first (the sort is stable, so the file order is kept).
pub fn load_files() -> Vec<Entry> {
    let text = std::fs::read_to_string("data/files.json").unwrap_or_default();
    let mut entries: Vec<Entry> = serde_json::from_str(&text).unwrap_or_default();
    entries.sort_by_key(|e| !e.is_dir());
    entries
}

/// Loads `data/notes.txt` as lines of characters. Always returns at least one line.
pub fn load_notes() -> Vec<Vec<char>> {
    let text = std::fs::read_to_string("data/notes.txt").unwrap_or_default();
    let mut lines: Vec<Vec<char>> = text.lines().map(|l| l.chars().collect()).collect();
    if lines.is_empty() {
        lines.push(Vec::new());
    }
    lines
}

pub fn human_size(bytes: u64) -> String {
    let b = bytes as f64;
    const KB: f64 = 1024.0;
    if bytes < 1024 {
        format!("{} B", bytes)
    } else if b < KB * KB {
        format!("{:.1} KB", b / KB)
    } else if b < KB * KB * KB {
        format!("{:.1} MB", b / (KB * KB))
    } else {
        format!("{:.1} GB", b / (KB * KB * KB))
    }
}

/// Selection and scrolling state of the Files window.
pub struct FileList {
    pub entries: Vec<Entry>,
    pub sel: usize,
    pub scroll: usize,
    pub view_h: usize,
}

impl FileList {
    pub fn new(entries: Vec<Entry>) -> Self {
        FileList { entries, sel: 0, scroll: 0, view_h: 1 }
    }

    pub fn move_by(&mut self, delta: i64) {
        let n = self.entries.len();
        if n == 0 {
            return;
        }
        let next = (self.sel as i64 + delta).clamp(0, n as i64 - 1);
        self.sel = next as usize;
    }

    pub fn select(&mut self, idx: usize) {
        let n = self.entries.len();
        self.sel = if n == 0 { 0 } else { idx.min(n - 1) };
    }

    /// `row` is relative to the first list row (below the header).
    pub fn click_row(&mut self, row: usize) {
        let idx = self.scroll + row;
        if idx < self.entries.len() {
            self.sel = idx;
        }
    }

    /// Keeps the selection inside a window of `view` rows.
    pub fn ensure_visible(&mut self, view: usize) {
        let view = view.max(1);
        self.view_h = view;
        let n = self.entries.len();
        self.scroll = self.scroll.min(n.saturating_sub(view));
        if self.sel < self.scroll {
            self.scroll = self.sel;
        }
        if self.sel >= self.scroll + view {
            self.scroll = self.sel + 1 - view;
        }
    }
}
