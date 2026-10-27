# Architecture

weatherline is split into three small modules:

- `main.rs` parses arguments and wires everything together.
- `config.rs` reads configuration from the environment.
- `ui/` formats forecasts for the terminal.

## Data flow

1. Arguments are parsed with clap.
2. Configuration is loaded and merged with the arguments.
3. Forecasts are loaded from the cache (or generated in demo mode).
4. Each forecast is rendered as one row.

## Future work

- Fetch live data from an API when the cache is stale.
- Add a `--json` output mode.
- Colour-code temperatures.
