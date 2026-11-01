//! Rendering for the system monitor dashboard.

use ratatui::{
    Frame,
    layout::{Alignment, Constraint, Layout, Rect},
    style::{Color, Style},
    symbols::Marker,
    text::{Line, Span},
    widgets::{
        Axis, Block, BorderType, Cell, Chart, Clear, Dataset, Gauge, GraphType, Paragraph, Row,
        Table, Wrap,
    },
};

use crate::app::{App, SortKey};
use crate::data::Process;

const ACCENT: Color = Color::Rgb(96, 200, 220);
const ACCENT_2: Color = Color::Rgb(190, 140, 235);
const TEXT: Color = Color::Rgb(218, 224, 234);
const DIM: Color = Color::Rgb(124, 132, 150);
const BORDER: Color = Color::Rgb(62, 72, 92);
const TRACK: Color = Color::Rgb(38, 44, 58);
const GOOD: Color = Color::Rgb(94, 180, 116);
const WARN: Color = Color::Rgb(222, 172, 84);
const BAD: Color = Color::Rgb(220, 96, 96);
const HEADER_BG: Color = Color::Rgb(24, 32, 46);
const SELECT_BG: Color = Color::Rgb(36, 54, 78);
const KEY_BG: Color = Color::Rgb(56, 70, 94);
const POPUP_BG: Color = Color::Rgb(18, 24, 36);

pub const MIN_WIDTH: u16 = 60;
pub const MIN_HEIGHT: u16 = 22;
/// Below this height the progress bar is dropped and its status moves to the footer.
const PROGRESS_MIN_HEIGHT: u16 = 26;

pub fn render(frame: &mut Frame, app: &mut App) {
    let area = frame.area();
    if area.width < MIN_WIDTH || area.height < MIN_HEIGHT {
        render_too_small(frame, area);
        return;
    }

    let show_progress = area.height >= PROGRESS_MIN_HEIGHT;
    let (header, progress, body, footer) = if show_progress {
        let [header, progress, body, footer] = Layout::vertical([
            Constraint::Length(1),
            Constraint::Length(1),
            Constraint::Fill(1),
            Constraint::Length(1),
        ])
        .areas(area);
        (header, Some(progress), body, footer)
    } else {
        let [header, body, footer] = Layout::vertical([
            Constraint::Length(1),
            Constraint::Fill(1),
            Constraint::Length(1),
        ])
        .areas(area);
        (header, None, body, footer)
    };

    render_header(frame, header, app);
    if let Some(progress) = progress {
        render_progress(frame, progress, app);
    }
    render_body(frame, body, app);
    render_footer(frame, footer, app);

    if app.detail_open {
        render_detail(frame, area, app);
    }
}

fn render_too_small(frame: &mut Frame, area: Rect) {
    let rows = area.height.min(2);
    if rows == 0 {
        return;
    }
    let lines = vec![
        Line::from(Span::styled("Terminal too small", Style::new().fg(WARN).bold())),
        Line::from(Span::styled(
            format!(
                "{}x{} - need {}x{}",
                area.width, area.height, MIN_WIDTH, MIN_HEIGHT
            ),
            Style::new().fg(DIM),
        )),
    ];
    let y = area.y + (area.height - rows) / 2;
    frame.render_widget(
        Paragraph::new(lines).alignment(Alignment::Center),
        Rect::new(area.x, y, area.width, rows),
    );
}

fn render_header(frame: &mut Frame, area: Rect, app: &App) {
    let m = &app.data;
    let line = Line::from(vec![
        Span::styled(" ◆ ", Style::new().fg(ACCENT).bold()),
        Span::styled(m.host.clone(), Style::new().fg(TEXT).bold()),
        Span::styled("   kernel ", Style::new().fg(DIM)),
        Span::styled(m.kernel.clone(), Style::new().fg(TEXT)),
        Span::styled("   uptime ", Style::new().fg(DIM)),
        Span::styled(m.uptime.clone(), Style::new().fg(TEXT)),
        Span::styled("   cores ", Style::new().fg(DIM)),
        Span::styled(m.cores.to_string(), Style::new().fg(TEXT)),
    ]);
    frame.render_widget(Paragraph::new(line).style(Style::new().bg(HEADER_BG)), area);
}

