//! Playback, selection and sort state, plus key handling.

use std::time::{Duration, Instant};

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::widgets::TableState;

use crate::data::{Metrics, Process, Sample};

/// Process table sort columns, in cycle order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SortKey {
    Cpu,
    Mem,
    Pid,
    Name,
}

impl SortKey {
    pub fn next(self) -> Self {
        match self {
            SortKey::Cpu => SortKey::Mem,
            SortKey::Mem => SortKey::Pid,
            SortKey::Pid => SortKey::Name,
            SortKey::Name => SortKey::Cpu,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            SortKey::Cpu => "CPU%",
            SortKey::Mem => "MEM%",
            SortKey::Pid => "PID",
            SortKey::Name => "NAME",
        }
    }

    /// PID and NAME sort ascending; the numeric usage columns sort descending.
    pub fn ascending(self) -> bool {
        matches!(self, SortKey::Pid | SortKey::Name)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Action {
    Continue,
    Quit,
}

pub struct App {
    pub data: Metrics,
    /// Index of the sample currently shown.
    pub index: usize,
    pub paused: bool,
    pub sort: SortKey,
    /// Index into `data.processes` of the selected row.
    pub selected: usize,
    pub detail_open: bool,
    pub table_state: TableState,
    last_advance: Instant,
}

impl App {
    pub fn new(data: Metrics, now: Instant) -> Self {
        let mut app = Self {
            data,
            index: 0,
            paused: false,
            sort: SortKey::Cpu,
            selected: 0,
            detail_open: false,
            table_state: TableState::default(),
            last_advance: now,
        };
        // Start with the top row of the default sort selected.
        app.selected = app.sorted_indices().first().copied().unwrap_or(0);
        app
    }

    fn interval(&self) -> Duration {
        Duration::from_millis(self.data.interval_ms.max(1))
    }

    pub fn interval_secs(&self) -> f64 {
        self.data.interval_ms.max(1) as f64 / 1000.0
    }

    pub fn last_index(&self) -> usize {
        self.data.samples.len().saturating_sub(1)
    }

    /// True once the last sample is on screen; playback stops there.
    pub fn finished(&self) -> bool {
        self.index >= self.last_index()
    }

    pub fn sample(&self) -> &Sample {
        // `load` guarantees at least one sample.
        &self.data.samples[self.index.min(self.last_index())]
    }

    /// Process indices (into `data.processes`) in the current sort order.
    pub fn sorted_indices(&self) -> Vec<usize> {
        let procs = &self.data.processes;
        let mut order: Vec<usize> = (0..procs.len()).collect();
        match self.sort {
            SortKey::Cpu => order.sort_by(|&a, &b| {
                procs[b].cpu.total_cmp(&procs[a].cpu).then(procs[a].pid.cmp(&procs[b].pid))
            }),
            SortKey::Mem => order.sort_by(|&a, &b| {
                procs[b].mem.total_cmp(&procs[a].mem).then(procs[a].pid.cmp(&procs[b].pid))
            }),
            SortKey::Pid => order.sort_by_key(|&i| procs[i].pid),
            SortKey::Name => order.sort_by(|&a, &b| {
                let (x, y) = (&procs[a], &procs[b]);
                x.name
                    .to_lowercase()
                    .cmp(&y.name.to_lowercase())
                    .then(x.pid.cmp(&y.pid))
            }),
        }
        order
    }

    pub fn selected_process(&self) -> Option<&Process> {
        self.data.processes.get(self.selected)
    }

    fn move_selection(&mut self, delta: isize) {
        let order = self.sorted_indices();
        if order.is_empty() {
            return;
        }
        let pos = order.iter().position(|&i| i == self.selected).unwrap_or(0) as isize;
        let next = (pos + delta).clamp(0, order.len() as isize - 1) as usize;
        self.selected = order[next];
    }

    fn select_edge(&mut self, last: bool) {
        let order = self.sorted_indices();
        let edge = if last { order.last() } else { order.first() };
        if let Some(&i) = edge {
            self.selected = i;
        }
    }

    pub fn toggle_pause(&mut self, now: Instant) {
        if self.finished() {
            return;
        }
        self.paused = !self.paused;
        if !self.paused {
            self.last_advance = now;
        }
    }

    /// Advances playback by however many whole intervals have elapsed.
    pub fn update(&mut self, now: Instant) {
        if self.paused || self.finished() {
            return;
        }
        let interval = self.interval();
        let elapsed = now.saturating_duration_since(self.last_advance);
        if elapsed < interval {
            return;
        }
        let steps = (elapsed.as_nanos() / interval.as_nanos()).min(u32::MAX as u128) as u32;
        let last = self.last_index();
        self.index = (self.index + steps as usize).min(last);
        self.last_advance += interval * steps;
    }

    /// How long the event loop may block before playback needs another update.
    pub fn next_timeout(&self, now: Instant) -> Duration {
        if self.paused || self.finished() {
            return Duration::from_millis(200);
        }
        let due = self.last_advance + self.interval();
        due.saturating_duration_since(now)
    }

    pub fn handle_key(&mut self, key: KeyEvent, now: Instant) -> Action {
        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
            return Action::Quit;
        }
        match key.code {
            KeyCode::Char('q') => return Action::Quit,
            KeyCode::Esc => self.detail_open = false,
            KeyCode::Char('p') => self.toggle_pause(now),
            KeyCode::Enter => {
                if !self.data.processes.is_empty() {
                    self.detail_open = true;
                }
            }
            _ if self.detail_open => {}
            KeyCode::Char('j') | KeyCode::Down => self.move_selection(1),
            KeyCode::Char('k') | KeyCode::Up => self.move_selection(-1),
            KeyCode::PageDown => self.move_selection(10),
            KeyCode::PageUp => self.move_selection(-10),
            KeyCode::Home | KeyCode::Char('g') => self.select_edge(false),
            KeyCode::End | KeyCode::Char('G') => self.select_edge(true),
            KeyCode::Char('s') => self.sort = self.sort.next(),
            _ => {}
        }
        Action::Continue
    }
}
