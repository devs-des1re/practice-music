use std::sync::Arc;

use serde_json::{Value, json};

use crate::midi;
use crate::protocol::{ProtoError, Session};

pub fn ports(session: &Session) -> Result<Value, ProtoError> {
    let ports = midi::list_ports().map_err(|m| ProtoError::new("midi_error", m))?;
    let open = session
        .midi
        .as_ref()
        .map(|link| link.name.clone())
        .unwrap_or_default();
    Ok(json!({ "ports": ports, "open": open }))
}

pub fn open(session: &mut Session, params: &Value) -> Result<Value, ProtoError> {
    let name = params
        .get("port")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    session.midi = None;
    if name.is_empty() {
        return Ok(json!({ "open": "" }));
    }
    let events = session
        .events
        .clone()
        .ok_or_else(|| ProtoError::new("midi_error", "this session has no event channel"))?;
    let link = midi::open(&name, Arc::clone(&session.drums), events)
        .map_err(|m| ProtoError::new("midi_error", m))?;
    session.midi = Some(link);
    Ok(json!({ "open": name }))
}