/// Playback state label and its colour.
fn playback_status(app: &App) -> (&'static str, Color) {
    if app.finished() {
        ("■ REPLAY FINISHED", GOOD)
    } else if app.paused {
        ("‖ PAUSED", WARN)
    } else {
        ("▶ PLAYING", ACCENT)
    }
}

fn render_progress(frame: &mut Frame, area: Rect, app: &App) {
    let total = app.data.samples.len();
    let (status, color) = playback_status(app);
    let ratio = if total > 1 {
        app.index as f64 / (total - 1) as f64
    } else {
        1.0
    };
    let label = format!(
        " sample {}/{}  ·  {}  ·  {} ms per sample ",
        app.index + 1,
        total,
        status,
        app.data.interval_ms
    );
    let gauge = Gauge::default()
        .use_unicode(true)
        .ratio(clamp01(ratio))
        .gauge_style(Style::new().fg(color).bg(TRACK))
        .label(Span::styled(label, Style::new().fg(TEXT).bold()));
    frame.render_widget(gauge, area);
}

fn render_body(frame: &mut Frame, area: Rect, app: &mut App) {
    let (top_h, net_h) = if area.height >= 30 { (12, 8) } else { (10, 5) };
    let [top, net, procs] = Layout::vertical([
        Constraint::Length(top_h),
        Constraint::Length(net_h),
        Constraint::Fill(1),
    ])
    .areas(area);

    let w = top.width;
    let left_w = pct(w, 32).clamp(22, 46);
    let right_w = pct(w, 28).clamp(22, 38);
    let [left, mid, right] = Layout::horizontal([
        Constraint::Length(left_w),
        Constraint::Fill(1),
        Constraint::Length(right_w),
    ])
    .areas(top);

    render_cores(frame, left, app);
    render_history(frame, mid, app);
    render_right(frame, right, app);
    render_network(frame, net, app);
    render_processes(frame, procs, app);
}

fn render_cores(frame: &mut Frame, area: Rect, app: &App) {
    let sample = app.sample();
    let n = sample.cpu.len();
    let avg = average(&sample.cpu);
    let avg_row = n < (area.height.saturating_sub(2)) as usize;
    let title_text = if avg_row {
        format!(" {n} cores ")
    } else if area.width >= 30 {
        format!(" avg {avg:.1}%  ·  {n} cores ")
    } else {
        format!(" {avg:.0}% ")
    };
    let mut block = panel("CPU");
    if area.width >= title_text.chars().count() as u16 + 8 {
        block = block.title(Line::from(Span::styled(title_text, Style::new().fg(DIM))).right_aligned());
    }
    let inner = block.inner(area);
    frame.render_widget(block, area);

    let per_col = inner.height as usize;
    if per_col == 0 || inner.width == 0 {
        return;
    }
    let mut rows: Vec<(String, f64, bool)> = Vec::new();
    if avg_row {
        rows.push(("avg".to_string(), avg, true));
    }
    rows.extend(
        sample
            .cpu
            .iter()
            .enumerate()
            .map(|(i, &v)| (format!("core {i}"), v, false)),
    );

    let two_cols = rows.len() > per_col && inner.width >= 44;
    let col_areas: Vec<Rect> = if two_cols {
        Layout::horizontal([Constraint::Fill(1), Constraint::Fill(1)])
            .split(inner)
            .to_vec()
    } else {
        vec![inner]
    };

    for (col, col_area) in col_areas.iter().enumerate() {
        let chunk: Vec<&(String, f64, bool)> =
            rows.iter().skip(col * per_col).take(per_col).collect();
        if chunk.is_empty() {
            break;
        }
        let slots = Layout::vertical(vec![Constraint::Length(1); chunk.len()]).split(*col_area);
        for (row, slot) in chunk.iter().zip(slots.iter()) {
            let (label, value, is_avg) = (&row.0, row.1, row.2);
            gauge_row(
                frame,
                *slot,
                label,
                value / 100.0,
                &format!("{value:.1}%"),
                usage_color(value),
                is_avg,
            );
        }
    }
}

