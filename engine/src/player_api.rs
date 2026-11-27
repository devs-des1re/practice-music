use std::sync::Arc;

use serde_json::{Value, json};

use crate::decode;
use crate::guide::Grid;
use crate::player::Command;
use crate::protocol::{ProtoError, Session};
use crate::tempo;

pub struct Loaded {
    pub path: String,
    pub track: Arc<Vec<f32>>,
    pub rate: u32,
}

fn not_started() -> ProtoError {
    ProtoError::new("audio_not_started", "start audio before using the player")
}

fn no_track() -> ProtoError {
    ProtoError::new("no_track", "load a song first")
}

fn ms_to_frames(ms: f64, rate: u32) -> usize {
    (ms.max(0.0) * f64::from(rate) / 1000.0).round() as usize
}

pub fn load(session: &mut Session, params: &Value) -> Result<Value, ProtoError> {
    let handle = session.audio.as_ref().ok_or_else(not_started)?;
    let tx = handle.shared.player_tx.clone();
    let rate = handle.shared.rate;
    let path = params
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if path.is_empty() {
        return Err(ProtoError::new("bad_params", "path is required"));
    }
    let native = decode::decode_file(&path).map_err(|m| ProtoError::new("decode_error", m))?;
    let track = decode::resample(&native, rate);
    let peaks = decode::peaks(&track.frames, 2400);
    let frames = track.len_frames();
    let arc = Arc::new(track.frames);
    tx.send(Command::Load(Arc::clone(&arc)))
        .map_err(|_| not_started())?;
    session.loaded = Some(Loaded {
        path: path.clone(),
        track: arc,
        rate,
    });
    Ok(json!({
        "path": path,
        "rate": rate,
        "frames": frames,
        "durationMs": frames as f64 * 1000.0 / f64::from(rate),
        "peaks": peaks,
    }))
}

pub fn analyze(session: &Session) -> Result<Value, ProtoError> {
    let loaded = session.loaded.as_ref().ok_or_else(no_track)?;
    match tempo::detect(&loaded.track, loaded.rate) {
        Some(grid) => Ok(json!({
            "found": true,
            "bpm": grid.bpm,
            "offsetMs": grid.offset_ms,
            "beatsPerBar": grid.beats_per_bar,
            "downbeat": grid.downbeat,
            "confidence": grid.confidence,
        })),
        None => Ok(json!({ "found": false })),
    }
}

pub fn control(session: &Session, params: &Value) -> Result<Value, ProtoError> {
    let handle = session.audio.as_ref().ok_or_else(not_started)?;
    let tx = &handle.shared.player_tx;
    let rate = handle.shared.rate;
    let send = |c: Command| tx.send(c).map_err(|_| not_started());
    if let Some(v) = params.get("speed").and_then(Value::as_f64) {
        send(Command::Speed(v))?;
    }
    if let Some(v) = params.get("pitch").and_then(Value::as_f64) {
        send(Command::Pitch(v))?;
    }
    if let Some(v) = params.get("volume").and_then(Value::as_f64) {
        send(Command::Volume(v as f32))?;
    }
    if let Some(l) = params.get("loop") {
        let start = ms_to_frames(
            l.get("startMs").and_then(Value::as_f64).unwrap_or(0.0),
            rate,
        );
        let end = ms_to_frames(l.get("endMs").and_then(Value::as_f64).unwrap_or(0.0), rate);
        let enabled = l.get("enabled").and_then(Value::as_bool).unwrap_or(false);
        send(Command::Loop {
            start,
            end,
            enabled,
        })?;
    }
    if let Some(c) = params.get("countIn") {
        let beats = c.get("beats").and_then(Value::as_u64).unwrap_or(0) as u32;
        let spacing = ms_to_frames(
            c.get("spacingMs").and_then(Value::as_f64).unwrap_or(0.0),
            rate,
        );
        send(Command::CountIn { beats, spacing })?;
    }
    if let Some(g) = params.get("guide") {
        let number = |key: &str| g.get(key).and_then(Value::as_f64).unwrap_or(0.0);
        let bpm = number("bpm");
        let enabled = g.get("enabled").and_then(Value::as_bool).unwrap_or(false) && bpm > 0.0;
        send(Command::Guide(enabled.then(|| Grid {
            frames_per_beat: f64::from(rate) * 60.0 / bpm,
            offset: number("offsetMs") * f64::from(rate) / 1000.0,
            beats_per_bar: number("beatsPerBar").clamp(1.0, 32.0) as u32,
            downbeat: number("downbeat") as i64,
        })))?;
    }
    if let Some(ms) = params.get("seekMs").and_then(Value::as_f64) {
        send(Command::Seek(ms_to_frames(ms, rate)))?;
    }
    match params.get("action").and_then(Value::as_str) {
        Some("play") => send(Command::Play)?,
        Some("pause") => send(Command::Pause)?,
        Some(other) => {
            return Err(ProtoError::new(
                "bad_params",
                format!("unknown action {other}"),
            ));
        }
        None => {}
    }
    Ok(json!({ "ok": true }))
}

pub fn status(session: &Session) -> Value {
    match &session.audio {
        Some(handle) => {
            let (pos, playing, loops) = handle.shared.player_state();
            let rate = f64::from(handle.shared.rate);
            json!({
                "loaded": session.loaded.as_ref().map(|l| l.path.clone()),
                "positionMs": pos * 1000.0 / rate,
                "playing": playing,
                "loops": loops,
            })
        }
        None => json!({ "loaded": null, "positionMs": 0.0, "playing": false, "loops": 0 }),
    }
}
