use std::sync::Arc;

use serde_json::{Value, json};

use crate::drum_loader::Request;
use crate::drums::{Config, DrumCommand, MAX_PADS, Pedal};
use crate::protocol::{ProtoError, Session};

fn bad(message: impl Into<String>) -> ProtoError {
    ProtoError::new("bad_params", message)
}

fn number(value: &Value, key: &str, fallback: f64) -> f32 {
    value.get(key).and_then(Value::as_f64).unwrap_or(fallback) as f32
}

fn byte(value: &Value, key: &str, fallback: u64) -> u8 {
    value
        .get(key)
        .and_then(Value::as_u64)
        .unwrap_or(fallback)
        .min(127) as u8
}

pub fn read_config(params: &Value) -> Result<Config, ProtoError> {
    let mut config = Config {
        enabled: params
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        curve: number(params, "curve", 1.0),
        threshold: byte(params, "threshold", 1).max(1),
        ..Config::default()
    };
    let pads = params
        .get("pads")
        .and_then(Value::as_array)
        .ok_or_else(|| bad("pads must be a list"))?;
    if pads.len() > MAX_PADS {
        return Err(bad(format!("at most {MAX_PADS} pads are supported")));
    }
    for (index, pad) in pads.iter().enumerate() {
        let slot = &mut config.pads[index];
        slot.gain_db = number(pad, "gainDb", 0.0).clamp(-24.0, 12.0);
        slot.pan = number(pad, "pan", 0.0).clamp(-1.0, 1.0);
        slot.tune = number(pad, "tune", 0.0).clamp(-12.0, 12.0);
        slot.choke = byte(pad, "choke", 0).min(8);
        slot.sensitivity = number(pad, "sensitivity", 1.0).clamp(0.25, 4.0);
        for note in pad
            .get("notes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            match note.as_u64() {
                Some(n) if n < 128 => config.assign(n as u8, index),
                _ => return Err(bad("notes must be whole numbers from 0 to 127")),
            }
        }
    }
    if let Some(pedal) = params.get("pedal").filter(|p| !p.is_null()) {
        config.pedal = Some(Pedal {
            threshold: byte(pedal, "threshold", 80),
            reversed: pedal
                .get("reversed")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            open_pad: byte(pedal, "openPad", 0),
            closed_pad: byte(pedal, "closedPad", 0),
        });
    }
    Ok(config)
}

pub fn configure(session: &Session, params: &Value) -> Result<Value, ProtoError> {
    session.drums.set_config(Arc::new(read_config(params)?));
    Ok(json!({ "ok": true }))
}

pub fn load(session: &Session, params: &Value) -> Result<Value, ProtoError> {
    let rate = session.drums.rate().ok_or_else(|| {
        ProtoError::new("audio_not_started", "start audio before loading a drum kit")
    })?;
    let events = session
        .events
        .clone()
        .ok_or_else(|| ProtoError::new("audio_unavailable", "this session has no event channel"))?;
    let token = params.get("token").and_then(Value::as_u64).unwrap_or(0);
    let request: Request =
        serde_json::from_value(params.clone()).map_err(|e| bad(e.to_string()))?;
    session
        .loader
        .start(request, rate, token, Arc::clone(&session.drums), events);
    Ok(json!({ "accepted": true, "rate": rate }))
}

pub fn trigger(session: &Session, params: &Value) -> Result<Value, ProtoError> {
    let pad = params
        .get("pad")
        .and_then(Value::as_u64)
        .ok_or_else(|| bad("pad is required"))? as usize;
    if pad >= MAX_PADS {
        return Err(bad("that pad does not exist"));
    }
    if !session.drums.send(DrumCommand::Trigger {
        pad,
        velocity: byte(params, "velocity", 100).max(1),
    }) {
        return Err(ProtoError::new(
            "audio_not_started",
            "start audio before playing a pad",
        ));
    }
    Ok(json!({ "ok": true }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_map_notes_to_pads_and_are_limited() {
        let config = read_config(&json!({
            "enabled": true,
            "curve": 0.6,
            "threshold": 10,
            "pads": [
                { "notes": [36, 35], "gainDb": 40, "pan": -3 },
                { "notes": [38], "tune": 2, "choke": 99, "sensitivity": 9 }
            ],
            "pedal": { "threshold": 90, "openPad": 1, "closedPad": 0 }
        }))
        .unwrap();
        assert_eq!(config.pad_for(36), Some(0));
        assert_eq!(config.pad_for(35), Some(0));
        assert_eq!(config.pad_for(38), Some(1));
        assert_eq!(config.pad_for(40), None);
        assert_eq!(config.pads[0].gain_db, 12.0);
        assert_eq!(config.pads[0].pan, -1.0);
        assert_eq!(config.pads[0].sensitivity, 1.0);
        assert_eq!(config.pads[1].choke, 8);
        assert_eq!(config.pads[1].sensitivity, 4.0);
        assert_eq!(config.pedal.unwrap().threshold, 90);
    }

    #[test]
    fn bad_settings_are_refused() {
        assert!(read_config(&json!({})).is_err());
        assert!(read_config(&json!({ "pads": [{ "notes": [200] }] })).is_err());
        let many: Vec<Value> = (0..40).map(|_| json!({})).collect();
        assert!(read_config(&json!({ "pads": many })).is_err());
    }
}