fn render_history(frame: &mut Frame, area: Rect, app: &App) {
    let dt = app.interval_secs();
    let last = app.last_index().max(1);
    let series: Vec<(f64, f64)> = app.data.samples[..=app.index]
        .iter()
        .enumerate()
        .map(|(i, s)| (i as f64, average(&s.cpu)))
        .collect();
    let current = series.last().map(|p| p.1).unwrap_or(0.0);
    let peak = series.iter().map(|p| p.1).fold(0.0_f64, f64::max);

    let wide = area.width >= 44;
    let title_text = if wide {
        format!(" now {current:.1}%  peak {peak:.1}% ")
    } else {
        format!(" now {current:.1}% ")
    };
    let mut block = panel("CPU history");
    if area.width >= 26 {
        block = block.title(Line::from(Span::styled(title_text, Style::new().fg(DIM))).right_aligned());
    }
    let x_max = last as f64;
    let x_labels = if wide {
        vec![
            format!("{:.1}s", 0.0),
            format!("{:.1}s", x_max * dt / 2.0),
            format!("{:.1}s", x_max * dt),
        ]
    } else {
        vec![format!("{:.1}s", 0.0), format!("{:.1}s", x_max * dt)]
    };
    let dataset = Dataset::default()
        .name("avg")
        .marker(Marker::Braille)
        .graph_type(GraphType::Line)
        .style(Style::new().fg(usage_color(current)))
        .data(&series);
    let chart = Chart::new(vec![dataset])
        .block(block)
        .x_axis(
            Axis::default()
                .style(Style::new().fg(DIM))
                .bounds([0.0, x_max])
                .labels(x_labels),
        )
        .y_axis(
            Axis::default()
                .style(Style::new().fg(DIM))
                .bounds([0.0, 100.0])
                .labels(vec!["0", "50", "100"]),
        );
    frame.render_widget(chart, area);
}

fn render_right(frame: &mut Frame, area: Rect, app: &App) {
    let sample = app.sample();
    let mem_h = if area.height >= 12 { 6 } else { 4 };
    let [mem_area, load_area] =
        Layout::vertical([Constraint::Length(mem_h), Constraint::Fill(1)]).areas(area);

    // Memory and swap gauges.
    let mem_block = panel("Memory");
    let mem_inner = mem_block.inner(mem_area);
    frame.render_widget(mem_block, mem_area);
    if mem_inner.height >= 2 {
        let slots = Layout::vertical(vec![Constraint::Length(1); mem_inner.height as usize])
            .split(mem_inner);
        let spacing = mem_inner.height >= 3;
        let long_text = area.width >= 30;
        for (slot_index, label, usage) in [(0, "RAM", sample.mem), (if spacing { 2 } else { 1 }, "SWAP", sample.swap)] {
            let ratio = usage.ratio();
            let text = if long_text {
                format!(
                    "{:.2} / {:.1} GiB  {:.0}%",
                    usage.used_gib,
                    usage.total_gib,
                    ratio * 100.0
                )
            } else {
                format!("{:.1}/{:.0}G {:.0}%", usage.used_gib, usage.total_gib, ratio * 100.0)
            };
            gauge_row(
                frame,
                slots[slot_index],
                label,
                ratio,
                &text,
                usage_color(ratio * 100.0),
                false,
            );
        }
    }

    // Load averages, scaled against the core count.
    let cores = app.data.cores.max(1) as f64;
    let mut load_block = panel("Load average");
    if area.width >= 34 {
        load_block = load_block.title(
            Line::from(Span::styled(
                format!(" {} cores ", app.data.cores),
                Style::new().fg(DIM),
            ))
            .right_aligned(),
        );
    }
    let load_inner = load_block.inner(load_area);
    frame.render_widget(load_block, load_area);
    let names = ["1 min", "5 min", "15 min"];
    if load_inner.height > 0 {
        let slots = Layout::vertical(vec![Constraint::Length(1); load_inner.height as usize])
            .split(load_inner);
        for (i, slot) in slots.iter().enumerate().take(names.len()) {
            let load = sample.load[i];
            let ratio = load / cores;
            gauge_row(
                frame,
                *slot,
                names[i],
                ratio,
                &format!("{load:.2}"),
                load_color(ratio),
                false,
            );
        }
    }
}

