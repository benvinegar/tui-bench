//! Recorded metrics loaded from `data/metrics.json`.

use std::{fs, path::Path};

use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct Metrics {
    pub host: String,
    pub kernel: String,
    pub uptime: String,
    pub cores: usize,
    #[serde(rename = "intervalMs")]
    pub interval_ms: u64,
    pub samples: Vec<Sample>,
    pub processes: Vec<Process>,
}

#[derive(Debug, Deserialize)]
pub struct Sample {
    /// Per-core CPU usage in percent.
    pub cpu: Vec<f64>,
    pub mem: Usage,
    pub swap: Usage,
    pub net: Net,
    /// 1, 5 and 15 minute load averages.
    pub load: [f64; 3],
}

#[derive(Debug, Deserialize, Clone, Copy)]
pub struct Usage {
    #[serde(rename = "usedGiB")]
    pub used_gib: f64,
    #[serde(rename = "totalGiB")]
    pub total_gib: f64,
}

impl Usage {
    /// Used fraction in `0.0..=1.0`.
    pub fn ratio(&self) -> f64 {
        if self.total_gib > 0.0 {
            (self.used_gib / self.total_gib).clamp(0.0, 1.0)
        } else {
            0.0
        }
    }
}

#[derive(Debug, Deserialize, Clone, Copy)]
pub struct Net {
    #[serde(rename = "rxKiBps")]
    pub rx_kibps: f64,
    #[serde(rename = "txKiBps")]
    pub tx_kibps: f64,
}

#[derive(Debug, Deserialize, Clone)]
pub struct Process {
    pub pid: u32,
    pub name: String,
    pub user: String,
    pub cpu: f64,
    pub mem: f64,
    pub threads: u32,
    pub state: String,
    pub started: String,
    pub command: String,
}

pub fn load(path: &Path) -> Result<Metrics, String> {
    let text = fs::read_to_string(path)
        .map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    let metrics: Metrics = serde_json::from_str(&text)
        .map_err(|e| format!("invalid {}: {e}", path.display()))?;
    if metrics.samples.is_empty() {
        return Err(format!("{} contains no samples", path.display()));
    }
    Ok(metrics)
}
