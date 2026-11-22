use serde_json::{Map, Value, json};

use crate::mixer::{INPUT_STRIPS, ParamTable, STRIP_INPUT0, STRIPS, mp, sp};
use crate::protocol::ProtoError;

enum Target {
    Strip(usize, usize),
    Master(usize),
}

fn bad(message: impl Into<String>) -> ProtoError {
    ProtoError::new("bad_params", message)
}

fn read_number(obj: &Map<String, Value>, key: &str, min: f64, max: f64) -> Result<Option<f32>, ProtoError> {
    match obj.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => {
            let n = v.as_f64().ok_or_else(|| bad(format!("{key} must be a number")))?;
            if !(min..=max).contains(&n) || !n.is_finite() {
                return Err(bad(format!("{key} must be between {min} and {max}")));
            }
            Ok(Some(n as f32))
        }
    }
}

fn read_flag(obj: &Map<String, Value>, key: &str) -> Result<Option<f32>, ProtoError> {
    match obj.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(b)) => Ok(Some(if *b { 1.0 } else { 0.0 })),
        Some(_) => Err(bad(format!("{key} must be true or false"))),
    }
}

struct Collector {
    writes: Vec<(Target, f32)>,
}

impl Collector {
    fn strip_number(&mut self, strip: usize, obj: &Map<String, Value>, key: &str, param: usize, min: f64, max: f64) -> Result<(), ProtoError> {
        if let Some(v) = read_number(obj, key, min, max)? {
            self.writes.push((Target::Strip(strip, param), v));
        }
        Ok(())
    }

    fn strip_flag(&mut self, strip: usize, obj: &Map<String, Value>, key: &str, param: usize) -> Result<(), ProtoError> {
        if let Some(v) = read_flag(obj, key)? {
            self.writes.push((Target::Strip(strip, param), v));
        }
        Ok(())
    }

    fn master_number(&mut self, obj: &Map<String, Value>, key: &str, param: usize, min: f64, max: f64) -> Result<(), ProtoError> {
        if let Some(v) = read_number(obj, key, min, max)? {
            self.writes.push((Target::Master(param), v));
        }
        Ok(())
    }
}

fn collect_strip(c: &mut Collector, index: usize, obj: &Map<String, Value>) -> Result<(), ProtoError> {
    c.strip_number(index, obj, "gain", sp::GAIN, -60.0, 12.0)?;
    c.strip_number(index, obj, "pan", sp::PAN, -1.0, 1.0)?;
    c.strip_flag(index, obj, "mute", sp::MUTE)?;
    c.strip_flag(index, obj, "solo", sp::SOLO)?;
    c.strip_number(index, obj, "main", sp::MAIN, -60.0, 12.0)?;
    c.strip_number(index, obj, "monitor", sp::MONITOR, -60.0, 12.0)?;
    if let Some(Value::Object(eq)) = obj.get("eq") {
        c.strip_number(index, eq, "low", sp::EQ_LOW, -15.0, 15.0)?;
        c.strip_number(index, eq, "mid", sp::EQ_MID, -15.0, 15.0)?;
        c.strip_number(index, eq, "high", sp::EQ_HIGH, -15.0, 15.0)?;
    }
    if let Some(Value::Object(comp)) = obj.get("comp") {
        c.strip_flag(index, comp, "on", sp::COMP_ON)?;
        c.strip_number(index, comp, "threshold", sp::COMP_THRESHOLD, -60.0, 0.0)?;
        c.strip_number(index, comp, "ratio", sp::COMP_RATIO, 1.0, 20.0)?;
        c.strip_number(index, comp, "attack", sp::COMP_ATTACK, 0.1, 200.0)?;
        c.strip_number(index, comp, "release", sp::COMP_RELEASE, 5.0, 2000.0)?;
        c.strip_number(index, comp, "makeup", sp::COMP_MAKEUP, 0.0, 24.0)?;
    }
    if index >= STRIP_INPUT0 {
        c.strip_number(index, obj, "source", sp::SOURCE, 0.0, 15.0)?;
        c.strip_flag(index, obj, "stereo", sp::STEREO)?;
    }
    Ok(())
}