fn render_network(frame: &mut Frame, area: Rect, app: &App) {
    let dt = app.interval_secs();
    let shown = &app.data.samples[..=app.index];
    let rx: Vec<(f64, f64)> = shown
        .iter()
        .enumerate()
        .map(|(i, s)| (i as f64, s.net.rx_kibps))
        .collect();
    let tx: Vec<(f64, f64)> = shown
        .iter()
        .enumerate()
        .map(|(i, s)| (i as f64, s.net.tx_kibps))
        .collect();
    let peak = app
        .data
        .samples
        .iter()
        .map(|s| s.net.rx_kibps.max(s.net.tx_kibps))
        .fold(0.0_f64, f64::max);
    let y_max = nice_ceil(peak * 1.15, 500.0);

    let current = app.sample().net;
    let title_right = Line::from(vec![
        Span::styled("▼ rx ", Style::new().fg(DIM)),
        Span::styled(
            format!("{:.0} KiB/s", current.rx_kibps),
            Style::new().fg(ACCENT).bold(),
        ),
        Span::styled("   ▲ tx ", Style::new().fg(DIM)),
        Span::styled(
            format!("{:.0} KiB/s ", current.tx_kibps),
            Style::new().fg(ACCENT_2).bold(),
        ),
    ])
    .right_aligned();
    let block = panel("Network").title(title_right);

    let x_max = app.last_index().max(1) as f64;
    let x_labels = if area.width >= 44 {
        vec![
            "0.0s".to_string(),
            format!("{:.1}s", x_max * dt / 2.0),
            format!("{:.1}s", x_max * dt),
        ]
    } else {
        vec!["0.0s".to_string(), format!("{:.1}s", x_max * dt)]
    };
    let datasets = vec![
        Dataset::default()
            .name("rx")
            .marker(Marker::Braille)
            .graph_type(GraphType::Line)
            .style(Style::new().fg(ACCENT))
            .data(&rx),
        Dataset::default()
            .name("tx")
            .marker(Marker::Braille)
            .graph_type(GraphType::Line)
            .style(Style::new().fg(ACCENT_2))
            .data(&tx),
    ];
    let chart = Chart::new(datasets)
        .block(block)
        .x_axis(
            Axis::default()
                .style(Style::new().fg(DIM))
                .bounds([0.0, x_max])
                .labels(x_labels),
        )
        .y_axis(
            Axis::default()
                .style(Style::new().fg(DIM))
                .bounds([0.0, y_max])
                .labels(vec![
                    "0".to_string(),
                    rate_label(y_max / 2.0),
                    rate_label(y_max),
                ]),
        );
    frame.render_widget(chart, area);
}

