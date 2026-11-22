mod devices;
mod protocol;

use std::io::{self, BufRead, Write};
use std::process::ExitCode;

use protocol::{Session, event_frame, handle_line};
use serde_json::json;

fn main() -> ExitCode {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = stdout.lock();
    let mut session = Session::default();

    if emit(
        &mut out,
        &event_frame(
            "ready",
            json!({
                "engine": protocol::ENGINE_NAME,
                "version": protocol::ENGINE_VERSION,
                "protocol": protocol::PROTOCOL_VERSION,
            }),
        ),
    )
    .is_err()
    {
        return ExitCode::from(2);
    }

    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let Some(outcome) = handle_line(&mut session, &line) else {
            continue;
        };
        if emit(&mut out, &outcome.frame).is_err() {
            return ExitCode::from(2);
        }
        if outcome.shutdown {
            return ExitCode::SUCCESS;
        }
    }
    ExitCode::SUCCESS
}

fn emit(out: &mut impl Write, frame: &str) -> io::Result<()> {
    out.write_all(frame.as_bytes())?;
    out.write_all(b"\n")?;
    out.flush()
}
