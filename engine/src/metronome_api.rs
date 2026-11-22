use std::sync::Arc;

use serde_json::{Value, json};

use crate::audio::Shared;
use crate::click::{
    Controls, MAX_BAR_COUNT, MAX_BEATS, MAX_BPM, MAX_POLY, MAX_SUBDIVISION, MIN_BPM, pack_accents,
    unpack_accents,
};
use crate::decode;
use crate::protocol::ProtoError;
use crate::sounds::{self, PRESETS, ROLES};

pub fn state(c: &Controls) -> Value {
    let (play, silent) = c.silence();
    json!({
        "running": c.running(),
        "bpm": c.bpm(),
        "volume": c.volume(),
        "beatsPerBar": c.beats_per_bar(),
        "subdivision": c.subdivision(),
        "subLevel": c.sub_level(),
        "accents": unpack_accents(c.accents(), c.beats_per_bar()),
        "polyBeats": c.poly(),
        "polyLevel": c.poly_level(),
        "playBars": play,
        "silentBars": silent,
    })
}

fn bad(message: impl Into<String>) -> ProtoError {
    ProtoError::new("bad_params", message)
}

fn number(params: &Value, key: &str, min: f64, max: f64) -> Result<Option<f64>, ProtoError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => {
            let n = v.as_f64().ok_or_else(|| bad(format!("{key} must be a number")))?;
            if !(min..=max).contains(&n) {
                return Err(bad(format!("{key} must be between {min} and {max}")));
            }
            Ok(Some(n))
        }
    }
}

struct Parsed {
    bpm: Option<f64>,
    volume: Option<f64>,
    beats: Option<u32>,
    subdivision: Option<u32>,
    sub_level: Option<f64>,
    accents: Option<Vec<u8>>,
    poly: Option<u32>,
    poly_level: Option<f64>,
    play_bars: Option<u32>,
    silent_bars: Option<u32>,
    running: Option<bool>,
    sound: Option<String>,
}

fn parse(params: &Value) -> Result<Parsed, ProtoError> {
    let accents = match params.get("accents") {
        None | Some(Value::Null) => None,
        Some(Value::Array(items)) => {
            if items.len() > MAX_BEATS as usize {
                return Err(bad(format!("accents can have at most {MAX_BEATS} entries")));
            }
            let mut levels = Vec::with_capacity(items.len());
            for item in items {
                let level = item
                    .as_u64()
                    .filter(|l| *l <= 3)
                    .ok_or_else(|| bad("accent levels must be 0, 1, 2 or 3"))?;
                levels.push(level as u8);
            }
            Some(levels)
        }
        Some(_) => return Err(bad("accents must be a list")),
    };
    let sound = match params.get("sound") {
        None | Some(Value::Null) => None,
        Some(Value::String(name)) => {
            if !PRESETS.contains(&name.as_str()) {
                return Err(bad(format!("unknown click sound {name}")));
            }
            Some(name.clone())
        }
        Some(_) => return Err(bad("sound must be a name")),
    };
    Ok(Parsed {
        bpm: number(params, "bpm", MIN_BPM, MAX_BPM)?,
        volume: number(params, "volume", 0.0, 1.0)?,
        beats: number(params, "beatsPerBar", 1.0, f64::from(MAX_BEATS))?.map(|n| n as u32),
        subdivision: number(params, "subdivision", 1.0, f64::from(MAX_SUBDIVISION))?.map(|n| n as u32),
        sub_level: number(params, "subLevel", 0.0, 1.5)?,
        accents,
        poly: number(params, "polyBeats", 0.0, f64::from(MAX_POLY))?.map(|n| n as u32),
        poly_level: number(params, "polyLevel", 0.0, 1.5)?,
        play_bars: number(params, "playBars", 1.0, f64::from(MAX_BAR_COUNT))?.map(|n| n as u32),
        silent_bars: number(params, "silentBars", 0.0, f64::from(MAX_BAR_COUNT))?.map(|n| n as u32),
        running: match params.get("running") {
            None | Some(Value::Null) => None,
            Some(v) => Some(v.as_bool().ok_or_else(|| bad("running must be true or false"))?),
        },
        sound,
    })
}

pub fn set(shared: &Shared, params: &Value) -> Result<Value, ProtoError> {
    let p = parse(params)?;
    let c = &shared.controls;
    if let Some(v) = p.bpm {
        c.set_bpm(v);
    }
    if let Some(v) = p.volume {
        c.set_volume(v as f32);
    }
    if let Some(v) = p.beats {
        c.set_beats_per_bar(v);
    }
    if let Some(v) = p.subdivision {
        c.set_subdivision(v);
    }
    if let Some(v) = p.sub_level {
        c.set_sub_level(v as f32);
    }
    if let Some(levels) = &p.accents {
        c.set_accents(pack_accents(levels));
    }
    if let Some(v) = p.poly {
        c.set_poly(v);
    }
    if let Some(v) = p.poly_level {
        c.set_poly_level(v as f32);
    }
    if p.play_bars.is_some() || p.silent_bars.is_some() {
        let (play, silent) = c.silence();
        c.set_silence(p.play_bars.unwrap_or(play), p.silent_bars.unwrap_or(silent));
    }
    if let Some(name) = &p.sound
        && let Some(tables) = sounds::preset(name, shared.rate)
    {
        for (role, table) in tables.into_iter().enumerate() {
            shared.send_sound(role, Arc::from(table));
        }
    }
    if let Some(running) = p.running {
        c.set_running(running);
    }
    Ok(state(c))
}