fn render_processes(frame: &mut Frame, area: Rect, app: &mut App) {
    let order = app.sorted_indices();
    let selected_pos = order.iter().position(|&i| i == app.selected);
    let arrow = if app.sort.ascending() { "▲" } else { "▼" };

    let block = panel("Processes").title(
        Line::from(Span::styled(
            format!(
                " sorted by {} {}  ·  {} total ",
                app.sort.label(),
                arrow,
                app.data.processes.len()
            ),
            Style::new().fg(DIM),
        ))
        .right_aligned(),
    );

    // (label, the sort key this column corresponds to, if any)
    let headers: [(&str, Option<SortKey>); 6] = [
        ("PID", Some(SortKey::Pid)),
        ("NAME", Some(SortKey::Name)),
        ("USER", None),
        ("CPU%", Some(SortKey::Cpu)),
        ("MEM%", Some(SortKey::Mem)),
        ("STATE", None),
    ];
    let header_cells: Vec<Cell> = headers
        .iter()
        .map(|&(label, key)| {
            if key == Some(app.sort) {
                Cell::from(format!("{label} {arrow}")).style(Style::new().fg(ACCENT).bold())
            } else {
                Cell::from(label).style(Style::new().fg(DIM).bold())
            }
        })
        .collect();

    let rows: Vec<Row> = order
        .iter()
        .map(|&i| process_row(&app.data.processes[i]))
        .collect();

    let widths = [
        Constraint::Length(7),
        Constraint::Min(12),
        Constraint::Length(10),
        Constraint::Length(8),
        Constraint::Length(8),
        Constraint::Length(10),
    ];
    let table = Table::new(rows, widths)
        .header(Row::new(header_cells).height(1))
        .block(block)
        .column_spacing(2)
        .row_highlight_style(Style::new().bg(SELECT_BG).bold())
        .highlight_symbol("▌ ");

    app.table_state.select(selected_pos);
    frame.render_stateful_widget(table, area, &mut app.table_state);
}

fn process_row(p: &Process) -> Row<'static> {
    Row::new(vec![
        Cell::from(p.pid.to_string()).style(Style::new().fg(DIM)),
        Cell::from(p.name.clone()).style(Style::new().fg(TEXT).bold()),
        Cell::from(p.user.clone()).style(Style::new().fg(TEXT)),
        Cell::from(format!("{:.1}", p.cpu)).style(Style::new().fg(usage_color(p.cpu))),
        Cell::from(format!("{:.1}", p.mem)).style(Style::new().fg(usage_color(p.mem))),
        Cell::from(p.state.clone()).style(Style::new().fg(state_color(&p.state))),
    ])
}

fn render_footer(frame: &mut Frame, area: Rect, app: &App) {
    let items: Vec<(&str, String)> = if app.detail_open {
        vec![("esc", "close".to_string()), ("q", "quit".to_string())]
    } else {
        vec![
            ("j/k", "select".to_string()),
            ("enter", "details".to_string()),
            ("s", format!("sort ({})", app.sort.label())),
            ("p", if app.paused { "resume".into() } else { "pause".into() }),
            ("q", "quit".to_string()),
        ]
    };
    let mut spans = Vec::new();
    for (key, desc) in items {
        spans.push(Span::styled(
            format!(" {key} "),
            Style::new().fg(TEXT).bg(KEY_BG).bold(),
        ));
        spans.push(Span::styled(format!(" {desc}   "), Style::new().fg(DIM)));
    }

    let (status, color) = playback_status(app);
    let status_text = format!(
        " sample {}/{}  ·  {} ",
        app.index + 1,
        app.data.samples.len(),
        status
    );
    let status_width = status_text.chars().count() as u16;
    let [keys_area, status_area] =
        Layout::horizontal([Constraint::Fill(1), Constraint::Length(status_width)]).areas(area);
    frame.render_widget(Paragraph::new(Line::from(spans)), keys_area);
    frame.render_widget(
        Paragraph::new(Span::styled(status_text, Style::new().fg(color).bold()))
            .alignment(Alignment::Right),
        status_area,
    );
}

