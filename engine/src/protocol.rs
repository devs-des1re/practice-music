use serde::Deserialize;
use serde_json::{Value, json};

use crate::devices;

pub const PROTOCOL_VERSION: u32 = 1;

pub const ENGINE_NAME: &str = "pm-engine";

pub const ENGINE_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Deserialize)]
pub struct Request {
    pub v: u32,
    pub id: u64,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, PartialEq)]
pub struct ProtoError {
    pub code: &'static str,
    pub message: String,
}

impl ProtoError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Debug, PartialEq)]
pub struct Outcome {
    pub frame: String,
    pub shutdown: bool,
}

#[derive(Default)]
pub struct Session {
    pub greeted: bool,
}

pub fn ok_frame(id: u64, result: Value) -> String {
    json!({ "v": PROTOCOL_VERSION, "id": id, "ok": true, "result": result }).to_string()
}

pub fn err_frame(id: u64, error: &ProtoError) -> String {
    json!({
        "v": PROTOCOL_VERSION,
        "id": id,
        "ok": false,
        "error": { "code": error.code, "message": error.message },
    })
    .to_string()
}

pub fn event_frame(name: &str, data: Value) -> String {
    json!({ "v": PROTOCOL_VERSION, "event": name, "data": data }).to_string()
}

pub fn handle_line(session: &mut Session, line: &str) -> Option<Outcome> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let request: Request = match serde_json::from_str(line) {
        Ok(request) => request,
        Err(error) => {
            let id = serde_json::from_str::<Value>(line)
                .ok()
                .and_then(|value| value.get("id").and_then(Value::as_u64))
                .unwrap_or(0);
            return Some(Outcome {
                frame: err_frame(id, &ProtoError::new("bad_request", error.to_string())),
                shutdown: false,
            });
        }
    };
    if request.v != PROTOCOL_VERSION {
        return Some(Outcome {
            frame: err_frame(
                request.id,
                &ProtoError::new(
                    "unsupported_version",
                    format!(
                        "engine speaks protocol {PROTOCOL_VERSION}, request used {}",
                        request.v
                    ),
                ),
            ),
            shutdown: false,
        });
    }
    let shutdown = request.method == "shutdown";
    let frame = match dispatch(session, &request) {
        Ok(result) => ok_frame(request.id, result),
        Err(error) => err_frame(request.id, &error),
    };
    Some(Outcome { frame, shutdown })
}

fn dispatch(session: &mut Session, request: &Request) -> Result<Value, ProtoError> {
    match request.method.as_str() {
        "hello" => {
            if let Some(wanted) = request.params.get("protocol").and_then(Value::as_u64)
                && wanted != u64::from(PROTOCOL_VERSION)
            {
                return Err(ProtoError::new(
                    "unsupported_version",
                    format!("host wants protocol {wanted}, engine speaks {PROTOCOL_VERSION}"),
                ));
            }
            session.greeted = true;
            Ok(json!({
                "protocol": PROTOCOL_VERSION,
                "engine": ENGINE_NAME,
                "version": ENGINE_VERSION,
                "os": std::env::consts::OS,
                "arch": std::env::consts::ARCH,
                "pid": std::process::id(),
                "features": features(),
            }))
        }
        "ping" => Ok(json!({ "pong": true })),
        "list_devices" => require_greeted(session).and_then(|_| devices::list()),
        "shutdown" => Ok(json!({ "bye": true })),
        other => Err(ProtoError::new(
            "unknown_method",
            format!("unknown method {other}"),
        )),
    }
}

fn require_greeted(session: &Session) -> Result<(), ProtoError> {
    if session.greeted {
        Ok(())
    } else {
        Err(ProtoError::new(
            "not_greeted",
            "send hello before any other request",
        ))
    }
}

fn features() -> Vec<&'static str> {
    let mut list = Vec::new();
    if cfg!(feature = "asio") {
        list.push("asio");
    }
    if cfg!(feature = "jack") {
        list.push("jack");
    }
    list
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(session: &mut Session, line: &str) -> Value {
        let outcome = handle_line(session, line).expect("frame expected");
        serde_json::from_str(&outcome.frame).expect("valid json frame")
    }

    #[test]
    fn hello_reports_protocol_and_version() {
        let mut session = Session::default();
        let reply = run(
            &mut session,
            r#"{"v":1,"id":7,"method":"hello","params":{"protocol":1}}"#,
        );
        assert_eq!(reply["id"], 7);
        assert_eq!(reply["ok"], true);
        assert_eq!(reply["result"]["protocol"], PROTOCOL_VERSION);
        assert_eq!(reply["result"]["engine"], ENGINE_NAME);
        assert!(session.greeted);
    }

    #[test]
    fn hello_rejects_a_host_that_wants_another_protocol() {
        let mut session = Session::default();
        let reply = run(
            &mut session,
            r#"{"v":1,"id":8,"method":"hello","params":{"protocol":2}}"#,
        );
        assert_eq!(reply["error"]["code"], "unsupported_version");
        assert!(!session.greeted);
    }

    #[test]
    fn devices_require_hello() {
        let mut session = Session::default();
        let reply = run(&mut session, r#"{"v":1,"id":2,"method":"list_devices"}"#);
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["error"]["code"], "not_greeted");
    }

    #[test]
    fn wrong_version_is_rejected_with_its_id() {
        let mut session = Session::default();
        let reply = run(&mut session, r#"{"v":9,"id":3,"method":"hello"}"#);
        assert_eq!(reply["id"], 3);
        assert_eq!(reply["error"]["code"], "unsupported_version");
    }

    #[test]
    fn unknown_method_is_an_error_not_a_crash() {
        let mut session = Session::default();
        let reply = run(&mut session, r#"{"v":1,"id":4,"method":"nope"}"#);
        assert_eq!(reply["error"]["code"], "unknown_method");
    }

    #[test]
    fn malformed_json_keeps_the_session_alive() {
        let mut session = Session::default();
        let reply = run(&mut session, "{not json");
        assert_eq!(reply["error"]["code"], "bad_request");
        let reply = run(&mut session, r#"{"v":1,"id":5,"method":"ping"}"#);
        assert_eq!(reply["ok"], true);
    }

    #[test]
    fn missing_fields_report_the_id_when_present() {
        let mut session = Session::default();
        let reply = run(&mut session, r#"{"v":1,"id":11}"#);
        assert_eq!(reply["id"], 11);
        assert_eq!(reply["error"]["code"], "bad_request");
    }

    #[test]
    fn shutdown_sets_the_flag() {
        let mut session = Session::default();
        let outcome = handle_line(&mut session, r#"{"v":1,"id":6,"method":"shutdown"}"#).unwrap();
        assert!(outcome.shutdown);
    }

    #[test]
    fn blank_lines_are_ignored() {
        let mut session = Session::default();
        assert!(handle_line(&mut session, "   ").is_none());
    }

    #[test]
    fn event_frames_have_no_id() {
        let frame: Value = serde_json::from_str(&event_frame("ready", json!({}))).unwrap();
        assert_eq!(frame["event"], "ready");
        assert!(frame.get("id").is_none());
    }
}