pub fn apply(table: &ParamTable, params: &Value) -> Result<(), ProtoError> {
    let mut c = Collector { writes: Vec::new() };
    match params.get("strips") {
        None | Some(Value::Null) => {}
        Some(Value::Array(items)) => {
            for (position, item) in items.iter().enumerate() {
                let obj = item.as_object().ok_or_else(|| bad("each strip must be an object"))?;
                let index = match obj.get("index") {
                    None | Some(Value::Null) => position,
                    Some(v) => v.as_u64().ok_or_else(|| bad("index must be a whole number"))? as usize,
                };
                if index >= STRIPS {
                    return Err(bad(format!("strip {index} does not exist")));
                }
                collect_strip(&mut c, index, obj)?;
            }
        }
        Some(_) => return Err(bad("strips must be a list")),
    }
    match params.get("master") {
        None | Some(Value::Null) => {}
        Some(Value::Object(m)) => {
            c.master_number(m, "main", mp::MAIN_GAIN, -60.0, 12.0)?;
            c.master_number(m, "monitor", mp::MONITOR_GAIN, -60.0, 12.0)?;
            if let Some(v) = read_flag(m, "limiter")? {
                c.writes.push((Target::Master(mp::LIMITER_ON), v));
            }
            c.master_number(m, "ceiling", mp::CEILING, -12.0, 0.0)?;
            c.master_number(m, "mainChannel", mp::MAIN_CHANNEL, 0.0, 62.0)?;
            c.master_number(m, "monitorChannel", mp::MONITOR_CHANNEL, 0.0, 62.0)?;
        }
        Some(_) => return Err(bad("master must be an object")),
    }
    for (target, value) in c.writes {
        match target {
            Target::Strip(strip, param) => table.set(strip, param, value),
            Target::Master(param) => table.set_master(param, value),
        }
    }
    Ok(())
}

fn round2(v: f32) -> f64 {
    (f64::from(v) * 100.0).round() / 100.0
}