pub fn load_sound(shared: &Shared, params: &Value) -> Result<Value, ProtoError> {
    let path = params
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if path.is_empty() {
        return Err(bad("path is required"));
    }
    let role_name = params.get("role").and_then(Value::as_str).unwrap_or("all");
    let roles: Vec<usize> = if role_name == "all" {
        (0..ROLES).collect()
    } else {
        vec![sounds::role_from_name(role_name).ok_or_else(|| bad(format!("unknown sound role {role_name}")))?]
    };
    let native = decode::decode_file(path).map_err(|m| ProtoError::new("decode_error", m))?;
    let track = decode::resample(&native, shared.rate);
    let table: Arc<[f32]> = Arc::from(sounds::from_interleaved(&track.frames, 2, shared.rate));
    if table.len() < 16 {
        return Err(ProtoError::new("decode_error", "the sound is too short to use as a click"));
    }
    for role in roles {
        shared.send_sound(role, Arc::clone(&table));
    }
    Ok(json!({ "path": path, "role": role_name, "frames": table.len() }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shared() -> Shared {
        Shared::new(48000).0
    }

    #[test]
    fn state_lists_every_metronome_setting() {
        let s = shared();
        let v = state(&s.controls);
        for key in [
            "running", "bpm", "volume", "beatsPerBar", "subdivision", "subLevel", "accents",
            "polyBeats", "polyLevel", "playBars", "silentBars",
        ] {
            assert!(v.get(key).is_some(), "{key}");
        }
        assert_eq!(v["accents"], json!([3, 2, 2, 2]));
    }

    #[test]
    fn set_applies_every_field() {
        let s = shared();
        let out = set(
            &s,
            &json!({
                "bpm": 93.5, "volume": 0.7, "beatsPerBar": 6, "subdivision": 3, "subLevel": 0.4,
                "accents": [3, 1, 2, 0, 2, 2], "polyBeats": 4, "polyLevel": 0.9, "playBars": 2,
                "silentBars": 1, "running": true,
            }),
        )
        .unwrap();
        assert_eq!(out["bpm"], 93.5);
        assert_eq!(out["beatsPerBar"], 6);
        assert_eq!(out["subdivision"], 3);
        assert_eq!(out["accents"], json!([3, 1, 2, 0, 2, 2]));
        assert_eq!(out["polyBeats"], 4);
        assert_eq!(out["playBars"], 2);
        assert_eq!(out["silentBars"], 1);
        assert_eq!(out["running"], true);
    }

    #[test]
    fn a_bad_value_changes_nothing() {
        let s = shared();
        let before = state(&s.controls);
        let err = set(&s, &json!({ "bpm": 100, "subdivision": 99 })).unwrap_err();
        assert_eq!(err.code, "bad_params");
        assert_eq!(state(&s.controls), before);
    }

    #[test]
    fn each_range_is_enforced() {
        let s = shared();
        for body in [
            json!({ "bpm": 5 }),
            json!({ "bpm": 500 }),
            json!({ "volume": 1.5 }),
            json!({ "beatsPerBar": 0 }),
            json!({ "beatsPerBar": 33 }),
            json!({ "subdivision": 0 }),
            json!({ "polyBeats": 40 }),
            json!({ "playBars": 0 }),
            json!({ "silentBars": 100 }),
            json!({ "accents": [4] }),
            json!({ "accents": "loud" }),
            json!({ "sound": "kazoo" }),
            json!({ "running": "yes" }),
            json!({ "bpm": "fast" }),
        ] {
            assert!(set(&s, &body).is_err(), "{body}");
        }
    }

    #[test]
    fn choosing_a_preset_sends_four_sounds_to_the_audio_thread() {
        let (s, inbox) = Shared::new(48000);
        set(&s, &json!({ "sound": "wood" })).unwrap();
        let sent: Vec<_> = inbox.sounds.try_iter().collect();
        assert_eq!(sent.len(), 4);
        assert_eq!(sent.iter().map(|c| c.role).collect::<Vec<_>>(), vec![0, 1, 2, 3]);
    }

    #[test]
    fn custom_sounds_need_a_readable_file() {
        let s = shared();
        assert!(load_sound(&s, &json!({})).is_err());
        assert!(load_sound(&s, &json!({ "path": "C:/definitely/not/here.wav" })).is_err());
        assert!(load_sound(&s, &json!({ "path": "x.wav", "role": "tuba" })).is_err());
    }

    #[test]
    fn a_wav_file_becomes_a_click_sound_for_one_role() {
        let dir = std::env::temp_dir().join(format!("pm-sound-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("knock.wav");
        let spec_rate = 48000u32;
        let frames = 4800u32;
        let mut bytes = Vec::new();
        let data_len = frames * 2;
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + data_len).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&spec_rate.to_le_bytes());
        bytes.extend_from_slice(&(spec_rate * 2).to_le_bytes());
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&data_len.to_le_bytes());
        for i in 0..frames {
            let v = ((i as f32 * 0.2).sin() * 12000.0) as i16;
            bytes.extend_from_slice(&v.to_le_bytes());
        }
        std::fs::write(&path, bytes).unwrap();
        let (s, inbox) = Shared::new(48000);
        let out = load_sound(&s, &json!({ "path": path.to_string_lossy(), "role": "accent" })).unwrap();
        assert_eq!(out["role"], "accent");
        let sent: Vec<_> = inbox.sounds.try_iter().collect();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].role, 0);
        assert!(sent[0].table.len() > 4000);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
