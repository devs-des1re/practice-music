mod audio;
mod click;
mod decode;
mod devices;
mod drum_api;
mod drums;
mod dsp;
mod fx;
mod guide;
mod loopback;
mod metronome_api;
mod midi;
mod midi_api;
mod mixer;
mod mixer_api;
mod player;
mod player_api;
mod protocol;
mod ring;
mod routing;
mod sounds;
mod stretch;
mod tempo;
#[cfg(windows)]
mod wasapi_backend;

use std::io::{self, BufRead, Write};
use std::process::ExitCode;
use std::sync::mpsc;
use std::thread;

use protocol::{Session, event_frame, handle_line};
use serde_json::json;

fn main() -> ExitCode {
    let (tx, rx) = mpsc::channel::<String>();
    let writer = thread::spawn(move || {
        let stdout = io::stdout();
        let mut out = stdout.lock();
        for frame in rx {
            if out.write_all(frame.as_bytes()).is_err()
                || out.write_all(b"\n").is_err()
                || out.flush().is_err()
            {
                return;
            }
        }
    });

    let mut session = Session::with_events(tx.clone());
    let _ = tx.send(event_frame(
        "ready",
        json!({
            "engine": protocol::ENGINE_NAME,
            "version": protocol::ENGINE_VERSION,
            "protocol": protocol::PROTOCOL_VERSION,
        }),
    ));

    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let recv_us = audio::now_us();
        let Ok(line) = line else { break };
        let Some(outcome) = handle_line(&mut session, &line, recv_us) else {
            continue;
        };
        if tx.send(outcome.frame).is_err() {
            break;
        }
        if outcome.shutdown {
            break;
        }
    }
    drop(session);
    drop(tx);
    let _ = writer.join();
    ExitCode::SUCCESS
}