pub fn state(table: &ParamTable) -> Value {
    let strips: Vec<Value> = (0..STRIPS)
        .map(|s| {
            let mut strip = json!({
                "index": s,
                "gain": round2(table.get(s, sp::GAIN)),
                "pan": round2(table.get(s, sp::PAN)),
                "mute": table.flag(s, sp::MUTE),
                "solo": table.flag(s, sp::SOLO),
                "main": round2(table.get(s, sp::MAIN)),
                "monitor": round2(table.get(s, sp::MONITOR)),
                "eq": {
                    "low": round2(table.get(s, sp::EQ_LOW)),
                    "mid": round2(table.get(s, sp::EQ_MID)),
                    "high": round2(table.get(s, sp::EQ_HIGH)),
                },
                "comp": {
                    "on": table.flag(s, sp::COMP_ON),
                    "threshold": round2(table.get(s, sp::COMP_THRESHOLD)),
                    "ratio": round2(table.get(s, sp::COMP_RATIO)),
                    "attack": round2(table.get(s, sp::COMP_ATTACK)),
                    "release": round2(table.get(s, sp::COMP_RELEASE)),
                    "makeup": round2(table.get(s, sp::COMP_MAKEUP)),
                },
            });
            if s >= STRIP_INPUT0 {
                strip["source"] = json!(table.get(s, sp::SOURCE) as u32);
                strip["stereo"] = json!(table.flag(s, sp::STEREO));
            }
            strip
        })
        .collect();
    json!({
        "strips": strips,
        "master": {
            "main": round2(table.master(mp::MAIN_GAIN)),
            "monitor": round2(table.master(mp::MONITOR_GAIN)),
            "limiter": table.flag_master(mp::LIMITER_ON),
            "ceiling": round2(table.master(mp::CEILING)),
            "mainChannel": table.master(mp::MAIN_CHANNEL) as u32,
            "monitorChannel": table.master(mp::MONITOR_CHANNEL) as u32,
        },
        "inputStrips": INPUT_STRIPS,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mixer::{STRIP_CLICK, STRIP_SONG};

    #[test]
    fn the_default_state_describes_every_strip() {
        let table = ParamTable::new();
        let v = state(&table);
        assert_eq!(v["strips"].as_array().unwrap().len(), STRIPS);
        assert_eq!(v["strips"][0]["main"], 0.0);
        assert_eq!(v["strips"][0]["monitor"], -60.0);
        assert_eq!(v["strips"][2]["source"], 0);
        assert_eq!(v["strips"][5]["source"], 3);
        assert!(v["strips"][0].get("source").is_none());
        assert_eq!(v["master"]["limiter"], true);
    }

    #[test]
    fn a_state_round_trips_through_apply() {
        let table = ParamTable::new();
        apply(
            &table,
            &json!({
                "strips": [
                    { "gain": -4.5, "pan": 0.25, "mute": true, "eq": { "low": 3.0, "high": -2.0 }, "comp": { "on": true, "ratio": 4.0 } },
                    { "monitor": -3.0, "main": -60.0, "solo": true },
                ],
                "master": { "main": -2.0, "ceiling": -1.0, "mainChannel": 2, "limiter": false },
            }),
        )
        .unwrap();
        let first = state(&table);
        let again = ParamTable::new();
        apply(&again, &first).unwrap();
        assert_eq!(state(&again), first);
        assert_eq!(first["strips"][0]["gain"], -4.5);
        assert_eq!(first["strips"][0]["mute"], true);
        assert_eq!(first["strips"][0]["comp"]["on"], true);
        assert_eq!(first["strips"][1]["solo"], true);
        assert_eq!(first["master"]["mainChannel"], 2);
        assert_eq!(first["master"]["limiter"], false);
    }

    #[test]
    fn strips_can_be_addressed_by_index() {
        let table = ParamTable::new();
        apply(&table, &json!({ "strips": [{ "index": 3, "gain": -9.0, "source": 7, "stereo": true }] })).unwrap();
        assert_eq!(table.get(3, sp::GAIN), -9.0);
        assert_eq!(table.get(3, sp::SOURCE), 7.0);
        assert!(table.flag(3, sp::STEREO));
        assert_eq!(table.get(STRIP_SONG, sp::GAIN), 0.0);
        assert_eq!(table.get(STRIP_CLICK, sp::GAIN), 0.0);
    }

    #[test]
    fn source_and_stereo_only_apply_to_input_strips() {
        let table = ParamTable::new();
        apply(&table, &json!({ "strips": [{ "source": 9, "stereo": true }] })).unwrap();
        assert_eq!(table.get(STRIP_SONG, sp::SOURCE), 0.0);
        assert!(!table.flag(STRIP_SONG, sp::STEREO));
    }

    #[test]
    fn nothing_is_applied_when_any_value_is_invalid() {
        let table = ParamTable::new();
        let err = apply(
            &table,
            &json!({ "strips": [{ "gain": -3.0 }, { "pan": 4.0 }], "master": { "main": -6.0 } }),
        )
        .unwrap_err();
        assert_eq!(err.code, "bad_params");
        assert_eq!(table.get(0, sp::GAIN), 0.0);
        assert_eq!(table.master(mp::MAIN_GAIN), 0.0);
    }

    #[test]
    fn bad_shapes_are_rejected() {
        let table = ParamTable::new();
        for body in [
            json!({ "strips": 3 }),
            json!({ "strips": [3] }),
            json!({ "strips": [{ "index": 9 }] }),
            json!({ "strips": [{ "gain": "loud" }] }),
            json!({ "strips": [{ "mute": 1 }] }),
            json!({ "strips": [{ "comp": { "ratio": 0.5 } }] }),
            json!({ "strips": [{ "eq": { "low": 40.0 } }] }),
            json!({ "master": "big" }),
            json!({ "master": { "ceiling": 3.0 } }),
        ] {
            assert!(apply(&table, &body).is_err(), "{body}");
        }
    }

    #[test]
    fn an_empty_request_is_fine() {
        let table = ParamTable::new();
        assert!(apply(&table, &json!({})).is_ok());
    }
}