fn render_detail(frame: &mut Frame, area: Rect, app: &App) {
    let Some(p) = app.selected_process() else {
        return;
    };
    let w = area.width.saturating_sub(4).min(70);
    let h = area.height.saturating_sub(2).min(16);
    let rect = centered(area, w, h);

    let fields = [
        ("PID", p.pid.to_string()),
        ("Name", p.name.clone()),
        ("User", p.user.clone()),
        ("CPU", format!("{:.1}%", p.cpu)),
        ("Memory", format!("{:.1}%", p.mem)),
        ("Threads", p.threads.to_string()),
        ("State", p.state.clone()),
        ("Started", p.started.clone()),
        ("Command", p.command.clone()),
    ];
    let lines: Vec<Line> = fields
        .into_iter()
        .map(|(label, value)| {
            let value_style = match label {
                "CPU" => Style::new().fg(usage_color(p.cpu)).bold(),
                "Memory" => Style::new().fg(usage_color(p.mem)).bold(),
                "State" => Style::new().fg(state_color(&p.state)).bold(),
                _ => Style::new().fg(TEXT),
            };
            Line::from(vec![
                Span::styled(format!("{label:<10}"), Style::new().fg(DIM)),
                Span::styled(value, value_style),
            ])
        })
        .collect();

    let block = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(Style::new().fg(ACCENT))
        .style(Style::new().bg(POPUP_BG))
        .title(Span::styled(
            format!(" process {} ", p.pid),
            Style::new().fg(ACCENT).bold(),
        ))
        .title(
            Line::from(Span::styled(" esc to close ", Style::new().fg(DIM))).right_aligned(),
        );

    frame.render_widget(Clear, rect);
    frame.render_widget(
        Paragraph::new(lines)
            .block(block)
            .style(Style::new().bg(POPUP_BG))
            .wrap(Wrap { trim: false }),
        rect,
    );
}

/// A bordered panel with a bold accent title.
fn panel(title: &str) -> Block<'_> {
    Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(Style::new().fg(BORDER))
        .title(Span::styled(format!(" {title} "), Style::new().fg(ACCENT).bold()))
}

/// One labelled bar: a fixed-width label column followed by a filled gauge.
fn gauge_row(
    frame: &mut Frame,
    area: Rect,
    label: &str,
    ratio: f64,
    text: &str,
    color: Color,
    bold: bool,
) {
    if area.height == 0 || area.width == 0 {
        return;
    }
    let [label_area, bar_area] =
        Layout::horizontal([Constraint::Length(8), Constraint::Fill(1)]).areas(area);
    let label_style = if bold {
        Style::new().fg(TEXT).bold()
    } else {
        Style::new().fg(DIM)
    };
    frame.render_widget(
        Paragraph::new(Span::styled(format!("{label:<8}"), label_style)),
        label_area,
    );
    let gauge = Gauge::default()
        .use_unicode(true)
        .ratio(clamp01(ratio))
        .gauge_style(Style::new().fg(color).bg(TRACK))
        .label(Span::styled(text.to_string(), Style::new().fg(TEXT).bold()));
    frame.render_widget(gauge, bar_area);
}

fn usage_color(percent: f64) -> Color {
    if percent >= 85.0 {
        BAD
    } else if percent >= 60.0 {
        WARN
    } else {
        GOOD
    }
}

fn load_color(ratio: f64) -> Color {
    if ratio >= 1.0 {
        BAD
    } else if ratio >= 0.7 {
        WARN
    } else {
        GOOD
    }
}

fn state_color(state: &str) -> Color {
    match state {
        "running" => GOOD,
        "sleeping" => TEXT,
        "idle" => DIM,
        _ => WARN,
    }
}

fn average(values: &[f64]) -> f64 {
    if values.is_empty() {
        0.0
    } else {
        values.iter().sum::<f64>() / values.len() as f64
    }
}

fn clamp01(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

/// Scales a u16 dimension by a percentage without overflowing.
fn pct(value: u16, percent: u32) -> u16 {
    ((value as u32 * percent) / 100) as u16
}

fn nice_ceil(value: f64, step: f64) -> f64 {
    ((value / step).ceil().max(1.0)) * step
}

fn rate_label(kibps: f64) -> String {
    if kibps >= 1000.0 {
        format!("{:.1}k", kibps / 1000.0)
    } else {
        format!("{kibps:.0}")
    }
}

fn centered(area: Rect, width: u16, height: u16) -> Rect {
    let w = width.min(area.width);
    let h = height.min(area.height);
    Rect::new(
        area.x + (area.width - w) / 2,
        area.y + (area.height - h) / 2,
        w,
        h,
    )
}
